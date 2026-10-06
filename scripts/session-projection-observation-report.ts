import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { summarizeSessionProjectionObservation, type SessionProjectionObservationEvent } from '../electron/runtime/sessionProjectionObservation'

type Options = { appVersion?: string; artifactBuildId?: string; from?: string; to?: string; maxReadP95Ms?: number;
  minimumReadSamples?: number; minimumShadowSamples?: number; requiredPathCoverage: string[]; out?: string; inputs: string[] }

const OBSERVATION_EVENTS = new Set([
  'session.transcript.read', 'session.storage.shadow', 'session.transcript.reconciliation',
  'session.history.recovery', 'history.cutover'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isStableErrorCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{2,127}$/.test(value)
}

function isValidAgentLogRow(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isNonEmptyString(value.event) || !isNonEmptyString(value.ts) || !Number.isFinite(Date.parse(value.ts)) ||
    !['info', 'warn', 'error'].includes(String(value.level)) ||
    (value.errorCode !== undefined && !isStableErrorCode(value.errorCode))) return false
  if (!OBSERVATION_EVENTS.has(value.event)) return true
  if (!isNonEmptyString(value.appVersion) || !isNonEmptyString(value.artifactBuildId) || !/^[0-9a-f-]{36}$/i.test(value.artifactBuildId)) return false
  switch (value.event) {
    case 'session.transcript.read':
      return value.consumer === 'transcript' && isNonEmptyString(value.source) &&
        ['canonical', 'legacy', 'failed'].includes(String(value.outcome)) && isNonNegativeNumber(value.durationMs) &&
        (value.outcome !== 'failed' || isStableErrorCode(value.errorCode))
    case 'session.storage.shadow':
      return isNonEmptyString(value.consumer) && isNonEmptyString(value.source) &&
        ['matched', 'mismatched', 'unavailable'].includes(String(value.status)) && isNonNegativeNumber(value.differenceCount)
    case 'session.history.recovery':
      return ['completed', 'degraded'].includes(String(value.outcome)) && isNonNegativeNumber(value.reconciledCount) &&
        isNonNegativeNumber(value.failed) && isNonNegativeNumber(value.durationMs)
    case 'session.transcript.reconciliation':
      return ['commit_uncertain', 'startup-failed', 'startup-blocked', 'startup-scan', 'continuation-startup-recovery']
        .includes(String(value.outcome))
    case 'history.cutover':
      return isNonEmptyString(value.stage) && isNonEmptyString(value.reasonCode) &&
        ['matched', 'no-cutover', 'rejected', 'legacy-fallback'].includes(String(value.outcome))
    default:
      return false
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = { inputs: [], requiredPathCoverage: [] }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = args[index + 1]
    if (arg === '--version' && value) options.appVersion = value, index += 1
    else if (arg === '--artifact-build-id' && value) options.artifactBuildId = value, index += 1
    else if (arg === '--from' && value) options.from = value, index += 1
    else if (arg === '--to' && value) options.to = value, index += 1
    else if (arg === '--max-read-p95-ms' && value) options.maxReadP95Ms = Number(value), index += 1
    else if (arg === '--min-read-samples' && value) options.minimumReadSamples = Number(value), index += 1
    else if (arg === '--min-shadow-samples' && value) options.minimumShadowSamples = Number(value), index += 1
    else if (arg === '--require-path' && value) options.requiredPathCoverage.push(value), index += 1
    else if (arg === '--out' && value) options.out = value, index += 1
    else if (arg.startsWith('--')) throw new Error(`unknown or incomplete option: ${arg}`)
    else options.inputs.push(arg)
  }
  if (!options.appVersion || !options.artifactBuildId || !options.from || !options.to || options.maxReadP95Ms === undefined ||
    options.minimumReadSamples === undefined || options.minimumShadowSamples === undefined || options.requiredPathCoverage.length === 0 || options.inputs.length === 0) {
    throw new Error('usage: tsx scripts/session-projection-observation-report.ts --version VERSION --artifact-build-id UUID --from ISO --to ISO --max-read-p95-ms MS --min-read-samples N --min-shadow-samples N --require-path PATH [--require-path PATH...] [--out FILE] LOG_FILE_OR_DIR...')
  }
  return options
}

async function listLogFiles(input: string): Promise<string[]> {
  const resolved = path.resolve(input)
  const stat = await fs.stat(resolved)
  if (stat.isFile()) return /\.(?:log|jsonl)$/i.test(resolved) ? [resolved] : []
  const entries = await fs.readdir(resolved, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = path.join(resolved, entry.name)
    if (entry.isDirectory()) return listLogFiles(child)
    return entry.isFile() && /\.(?:log|jsonl)$/i.test(entry.name) ? [child] : []
  }))
  return nested.flat()
}

async function readObservationEvents(inputs: readonly string[]): Promise<{ events: SessionProjectionObservationEvent[]; malformedRecordCount: number }> {
  const files = [...new Set((await Promise.all(inputs.map(listLogFiles))).flat())].sort()
  const events: SessionProjectionObservationEvent[] = []
  let malformedRecordCount = 0
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const row: unknown = JSON.parse(line)
        if (!isValidAgentLogRow(row)) {
          malformedRecordCount += 1
          continue
        }
        if (OBSERVATION_EVENTS.has(String(row.event))) events.push(row as SessionProjectionObservationEvent)
      } catch { malformedRecordCount += 1 }
    }
  }
  return { events, malformedRecordCount }
}

export async function createSessionProjectionObservationReport(args: string[]) {
  const options = parseArgs(args)
  const { events, malformedRecordCount } = await readObservationEvents(options.inputs)
  return summarizeSessionProjectionObservation(events, {
    appVersion: options.appVersion!, artifactBuildId: options.artifactBuildId!, from: options.from!, to: options.to!,
    maxReadP95Ms: options.maxReadP95Ms!, minimumReadSamples: options.minimumReadSamples!,
    minimumShadowSamples: options.minimumShadowSamples!, requiredPathCoverage: options.requiredPathCoverage, malformedRecordCount
  })
}

async function main(): Promise<void> {
  try {
    const report = await createSessionProjectionObservationReport(process.argv.slice(2))
    const json = `${JSON.stringify(report, null, 2)}\n`
    const out = parseArgs(process.argv.slice(2)).out
    if (out) await fs.writeFile(path.resolve(out), json, 'utf8')
    process.stdout.write(json)
    if (!report.observationComplete) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'failed to build observation report'}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) void main()
