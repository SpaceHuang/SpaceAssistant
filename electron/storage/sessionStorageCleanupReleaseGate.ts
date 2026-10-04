import { SESSION_STORAGE_DATA_CONTRACT, SESSION_STORAGE_DATA_CONTRACT_SHA256 } from './sessionStorageDataContract'

export type SessionStorageCleanupReleaseGateResult = Readonly<
  | { allowed: true; reason: 'accepted' }
  | {
      allowed: false
      reason:
        | 'deployment-disabled'
        | 'compatibility-record-missing'
        | 'compatibility-record-invalid'
        | 'running-release-invalid'
        | 'candidate-release-mismatch'
        | 'contract-mismatch'
        | 'rollback-artifact-unverified'
    }
>

export type SessionStorageCleanupReleaseGateInput = Readonly<{
  deploymentAllowsCleanup: boolean
  runningRelease: unknown
  deploymentTarget: string
  compatibilityRecord: unknown
}>

type ReleaseIdentity = Readonly<{ version: string; tag: string; commit: string }>
type PublishedRollbackFloor = ReleaseIdentity & Readonly<{
  releaseUrl: string
  verifiedArtifacts: readonly Readonly<{
    target: string
    downloadUrl: string
    sha256: string
    verifiedAt: string
    drillEvidenceUrl: string
    drillEvidenceSha256: string
  }>[]
}>
type RuntimeReleaseIdentity = ReleaseIdentity & Readonly<{ schemaVersion: number }>
type AcceptedCompatibilityRecord = Readonly<{
  status: 'accepted'
  recordId: string
  rollbackFloor: PublishedRollbackFloor
  candidate: ReleaseIdentity
  contract: Readonly<{ schemaVersion: number; sha256: string }>
  reviewedAt: string
  reviewedBy: string
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
}

function versionTuple(value: string): readonly [number, number, number] {
  return value.split('.').map(Number) as [number, number, number]
}

function isReleaseIdentity(value: unknown): value is ReleaseIdentity {
  return isRecord(value) && isVersion(value.version) && value.tag === `v${value.version}` &&
    typeof value.commit === 'string' && /^[a-f0-9]{40}$/i.test(value.commit)
}

function isRuntimeReleaseIdentity(value: unknown): value is RuntimeReleaseIdentity {
  if (!isRecord(value)) return false
  const fields: Record<string, unknown> = value
  if (!isReleaseIdentity(value)) return false
  const schemaVersion = fields.schemaVersion
  return Number.isSafeInteger(schemaVersion) && Number(schemaVersion) > 0
}

function isPublishedRollbackFloor(value: unknown): value is PublishedRollbackFloor {
  if (!isRecord(value)) return false
  const fields: Record<string, unknown> = value
  if (!isReleaseIdentity(value)) return false
  const releaseUrl = fields.releaseUrl
  const verifiedArtifacts = fields.verifiedArtifacts
  if (typeof releaseUrl !== 'string' || !Array.isArray(verifiedArtifacts) || verifiedArtifacts.length === 0 ||
    !verifiedArtifacts.every((artifact) => {
      if (!isRecord(artifact) || typeof artifact.target !== 'string' || !artifact.target.trim() ||
        typeof artifact.downloadUrl !== 'string' || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
        typeof artifact.verifiedAt !== 'string' || !Number.isFinite(Date.parse(artifact.verifiedAt)) ||
        typeof artifact.drillEvidenceUrl !== 'string' || typeof artifact.drillEvidenceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(artifact.drillEvidenceSha256)) return false
      try {
        const downloadUrl = new URL(artifact.downloadUrl)
        const drillEvidenceUrl = new URL(artifact.drillEvidenceUrl)
        return downloadUrl.protocol === 'https:' && downloadUrl.hostname === 'github.com' &&
          drillEvidenceUrl.protocol === 'https:' && drillEvidenceUrl.hostname === 'github.com' &&
          drillEvidenceUrl.pathname.startsWith('/SpaceHuang/SpaceAssistant/') &&
          downloadUrl.pathname.startsWith(`/SpaceHuang/SpaceAssistant/releases/download/${value.tag}/`)
      } catch {
        return false
      }
    })) return false
  try {
    const url = new URL(releaseUrl)
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      url.pathname === `/SpaceHuang/SpaceAssistant/releases/tag/${value.tag}`
  } catch {
    return false
  }
}

function isAcceptedCompatibilityRecord(value: unknown): value is AcceptedCompatibilityRecord {
  if (!isRecord(value) || value.status !== 'accepted' || typeof value.recordId !== 'string' || !value.recordId.trim() ||
    !isPublishedRollbackFloor(value.rollbackFloor) || !isReleaseIdentity(value.candidate) || !isRecord(value.contract) ||
    typeof value.reviewedAt !== 'string' || !Number.isFinite(Date.parse(value.reviewedAt)) ||
    typeof value.reviewedBy !== 'string' || !value.reviewedBy.trim()) return false
  const { schemaVersion, sha256 } = value.contract
  if (!Number.isSafeInteger(schemaVersion) || Number(schemaVersion) <= 0 ||
    typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) return false

  const rollbackVersion = versionTuple(value.rollbackFloor.version)
  const candidateVersion = versionTuple(value.candidate.version)
  for (let index = 0; index < rollbackVersion.length; index += 1) {
    if (candidateVersion[index]! > rollbackVersion[index]!) return true
    if (candidateVersion[index]! < rollbackVersion[index]!) return false
  }
  return false
}

/**
 * C callers must run this check before any production cleanup transition.
 * This helper deliberately performs no I/O and never infers approval from missing configuration.
 */
export function evaluateSessionStorageCleanupReleaseGate(
  input: SessionStorageCleanupReleaseGateInput,
): SessionStorageCleanupReleaseGateResult {
  if (input.deploymentAllowsCleanup !== true) return { allowed: false, reason: 'deployment-disabled' }
  if (input.compatibilityRecord === undefined || input.compatibilityRecord === null) {
    return { allowed: false, reason: 'compatibility-record-missing' }
  }
  if (!isAcceptedCompatibilityRecord(input.compatibilityRecord)) {
    return { allowed: false, reason: 'compatibility-record-invalid' }
  }

  const runningRelease = input.runningRelease
  if (!isRuntimeReleaseIdentity(runningRelease)) {
    return { allowed: false, reason: 'running-release-invalid' }
  }
  const current = runningRelease as RuntimeReleaseIdentity
  const record = input.compatibilityRecord
  if (current.version !== record.candidate.version || current.tag !== record.candidate.tag ||
    current.commit !== record.candidate.commit) {
    return { allowed: false, reason: 'candidate-release-mismatch' }
  }
  if (record.contract.sha256.toLowerCase() !== SESSION_STORAGE_DATA_CONTRACT_SHA256.toLowerCase() ||
    record.contract.schemaVersion !== SESSION_STORAGE_DATA_CONTRACT.databaseSchemaVersion ||
    current.schemaVersion !== SESSION_STORAGE_DATA_CONTRACT.databaseSchemaVersion) {
    return { allowed: false, reason: 'contract-mismatch' }
  }
  if (typeof input.deploymentTarget !== 'string' || !input.deploymentTarget.trim() ||
    !record.rollbackFloor.verifiedArtifacts.some((artifact) => artifact.target === input.deploymentTarget)) {
    return { allowed: false, reason: 'rollback-artifact-unverified' }
  }

  return { allowed: true, reason: 'accepted' }
}
