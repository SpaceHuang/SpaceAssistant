import { describe, expect, it } from 'vitest'
import { evaluateSessionStorageCleanupReleaseGate } from './sessionStorageCleanupReleaseGate'
import { SESSION_STORAGE_DATA_CONTRACT_SHA256 } from './sessionStorageDataContract'

const approvedRecord = {
  status: 'accepted',
  recordId: 'rollback-floor-review-2026-10-04',
  rollbackFloor: {
    version: '0.2.3', tag: 'v0.2.3', commit: 'a'.repeat(40),
    releaseUrl: 'https://github.com/SpaceHuang/SpaceAssistant/releases/tag/v0.2.3',
    verifiedArtifacts: [{
      target: 'macos-arm64',
      downloadUrl: 'https://github.com/SpaceHuang/SpaceAssistant/releases/download/v0.2.3/SpaceAssistant-0.2.3-arm64.dmg',
      sha256: 'e'.repeat(64),
      verifiedAt: '2026-10-04T00:00:00.000Z',
      drillEvidenceUrl: `https://github.com/SpaceHuang/SpaceAssistant/blob/${'a'.repeat(40)}/docs/review/session-storage-r-c-drill-macos-arm64.md`,
      drillEvidenceSha256: 'f'.repeat(64),
    }],
  },
  candidate: { version: '0.3.0', tag: 'v0.3.0', commit: 'b'.repeat(40) },
  contract: { schemaVersion: 49, sha256: SESSION_STORAGE_DATA_CONTRACT_SHA256 },
  reviewedAt: '2026-10-04T00:00:00.000Z',
  reviewedBy: 'release-reviewer',
}

const validInput = {
  deploymentAllowsCleanup: true,
  runningRelease: { version: '0.3.0', tag: 'v0.3.0', commit: 'b'.repeat(40), schemaVersion: 49 },
  deploymentTarget: 'macos-arm64',
  compatibilityRecord: approvedRecord,
}

describe('session content cleanup release gate', () => {
  it('fails closed when deployment has not explicitly enabled cleanup', () => {
    expect(evaluateSessionStorageCleanupReleaseGate({ ...validInput, deploymentAllowsCleanup: false }))
      .toEqual({ allowed: false, reason: 'deployment-disabled' })
  })

  it('fails closed when the accepted compatibility record is absent or incomplete', () => {
    expect(evaluateSessionStorageCleanupReleaseGate({ ...validInput, compatibilityRecord: undefined }))
      .toEqual({ allowed: false, reason: 'compatibility-record-missing' })
    expect(evaluateSessionStorageCleanupReleaseGate({ ...validInput, compatibilityRecord: { ...approvedRecord, rollbackFloor: undefined } }))
      .toEqual({ allowed: false, reason: 'compatibility-record-invalid' })
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...validInput,
      compatibilityRecord: { ...approvedRecord, rollbackFloor: { ...approvedRecord.rollbackFloor, verifiedArtifacts: undefined } },
    })).toEqual({ allowed: false, reason: 'compatibility-record-invalid' })
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...validInput,
      compatibilityRecord: {
        ...approvedRecord,
        rollbackFloor: {
          ...approvedRecord.rollbackFloor,
          verifiedArtifacts: [{ target: 'macos-arm64', downloadUrl: 'https://github.com/SpaceHuang/SpaceAssistant/releases/download/v0.2.3/app.dmg', sha256: 'e'.repeat(64), verifiedAt: '2026-10-04T00:00:00.000Z' }],
        },
      },
    })).toEqual({ allowed: false, reason: 'compatibility-record-invalid' })
  })

  it('requires the running C release identity to match the reviewed candidate', () => {
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...validInput,
      runningRelease: { ...validInput.runningRelease, commit: 'd'.repeat(40) },
    })).toEqual({ allowed: false, reason: 'candidate-release-mismatch' })
  })

  it('requires the reviewed data contract digest and runtime schema to match the current code contract', () => {
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...validInput,
      compatibilityRecord: { ...approvedRecord, contract: { ...approvedRecord.contract, sha256: 'd'.repeat(64) } },
    }))
      .toEqual({ allowed: false, reason: 'contract-mismatch' })
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...validInput,
      runningRelease: { ...validInput.runningRelease, schemaVersion: 50 },
    })).toEqual({ allowed: false, reason: 'contract-mismatch' })
  })

  it('requires an installed-platform rollback artifact that was explicitly verified', () => {
    expect(evaluateSessionStorageCleanupReleaseGate({ ...validInput, deploymentTarget: 'windows-x64' }))
      .toEqual({ allowed: false, reason: 'rollback-artifact-unverified' })
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...validInput,
      compatibilityRecord: {
        ...approvedRecord,
        rollbackFloor: {
          ...approvedRecord.rollbackFloor,
          releaseUrl: 'http://github.com/SpaceHuang/SpaceAssistant/releases/tag/v0.2.3',
        },
      },
    })).toEqual({ allowed: false, reason: 'compatibility-record-invalid' })
  })

  it('allows cleanup only when the deployment, reviewed R/C record, runtime identity, and contract all agree', () => {
    expect(evaluateSessionStorageCleanupReleaseGate(validInput)).toEqual({ allowed: true, reason: 'accepted' })
  })
})
