import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Message } from '../../../../src/shared/domainTypes'
import { estimateThinkingTokensFromMessage, estimateTokensFromImageAttachments } from '../../../../src/shared/contextUsageEstimate'
import { deserializeAttachmentsFromDb, deserializeThinkingFromDb } from '../../../../src/shared/sessionMessageMetadataCodec'
import type { ContextHistorySummaryEntry } from '../../public/model'
import type { ContextHistorySummarySourceRow } from '../../../database/operations'
import { withProjectionForegroundWorkerBudget } from './projectionForegroundWorkerBudget'
export type { ContextHistorySummarySourceRow } from '../../../database/operations'

type SummaryWorkerInput = Readonly<{ rows: readonly ContextHistorySummarySourceRow[] } | {
  dbPath: string; sessionId: string; expectedGeneration: string; expectedMessageRevision: number
}>
type SummaryWorkerRequest = SummaryWorkerInput & Readonly<{ requestId: string }>
type SummaryWorkerResponse = Readonly<{ requestId: string; entries?: readonly ContextHistorySummaryEntry[]; workerThreadId?: number;
  generation?: string; messageRevision?: number; error?: string }>

export function summarizeContextHistoryRows(rows: readonly ContextHistorySummarySourceRow[]): ContextHistorySummaryEntry[] {
  const entries: ContextHistorySummaryEntry[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || typeof row.role !== 'string') {
      throw new Error('CONTEXT_HISTORY_SUMMARY_SOURCE_INVALID')
    }
    const attachments = deserializeAttachmentsFromDb(row.attachments)
    const imageTokens = row.role === 'user' && attachments?.length
      ? estimateTokensFromImageAttachments(attachments.filter((attachment) => 'stagingKey' in attachment)) : 0
    const thinkingTokens = estimateThinkingTokensFromMessage(deserializeThinkingFromDb(row.thinking))
    if (imageTokens <= 0 && thinkingTokens <= 0) continue
    entries.push({ messageId: row.id, role: row.role as Message['role'], imageTokens, thinkingTokens, sequence: row.sequence })
  }
  return entries
}

function spawnSourceWorker(workerPath: string): Worker {
  const anchor = path.join(process.cwd(), 'package.json')
  const requireFromProject = createRequire(anchor)
  const bootstrapPath = path.join(os.tmpdir(), `sa-context-summary-${randomUUID()}.cjs`)
  requireFromProject.resolve('tsx/cjs/api')
  fs.writeFileSync(bootstrapPath, `const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const anchor = process.env.SA_CONTEXT_SUMMARY_ANCHOR
const target = process.env.SA_CONTEXT_SUMMARY_TARGET
const anchorRequire = createRequire(anchor)
anchorRequire('tsx/cjs/api').register()
anchorRequire('tsx/esm/api').tsImport(pathToFileURL(target).href, pathToFileURL(anchor).href)
  .then(() => {}, (error) => setTimeout(() => { throw error }, 0))
`)
  const worker = new Worker(bootstrapPath, { execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    env: { ...process.env, SA_CONTEXT_SUMMARY_ANCHOR: anchor, SA_CONTEXT_SUMMARY_TARGET: workerPath } })
  worker.once('exit', () => fs.rm(bootstrapPath, { force: true }, () => undefined))
  return worker
}

function workerPath(): string | undefined {
  const compiled = path.join(__dirname, 'contextHistorySummaryWorkerEntry.js')
  const source = path.join(__dirname, 'contextHistorySummaryWorkerEntry.ts')
  return fs.existsSync(compiled) ? compiled : fs.existsSync(source) ? source : undefined
}

function runSummaryWorker(request: SummaryWorkerInput): Promise<{ entries: readonly ContextHistorySummaryEntry[]; workerThreadId: number;
  generation?: string; messageRevision?: number }> {
  const target = workerPath()
  if (!target) return Promise.reject(new Error('CONTEXT_HISTORY_SUMMARY_WORKER_ENTRY_UNAVAILABLE'))
  let worker: Worker
  try {
    worker = target.endsWith('.ts') ? spawnSourceWorker(target) : new Worker(target, { execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })
  } catch (error) { return Promise.reject(new Error(`CONTEXT_HISTORY_SUMMARY_WORKER_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`)) }
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    let result: { entries: readonly ContextHistorySummaryEntry[]; workerThreadId: number; generation?: string; messageRevision?: number } | undefined
    let failure: Error | undefined
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : result ? resolve(result) : reject(new Error('CONTEXT_HISTORY_SUMMARY_WORKER_RESULT_MISSING'))
    }
    const timer = setTimeout(() => { failure = new Error('CONTEXT_HISTORY_SUMMARY_WORKER_TIMEOUT'); void worker.terminate() }, 30_000)
    worker.once('message', (response: SummaryWorkerResponse) => {
      if (response?.requestId !== requestId) { failure = new Error('CONTEXT_HISTORY_SUMMARY_WORKER_PROTOCOL_MISMATCH'); void worker.terminate(); return }
      if (response.error) { failure = new Error(response.error); void worker.terminate(); return }
      const entries = response.entries
      if (!Array.isArray(entries) || !Number.isSafeInteger(response.workerThreadId) || response.workerThreadId! <= 0 ||
        entries.some((entry) => !entry || typeof entry.messageId !== 'string' || !entry.messageId || typeof entry.role !== 'string' ||
          !Number.isSafeInteger(entry.sequence) || !Number.isSafeInteger(entry.imageTokens) || entry.imageTokens < 0 ||
          !Number.isSafeInteger(entry.thinkingTokens) || entry.thinkingTokens < 0 || (entry.imageTokens === 0 && entry.thinkingTokens === 0))) {
        failure = new Error('CONTEXT_HISTORY_SUMMARY_WORKER_RESULT_INVALID'); void worker.terminate(); return
      }
      result = { entries, workerThreadId: response.workerThreadId!,
        ...(response.generation !== undefined ? { generation: response.generation } : {}),
        ...(response.messageRevision !== undefined ? { messageRevision: response.messageRevision } : {}) }
    })
    worker.once('error', (error) => { failure = error; void worker.terminate() })
    worker.once('exit', (code) => settle(failure ?? (code === 0 ? undefined : new Error(`CONTEXT_HISTORY_SUMMARY_WORKER_EXIT:${code}`))))
    try { worker.postMessage({ requestId, ...request } satisfies SummaryWorkerRequest) }
    catch (error) { failure = error instanceof Error ? error : new Error('CONTEXT_HISTORY_SUMMARY_WORKER_POST_FAILED'); void worker.terminate() }
  })
}

export function summarizeContextHistoryRowsInWorker(rows: readonly ContextHistorySummarySourceRow[], options: Readonly<{
  signal?: AbortSignal
  onQueueWait?: (durationMs: number) => void
}> = {}): Promise<{ entries: readonly ContextHistorySummaryEntry[]; workerThreadId: number }> {
  return withProjectionForegroundWorkerBudget(() => runSummaryWorker({ rows }), options)
}

export function readContextHistorySummaryInWorker(input: Readonly<{
  dbPath: string
  sessionId: string
  expectedGeneration: string
  expectedMessageRevision: number
  signal?: AbortSignal
  onQueueWait?: (durationMs: number) => void
}>): Promise<{ entries: readonly ContextHistorySummaryEntry[]; workerThreadId: number; generation: string; messageRevision: number }> {
  return withProjectionForegroundWorkerBudget(async () => {
    const result = await runSummaryWorker({ dbPath: input.dbPath, sessionId: input.sessionId,
      expectedGeneration: input.expectedGeneration, expectedMessageRevision: input.expectedMessageRevision })
    if (result.generation !== input.expectedGeneration || result.messageRevision !== input.expectedMessageRevision) {
      throw new Error('CONTEXT_HISTORY_SUMMARY_SOURCE_CHANGED')
    }
    return result as { entries: readonly ContextHistorySummaryEntry[]; workerThreadId: number; generation: string; messageRevision: number }
  }, { ...(input.signal ? { signal: input.signal } : {}), ...(input.onQueueWait ? { onQueueWait: input.onQueueWait } : {}) })
}
