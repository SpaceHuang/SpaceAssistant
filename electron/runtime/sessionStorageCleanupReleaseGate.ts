import { createHash } from 'node:crypto'

export type SessionStorageCleanupState = 'write-stopped' | 'pending' | 'complete'

export type SessionStorageCleanupCompatibilityRecord = Readonly<{
  formatVersion: 1
  decision: 'accepted' | 'no-go'
  review: Readonly<{ reference: string; reviewedAt: string }>
  candidate: Readonly<{
    version: string
    commitSha: string
    schemaVersion: number
    historyFormatVersion: number
    spillFormatVersion: number
  }>
  rollback: Readonly<{
    version: string
    commitSha: string
    maxReadableSchemaVersion: number
    historyFormatVersions: readonly number[]
    spillFormatVersions: readonly number[]
    canonicalOnlyReader: boolean
    cleanupStates: readonly SessionStorageCleanupState[]
    artifacts: Readonly<Record<string, Readonly<{ downloadUrl: string; sha256: string }>>>
  }>
}>

export type SessionStorageCleanupReleaseGateInput = Readonly<{
  currentBuild: Readonly<{
    version: string
    commitSha: string
    schemaVersion: number
    historyFormatVersion: number
    spillFormatVersion: number
  }>
  target: Readonly<{ platform: string; arch: string }>
  deployment: Readonly<{
    allowContentCleanup: boolean
    compatibilityRecordSha256: string | null
  }>
  record: SessionStorageCleanupCompatibilityRecord | undefined
}>

export type SessionStorageCleanupReleaseGateResult = Readonly<{
  allowed: boolean
  reason:
    | 'authorized'
    | 'deployment-disabled'
    | 'record-missing'
    | 'record-digest-mismatch'
    | 'review-not-accepted'
    | 'candidate-mismatch'
    | 'rollback-incompatible'
    | 'target-artifact-missing'
}>

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

/** 对完整评审记录计算与键顺序无关的摘要，供部署配置固定引用。 */
export function getSessionStorageCleanupCompatibilityRecordSha256(
  record: SessionStorageCleanupCompatibilityRecord,
): string {
  return createHash('sha256').update(stableJson(record)).digest('hex')
}

function deny(reason: Exclude<SessionStorageCleanupReleaseGateResult['reason'], 'authorized'>): SessionStorageCleanupReleaseGateResult {
  return { allowed: false, reason }
}

/**
 * C 侧生产清理入口使用的 fail-closed 策略。
 * 校验已配置的评审记录和显式部署放行开关；函数本身不会启用清理，也不能证明产物已发布。
 */
export function evaluateSessionStorageCleanupReleaseGate(
  input: SessionStorageCleanupReleaseGateInput,
): SessionStorageCleanupReleaseGateResult {
  if (input.deployment.allowContentCleanup !== true) return deny('deployment-disabled')
  const { record } = input
  if (!record) return deny('record-missing')

  const expectedDigest = input.deployment.compatibilityRecordSha256
  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest) ||
    getSessionStorageCleanupCompatibilityRecordSha256(record) !== expectedDigest) {
    return deny('record-digest-mismatch')
  }

  if (record.formatVersion !== 1 || record.decision !== 'accepted' ||
    typeof record.review?.reference !== 'string' || !record.review.reference.trim() ||
    typeof record.review?.reviewedAt !== 'string' || !record.review.reviewedAt.trim()) {
    return deny('review-not-accepted')
  }

  const { candidate } = record
  const current = input.currentBuild
  if (!candidate || typeof candidate.version !== 'string' || typeof candidate.commitSha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(candidate.commitSha) || candidate.version !== current.version || candidate.commitSha !== current.commitSha ||
    !Number.isSafeInteger(candidate.schemaVersion) || candidate.schemaVersion < 1 ||
    !Number.isSafeInteger(candidate.historyFormatVersion) || candidate.historyFormatVersion < 1 ||
    !Number.isSafeInteger(candidate.spillFormatVersion) || candidate.spillFormatVersion < 1 ||
    candidate.schemaVersion !== current.schemaVersion ||
    candidate.historyFormatVersion !== current.historyFormatVersion ||
    candidate.spillFormatVersion !== current.spillFormatVersion) {
    return deny('candidate-mismatch')
  }

  const { rollback } = record
  const requiredCleanupStates: readonly SessionStorageCleanupState[] = ['write-stopped', 'pending', 'complete']
  if (!rollback || typeof rollback.version !== 'string' || !rollback.version.trim() ||
    typeof rollback.commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(rollback.commitSha) ||
    !Array.isArray(rollback.historyFormatVersions) || !Array.isArray(rollback.spillFormatVersions) ||
    !Array.isArray(rollback.cleanupStates) || !rollback.artifacts || typeof rollback.artifacts !== 'object' ||
    !Number.isSafeInteger(rollback.maxReadableSchemaVersion) || rollback.maxReadableSchemaVersion < 1 ||
    rollback.maxReadableSchemaVersion < current.schemaVersion || !rollback.canonicalOnlyReader ||
    !rollback.historyFormatVersions.includes(current.historyFormatVersion) ||
    !rollback.spillFormatVersions.includes(current.spillFormatVersion) ||
    requiredCleanupStates.some((state) => !rollback.cleanupStates.includes(state))) {
    return deny('rollback-incompatible')
  }

  const artifactKey = `${input.target.platform}-${input.target.arch}`
  const artifact = rollback.artifacts[artifactKey]
  if (!artifact || typeof artifact.downloadUrl !== 'string' || !artifact.downloadUrl.trim() ||
    typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    return deny('target-artifact-missing')
  }

  return { allowed: true, reason: 'authorized' }
}
