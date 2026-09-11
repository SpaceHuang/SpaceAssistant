import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { SessionUsage } from '../src/shared/sessionUsage'

export type SessionEventPayload = Record<string, unknown>
export type SessionEventType = 'turn_start' | 'turn_end' | 'step_start' | 'step_end' | 'assistant_chunk' | 'tool_call' | 'tool_result' | 'request_header' | 'request_context' | 'request_usage' | 'request_retry' | 'session_end_seed'
export type SessionEvent = { seq: number; time: number; type: SessionEventType; payload: SessionEventPayload }
export type SessionEventInput = { type: SessionEventType; payload: SessionEventPayload }
export type SessionEventSinkOptions = {
  maxBatchEvents: number
  maxBatchBytes: number
  flushIntervalMs: number
  softPendingEvents: number
  hardPendingEvents: number
  hardPendingBytes: number
}
export type SessionEventWriterOptions = Partial<SessionEventSinkOptions> & { onError?: (error: unknown) => void }
export type CommittedEvent = SessionEvent
export type FlushResult = {
  committedEvents: number
  seq: number
  pendingEvents: number
  pendingBytes: number
  failed: boolean
  lostEvents: number
  lostBytes: number
  indexStale: boolean
}
export type SessionEventSink = {
  appendCritical(input: SessionEventInput): Promise<CommittedEvent>
  appendChunk(input: SessionEventInput): void
  waitForCapacity(): Promise<void>
  flush(): Promise<FlushResult>
  close(): Promise<FlushResult>
  readonly eventsPath: string
  readonly indexPath: string
}

const DEFAULT_OPTIONS: SessionEventSinkOptions = {
  maxBatchEvents: 32,
  maxBatchBytes: 64 * 1024,
  flushIntervalMs: 20,
  softPendingEvents: 256,
  hardPendingEvents: 512,
  hardPendingBytes: 1024 * 1024
}
const EVENT_TYPES = new Set<SessionEventType>(['turn_start', 'turn_end', 'step_start', 'step_end', 'assistant_chunk', 'tool_call', 'tool_result', 'request_header', 'request_context', 'request_usage', 'request_retry', 'session_end_seed'])

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

export function parseSessionEvent(value: unknown): SessionEvent {
  if (!isObject(value)) throw new Error('Invalid session event')
  const event = value as Partial<SessionEvent>
  if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 1 || typeof event.time !== 'number' || typeof event.type !== 'string' || !EVENT_TYPES.has(event.type as SessionEventType) || !isObject(event.payload)) throw new Error('Invalid session event')
  return event as SessionEvent
}

function sessionDir(sessionId: string, createdAt: number): string {
  return path.join(sessionId + '-' + new Date(createdAt).toISOString().slice(0, 10).replace(/-/g, ''))
}

function eventInputBytes(input: SessionEventInput): number {
  return Buffer.byteLength(JSON.stringify(input), 'utf8') + 1
}

function eventPaths(workDir: string, sessionId: string, createdAt: number): { directory: string; eventsPath: string; indexPath: string } {
  const directory = path.resolve(workDir, 'sessions', sessionDir(sessionId, createdAt))
  return { directory, eventsPath: path.resolve(directory, 'events.jsonl'), indexPath: path.resolve(directory, 'events.index.json') }
}

function errorWithJsonlState(error: unknown, jsonlCommitted: boolean): Error & { jsonlCommitted?: boolean } {
  const result = (error instanceof Error ? error : new Error(String(error))) as Error & { jsonlCommitted?: boolean }
  result.jsonlCommitted = jsonlCommitted
  ;(result as Error & { code?: string }).code = jsonlCommitted ? 'EVENT_JSONL_COMMITTED' : 'EVENT_JSONL_APPEND_FAILED'
  return result
}

type PendingBatch = { inputs: SessionEventInput[]; bytes: number }
type SessionEventFailure = Error & { code?: string; eventsPath?: string; lostEvents?: number; lostBytes?: number }
const writerRegistry = new Map<string, SessionEventWriter>()
let acceptingSessionEvents = true
let sessionEventShutdownStarted = false

export type SessionEventIntegrity = 'complete' | 'recovered-tail' | 'degraded'
export type SessionEventIssue = {
  code: 'malformed-json' | 'invalid-event' | 'torn-tail'
  eventsPath: string
  line: number
  message: string
  truncated: boolean
  dataLossPossible: boolean
}
export type SessionEventReadResult = {
  events: SessionEvent[]
  issues: SessionEventIssue[]
  integrity: SessionEventIntegrity
}
export type SessionRecoveryFailure = {
  sessionName: string
  eventsPath?: string
  phase: 'read-events' | 'append-events' | 'write-index' | 'retention-delete'
  error: unknown
  jsonlCommitted: boolean
}
export type SessionRecoverySummary = {
  fixed: number
  sessions: Array<{ sessionName: string; fixed: number; integrity: SessionEventIntegrity; issues: SessionEventIssue[] }>
  failures: SessionRecoveryFailure[]
}
export type SessionRetentionSummary = { removed: number; failures: SessionRecoveryFailure[] }

/** 每个事件文件唯一的提交 owner；业务代码应通过 getSessionEventSink 获取。 */
export class SessionEventWriter implements SessionEventSink {
  readonly directory: string
  readonly eventsPath: string
  readonly indexPath: string
  private readonly options: SessionEventSinkOptions
  private readonly onError?: (error: unknown) => void
  private seq = 0
  private eventCount = 0
  private bytes = 0
  private initialized = false
  private initializing: Promise<void> | undefined
  private commitTail: Promise<void> = Promise.resolve()
  private pendingChunks: SessionEventInput[] = []
  private pendingChunkCount = 0
  private pendingChunkBytes = 0
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private failedError: Error | undefined
  private failureMessage = ''
  private lostEvents = 0
  private lostBytes = 0
  private indexStale = false
  private closing = false
  private closed = false

  constructor(workDir: string, sessionId: string, createdAt = Date.now(), options?: SessionEventWriterOptions) {
    if (!acceptingSessionEvents) throw sessionEventShutdownError()
    const paths = eventPaths(workDir, sessionId, createdAt)
    if (writerRegistry.has(paths.eventsPath)) throw new Error('an active session event sink already exists for this session')
    this.directory = paths.directory
    this.eventsPath = paths.eventsPath
    this.indexPath = paths.indexPath
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.onError = options?.onError
    writerRegistry.set(this.eventsPath, this)
  }

  appendCritical(input: SessionEventInput): Promise<CommittedEvent> {
    this.assertOpen()
    if (this.failedError) return Promise.reject(this.failedError)
    this.clearFlushTimer()
    const earlier = this.takePendingChunks()
    return this.enqueueCommit(async () => {
      const events = await this.commitQueuedBatch({ inputs: [...earlier.inputs, input], bytes: earlier.bytes }, earlier.inputs.length)
      return events[events.length - 1]!
    })
  }

  appendChunk(input: SessionEventInput): void {
    this.assertOpen()
    this.assertHealthy()
    const inputBytes = eventInputBytes(input)
    if (this.pendingChunkCount + 1 > this.options.hardPendingEvents || this.pendingChunkBytes + inputBytes > this.options.hardPendingBytes) throw new Error('session event hard pending limit exceeded')
    this.pendingChunks.push(input)
    this.pendingChunkCount += 1
    this.pendingChunkBytes += inputBytes
    if (this.pendingChunks.length >= this.options.maxBatchEvents || this.pendingChunkBytes >= this.options.maxBatchBytes) this.scheduleFlush(true)
    else this.scheduleFlush(false)
  }

  async waitForCapacity(): Promise<void> {
    this.assertOpen()
    this.assertHealthy()
    if (this.pendingChunkCount <= this.options.softPendingEvents) return
    await this.flush()
  }

  async flush(): Promise<FlushResult> {
    this.assertNotClosed()
    this.clearFlushTimer()
    const pending = this.takePendingChunks()
    if (pending.inputs.length) await this.enqueueCommit(async () => { await this.commitQueuedBatch(pending, pending.inputs.length) })
    else await this.commitTail
    this.assertHealthy()
    return this.snapshot()
  }

  async close(): Promise<FlushResult> {
    if (this.closed) {
      this.assertHealthy()
      return this.snapshot()
    }
    this.closing = true
    this.clearFlushTimer()
    try {
      return await this.flush()
    } finally {
      this.closed = true
      if (writerRegistry.get(this.eventsPath) === this) writerRegistry.delete(this.eventsPath)
    }
  }

  /** @deprecated 兼容旧调用方；新代码使用 appendCritical。 */
  append(input: SessionEventInput): Promise<SessionEvent | undefined> {
    return this.appendCritical(input).catch((error) => {
      return undefined
    })
  }

  /** @deprecated 兼容旧调用方；实现是真正的单次 batch commit。 */
  appendBatch(inputs: SessionEventInput[]): Promise<void> {
    if (!inputs.length) return Promise.resolve()
    this.assertOpen()
    this.assertHealthy()
    this.clearFlushTimer()
    const earlier = this.takePendingChunks()
    return this.enqueueCommit(async () => {
      await this.commitQueuedBatch({ inputs: [...earlier.inputs, ...inputs], bytes: earlier.bytes }, earlier.inputs.length)
    }).then(() => undefined).catch(() => undefined)
  }

  private assertNotClosed(): void {
    if (this.closed) throw new Error('session event sink is closed')
  }

  private assertOpen(): void {
    this.assertNotClosed()
    if (this.closing) throw new Error('session event sink is closing')
  }

  beginShutdown(): void {
    this.closing = true
    this.clearFlushTimer()
  }

  private assertHealthy(): void {
    if (this.failedError) throw this.failedError
  }

  private snapshot(): FlushResult {
    return {
      committedEvents: this.eventCount,
      seq: this.seq,
      pendingEvents: this.pendingChunkCount,
      pendingBytes: this.pendingChunkBytes,
      failed: Boolean(this.failedError),
      lostEvents: this.lostEvents,
      lostBytes: this.lostBytes,
      indexStale: this.indexStale
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  private scheduleFlush(immediate: boolean): void {
    if (immediate) {
      this.clearFlushTimer()
      this.enqueuePendingChunksSilently()
      return
    }
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.enqueuePendingChunksSilently()
    }, this.options.flushIntervalMs)
  }

  private enqueuePendingChunksSilently(): void {
    const pending = this.takePendingChunks()
    if (!pending.inputs.length) return
    void this.enqueueCommit(async () => { await this.commitQueuedBatch(pending, pending.inputs.length) }).catch(() => undefined)
  }

  private takePendingChunks(): PendingBatch {
    const pending = { inputs: this.pendingChunks, bytes: this.pendingChunks.reduce((total, input) => total + eventInputBytes(input), 0) }
    this.pendingChunks = []
    return pending
  }

  private enqueueCommit<T>(task: () => Promise<T>): Promise<T> {
    const run = this.commitTail.then(task)
    this.commitTail = run.then(() => undefined, (error) => { this.reportError(error) })
    return run
  }

  private async commitQueuedBatch(batch: PendingBatch, chunkCount: number): Promise<SessionEvent[]> {
    try {
      return await this.commitBatch(batch.inputs, chunkCount, batch.bytes)
    } catch (error) {
      if (!(error as { jsonlCommitted?: boolean })?.jsonlCommitted) {
        // JSONL 未提交时进入 fail-stop。失败 batch 不能回到 pendingChunks，
        // 否则同一提交链后面的 batch 会先落盘，越过 critical barrier。
        const lostInputs = [...batch.inputs, ...this.pendingChunks]
        this.lostEvents += lostInputs.length
        this.lostBytes += lostInputs.reduce((total, input) => total + eventInputBytes(input), 0)
        if (!this.failedError) {
          this.failedError = error instanceof Error ? error : new Error(String(error))
          this.failureMessage = this.failedError.message
        }
        const failure = this.failedError as SessionEventFailure
        failure.eventsPath = this.eventsPath
        failure.lostEvents = this.lostEvents
        failure.lostBytes = this.lostBytes
        failure.message = `${this.failureMessage} (eventsPath=${this.eventsPath}, lostEvents=${this.lostEvents}, lostBytes=${this.lostBytes})`
        this.pendingChunks = []
        this.pendingChunkCount = 0
        this.pendingChunkBytes = 0
        throw this.failedError
      }
      throw error
    }
  }

  private async commitBatch(inputs: SessionEventInput[], chunkCount: number, chunkBytes: number): Promise<SessionEvent[]> {
    if (!inputs.length) return []
    this.assertHealthy()
    await this.ensureInitialized()
    const events = inputs.map((input, index) => ({ seq: this.seq + index + 1, time: Date.now(), type: input.type, payload: input.payload }))
    const data = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    let lineState: { bytes: number; terminated: boolean }
    try {
      lineState = await ensureTerminatedLine(this.eventsPath)
      const prefix = lineState.bytes > 0 && !lineState.terminated ? '\n' : ''
      await fs.appendFile(this.eventsPath, prefix + data, 'utf8')
    } catch (error) {
      throw errorWithJsonlState(error, false)
    }

    // JSONL 是权威提交边界；索引只是可重建的派生数据，不能把索引故障
    // 误报成事件未提交，否则业务会重复执行副作用或取消后续审计事件。
    const prefix = lineState!.bytes > 0 && !lineState!.terminated ? '\n' : ''
    this.seq = events[events.length - 1]!.seq
    this.eventCount += events.length
    this.bytes = lineState!.bytes + Buffer.byteLength(prefix + data, 'utf8')
    this.pendingChunkCount = Math.max(0, this.pendingChunkCount - chunkCount)
    this.pendingChunkBytes = Math.max(0, this.pendingChunkBytes - chunkBytes)
    try {
      await this.writeIndex(events[events.length - 1]!)
      this.indexStale = false
    } catch (error) {
      this.indexStale = true
      this.reportError(error)
    }
    return events
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (!this.initializing) this.initializing = this.initialize().catch((error) => { this.initializing = undefined; throw error })
    await this.initializing
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const readResult = await readSessionEventsDetailed(this.eventsPath, {
      onIssue: (issue) => this.reportError(issue)
    })
    const events = readResult.events
    this.seq = events.reduce((max, event) => Math.max(max, event.seq), 0)
    this.eventCount = events.length
    this.bytes = await fs.stat(this.eventsPath).then((stat) => stat.size).catch(() => 0)
    let index: { formatVersion?: number; seq?: number; eventCount?: number; bytes?: number; lastAt?: number } | undefined
    try { index = JSON.parse(await fs.readFile(this.indexPath, 'utf8')) } catch { index = undefined }
    if (this.eventCount > 0 || index) {
      const lastAt = events.length ? events[events.length - 1]!.time : 0
      if (!index || index.formatVersion !== 2 || index.seq !== this.seq || index.eventCount !== this.eventCount || index.bytes !== this.bytes || (this.eventCount > 0 && index.lastAt !== lastAt)) {
        try {
          await this.writeIndex({ seq: this.seq, time: lastAt } as SessionEvent)
          this.indexStale = false
        } catch (error) {
          this.indexStale = true
          this.reportError(error)
        }
      }
    }
    this.initialized = true
  }

  private async writeIndex(lastEvent: Pick<SessionEvent, 'seq' | 'time'>): Promise<void> {
    const temp = path.join(this.directory, `.events-index-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temp, JSON.stringify({ formatVersion: 2, seq: this.seq, eventCount: this.eventCount, bytes: this.bytes, lastAt: lastEvent.time }))
      await fs.rename(temp, this.indexPath)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  private reportError(error: unknown): void {
    try { this.onError?.(error) } catch { /* 诊断回调不得污染提交链 */ }
  }
}

export function getSessionEventSink(workDir: string, sessionId: string, createdAt = Date.now(), options?: SessionEventWriterOptions): SessionEventSink {
  if (!acceptingSessionEvents) throw sessionEventShutdownError()
  const paths = eventPaths(workDir, sessionId, createdAt)
  const existing = writerRegistry.get(paths.eventsPath)
  if (existing) return existing
  return new SessionEventWriter(workDir, sessionId, createdAt, options)
}

function sessionEventShutdownError(): Error & { code?: string } {
  const error = new Error('session event production is closed for shutdown') as Error & { code?: string }
  error.code = 'SESSION_EVENT_SHUTDOWN'
  return error
}

/** 在 shutdown 的同步阶段关闭生产入口；已接受的事件仍由现有 sink 完成提交。 */
export function beginSessionEventShutdown(): void {
  if (sessionEventShutdownStarted) return
  sessionEventShutdownStarted = true
  acceptingSessionEvents = false
  for (const writer of writerRegistry.values()) writer.beginShutdown()
}

/** @deprecated 新代码使用 getSessionEventSink。 */
export function getSessionEventWriter(workDir: string, sessionId: string, createdAt = Date.now(), options?: SessionEventWriterOptions): SessionEventWriter {
  return getSessionEventSink(workDir, sessionId, createdAt, options) as SessionEventWriter
}

export async function flushAllSessionEventSinks(): Promise<void> {
  const failures = await Promise.all([...writerRegistry.values()].map(async (writer) => {
    try {
      const result = await (sessionEventShutdownStarted ? writer.close() : writer.flush())
      if (result.failed) throw new Error('session event sink entered fail-stop')
      return undefined
    } catch (error) {
      const details = error as SessionEventFailure
      const message = error instanceof Error ? error.message : String(error)
      const failure = new Error(`session event shutdown flush failed (eventsPath=${writer.eventsPath}): ${message}`) as SessionEventFailure
      failure.eventsPath = writer.eventsPath
      failure.lostEvents = details.lostEvents
      failure.lostBytes = details.lostBytes
      return failure
    }
  }))
  const failure = failures.find((candidate): candidate is SessionEventFailure => Boolean(candidate))
  if (failure) throw failure
}

/** @deprecated 新代码使用 flushAllSessionEventSinks。 */
export const flushAllSessionEventWriters = flushAllSessionEventSinks

async function ensureTerminatedLine(eventsPath: string): Promise<{ bytes: number; terminated: boolean }> {
  try {
    const handle = await fs.open(eventsPath, 'r')
    try {
      const stat = await handle.stat()
      const { size } = stat
      if (!stat.isFile()) throw new Error('events.jsonl is not a regular file')
      if (size === 0) return { bytes: 0, terminated: true }
      const buffer = Buffer.alloc(1)
      await handle.read(buffer, 0, 1, size - 1)
      return { bytes: size, terminated: buffer[0] === 10 }
    } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { bytes: 0, terminated: true }
    throw error
  }
}

export async function readSessionEventsDetailed(
  eventsPath: string,
  options?: { onIssue?: (issue: SessionEventIssue) => void }
): Promise<SessionEventReadResult> {
  const text = await fs.readFile(eventsPath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return ''
    throw error
  })
  const rawLines = text.split('\n')
  const hasTrailingNewline = text.endsWith('\n')
  const events: SessionEvent[] = []
  const issues: SessionEventIssue[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!
    if (!line) continue
    try { events.push(parseSessionEvent(JSON.parse(line))) }
    catch (error) {
      // 最后一行没有换行且对象没有闭合时，按崩溃撕裂尾行处理；不能只匹配
      // V8 的错误文案，因为 Node 版本间对同一截断 JSON 的文案不同。
      const isTornTail = i === rawLines.length - 1 && !hasTrailingNewline && error instanceof SyntaxError && !line.trimEnd().endsWith('}')
      const issue: SessionEventIssue = {
        code: isTornTail ? 'torn-tail' : error instanceof SyntaxError ? 'malformed-json' : 'invalid-event',
        eventsPath,
        line: i + 1,
        message: error instanceof Error ? error.message : String(error),
        truncated: isTornTail,
        dataLossPossible: !isTornTail
      }
      issues.push(issue)
      options?.onIssue?.(issue)
      if (isTornTail) {
        const lastCompleteNewline = text.lastIndexOf('\n', text.length - 1)
        await fs.truncate(eventsPath, Math.max(0, lastCompleteNewline + 1))
      }
    }
  }
  if (text.length > 0 && !hasTrailingNewline && events.length > 0 && !issues.some((issue) => issue.truncated)) {
    await fs.appendFile(eventsPath, '\n', 'utf8')
  }
  const integrity: SessionEventIntegrity = issues.some((issue) => !issue.truncated)
    ? 'degraded'
    : issues.some((issue) => issue.truncated)
      ? 'recovered-tail'
      : 'complete'
  return { events: events.sort((a, b) => a.seq - b.seq), issues, integrity }
}

export async function readSessionEvents(
  eventsPath: string,
  options?: { onMalformed?: (error: unknown, line: number) => void }
): Promise<SessionEvent[]> {
  const result = await readSessionEventsDetailed(eventsPath, {
    onIssue: (issue) => options?.onMalformed?.(new Error(issue.message), issue.line)
  })
  if (!options?.onMalformed) {
    const issue = result.issues.find((candidate) => !candidate.truncated)
    if (issue) {
      const error = new Error(`session event file is degraded (eventsPath=${eventsPath}, line=${issue.line}): ${issue.message}`) as Error & { code?: string; eventsPath?: string; line?: number }
      error.code = issue.code
      error.eventsPath = eventsPath
      error.line = issue.line
      throw error
    }
  }
  return result.events
}

/** 启动时扫描备份目录，为每个未闭合会话追加补闭事件。 */
export async function reconcileSessionEventFiles(workDir: string): Promise<number> {
  return (await reconcileSessionEventFilesDetailed(workDir)).fixed
}

export async function reconcileSessionEventFilesDetailed(workDir: string): Promise<SessionRecoverySummary> {
  const root = path.join(workDir, 'sessions')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const summary: SessionRecoverySummary = { fixed: 0, sessions: [], failures: [] }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const eventsPath = path.join(root, entry.name, 'events.jsonl')
    let readResult: SessionEventReadResult
    try {
      readResult = await readSessionEventsDetailed(eventsPath)
    } catch (error) {
      summary.failures.push({ sessionName: entry.name, eventsPath, phase: 'read-events', error, jsonlCommitted: false })
      continue
    }
    const repairs = reconcileSessionEvents(readResult.events)
    summary.sessions.push({ sessionName: entry.name, fixed: 0, integrity: readResult.integrity, issues: readResult.issues })
    if (!repairs.length) continue
    try {
      await fs.appendFile(eventsPath, repairs.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    } catch (error) {
      summary.failures.push({ sessionName: entry.name, eventsPath, phase: 'append-events', error, jsonlCommitted: false })
      continue
    }
    summary.fixed += repairs.length
    summary.sessions[summary.sessions.length - 1]!.fixed = repairs.length
    try {
      const bytes = (await fs.stat(eventsPath)).size
      const last = repairs[repairs.length - 1]!
      const temp = path.join(root, entry.name, `.events-index-${randomUUID()}.tmp`)
      try {
        await fs.writeFile(temp, JSON.stringify({ formatVersion: 2, seq: last.seq, lastAt: last.time, eventCount: readResult.events.length + repairs.length, bytes }))
        await fs.rename(temp, path.join(root, entry.name, 'events.index.json'))
      } finally {
        await fs.rm(temp, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      summary.failures.push({ sessionName: entry.name, eventsPath, phase: 'write-index', error, jsonlCommitted: true })
    }
  }
  return summary
}

export async function enforceSessionEventRetention(workDir: string, maxSessions: number): Promise<number> {
  return (await enforceSessionEventRetentionDetailed(workDir, maxSessions)).removed
}

export async function enforceSessionEventRetentionDetailed(workDir: string, maxSessions: number): Promise<SessionRetentionSummary> {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('maxSessions must be positive')
  const root = path.join(workDir, 'sessions')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates: Array<{ name: string; lastAt: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const index = JSON.parse(await fs.readFile(path.join(root, entry.name, 'events.index.json'), 'utf8')) as { lastAt?: number }
      candidates.push({ name: entry.name, lastAt: typeof index.lastAt === 'number' ? index.lastAt : 0 })
    } catch { /* no event stream, leave ordinary backups untouched */ }
  }
  candidates.sort((a, b) => b.lastAt - a.lastAt)
  const removed = candidates.slice(maxSessions)
  const failures: SessionRecoveryFailure[] = []
  let count = 0
  for (const entry of removed) {
    try {
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true })
      count += 1
    } catch (error) {
      failures.push({ sessionName: entry.name, phase: 'retention-delete', error, jsonlCommitted: false })
    }
  }
  return { removed: count, failures }
}

export function reconcileSessionEvents(events: SessionEvent[], startSeq = events.reduce((m, e) => Math.max(m, e.seq), 0) + 1): SessionEvent[] {
  const openTurns = new Set<string>(), openSteps = new Set<string>(), tools = new Set<string>(), results = new Set<string>()
  for (const e of events) {
    const p = e.payload
    if (e.type === 'turn_start') openTurns.add(String(p.turnId))
    if (e.type === 'turn_end') openTurns.delete(String(p.turnId))
    if (e.type === 'step_start') openSteps.add(`${p.turnId}:${p.stepId}`)
    if (e.type === 'step_end') openSteps.delete(`${p.turnId}:${p.stepId}`)
    if (e.type === 'tool_call') tools.add(String(p.toolUseId))
    if (e.type === 'tool_result') results.add(String(p.toolUseId))
  }
  const out: SessionEvent[] = []
  let seq = startSeq
  for (const key of openSteps) { const [turnId, stepId] = key.split(':'); out.push({ seq: seq++, time: Date.now(), type: 'step_end', payload: { turnId, stepId, reason: 'interrupted' } }) }
  for (const toolUseId of tools) if (!results.has(toolUseId)) out.push({ seq: seq++, time: Date.now(), type: 'tool_result', payload: { toolUseId, synthetic: true, result: { success: false, error: '工具调用因应用退出中断' } } })
  for (const turnId of openTurns) out.push({ seq: seq++, time: Date.now(), type: 'turn_end', payload: { turnId, reason: 'interrupted' } })
  return out
}

export function computeSessionUsageFromEvents(events: SessionEvent[], options?: { onInvalidUsage?: (event: SessionEvent, reason: string) => void }): SessionUsage {
  const out: SessionUsage = { input_tokens: 0, output_tokens: 0 }
  for (const e of events) if (e.type === 'request_usage') {
    const rawUsage = e.payload.usage
    if (!isObject(rawUsage)) {
      options?.onInvalidUsage?.(e, 'usage must be an object')
      continue
    }
    const u = rawUsage as Partial<SessionUsage>
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
      const value = u[key]
      if (value === undefined) continue
      if (!Number.isSafeInteger(value) || value < 0) {
        options?.onInvalidUsage?.(e, `${key} must be a non-negative safe integer`)
        continue
      }
      const next = (out[key] ?? 0) + value
      if (!Number.isSafeInteger(next)) {
        options?.onInvalidUsage?.(e, `${key} overflow`)
        continue
      }
      out[key] = next
    }
    if (typeof u.cacheSemantics === 'string') out.cacheSemantics = u.cacheSemantics
  }
  return out
}
