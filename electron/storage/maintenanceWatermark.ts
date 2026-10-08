import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type MaintenanceWatermarkInput = Readonly<{
  localDay: string
  policyFingerprint: string
  rootFingerprint?: string
  algorithmVersion: number
}>
export type MaintenanceWatermark = Readonly<{
  lastSuccessDay?: string
  lastSuccessAt?: number
  lastSuccessPolicyFingerprint?: string
  lastSuccessRootFingerprint?: string
  lastSuccessAlgorithmVersion?: number
  attemptedDay?: string
  attemptedPolicyFingerprint?: string
  attemptedRootFingerprint?: string
  lastError?: string
  updatedAt: number
}>

const writes = new Map<string, Promise<void>>()
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}
function validState(value: unknown): value is MaintenanceWatermark {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return Number.isFinite(state.updatedAt) &&
    (state.lastSuccessDay === undefined || typeof state.lastSuccessDay === 'string') &&
    (state.lastSuccessAt === undefined || Number.isFinite(state.lastSuccessAt)) &&
    (state.lastError === undefined || typeof state.lastError === 'string')
}
async function serializedWrite(filePath: string, update: (current: MaintenanceWatermark | undefined) => MaintenanceWatermark): Promise<void> {
  const previous = writes.get(filePath) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const current = await readMaintenanceWatermarkDisk(filePath)
    const content = `${JSON.stringify(update(current), null, 2)}\n`
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await fs.open(tempPath, 'wx', 0o600)
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    try {
      await fs.rename(tempPath, filePath)
      try {
        const directory = await fs.open(path.dirname(filePath), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(errorCode(error) ?? '')) throw error }
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined)
      throw error
    }
  })
  writes.set(filePath, next)
  try { await next } finally { if (writes.get(filePath) === next) writes.delete(filePath) }
}

async function readMaintenanceWatermarkDisk(filePath: string): Promise<MaintenanceWatermark | undefined> {
  let text: string
  try { text = await fs.readFile(filePath, 'utf8') }
  catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error }
  try {
    const parsed: unknown = JSON.parse(text)
    return validState(parsed) ? parsed : undefined
  } catch { return undefined }
}

export async function readMaintenanceWatermark(filePath: string): Promise<MaintenanceWatermark | undefined> {
  await writes.get(filePath)?.catch(() => undefined)
  return readMaintenanceWatermarkDisk(filePath)
}

export async function shouldRunMaintenance(filePath: string, input: MaintenanceWatermarkInput): Promise<boolean> {
  const watermark = await readMaintenanceWatermark(filePath)
  if (!watermark?.lastSuccessDay || watermark.lastError) return true
  return watermark.lastSuccessDay !== input.localDay ||
    watermark.lastSuccessPolicyFingerprint !== input.policyFingerprint ||
    watermark.lastSuccessRootFingerprint !== input.rootFingerprint ||
    watermark.lastSuccessAlgorithmVersion !== input.algorithmVersion
}

export async function recordMaintenanceSuccess(filePath: string, input: MaintenanceWatermarkInput, completedAt = Date.now()): Promise<void> {
  await serializedWrite(filePath, (current) => ({
    ...current,
    lastSuccessDay: input.localDay,
    lastSuccessAt: completedAt,
    lastSuccessPolicyFingerprint: input.policyFingerprint,
    ...(input.rootFingerprint === undefined ? {} : { lastSuccessRootFingerprint: input.rootFingerprint }),
    lastSuccessAlgorithmVersion: input.algorithmVersion,
    attemptedDay: input.localDay,
    attemptedPolicyFingerprint: input.policyFingerprint,
    ...(input.rootFingerprint === undefined ? {} : { attemptedRootFingerprint: input.rootFingerprint }),
    lastError: undefined,
    updatedAt: completedAt
  }))
}

export async function recordMaintenanceFailure(filePath: string, input: MaintenanceWatermarkInput, errorCodeValue: string, attemptedAt = Date.now()): Promise<void> {
  await serializedWrite(filePath, (current) => ({
    ...current,
    attemptedDay: input.localDay,
    attemptedPolicyFingerprint: input.policyFingerprint,
    ...(input.rootFingerprint === undefined ? {} : { attemptedRootFingerprint: input.rootFingerprint }),
    lastError: errorCodeValue,
    updatedAt: attemptedAt
  }))
}
