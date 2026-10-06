import { describe, expect, it } from 'vitest'
import {
  evaluateSessionStorageCleanupReleaseGate,
  getSessionStorageCleanupCompatibilityRecordSha256,
  type SessionStorageCleanupCompatibilityRecord,
} from './sessionStorageCleanupReleaseGate'

const record: SessionStorageCleanupCompatibilityRecord = {
  formatVersion: 1,
  decision: 'accepted',
  review: {
    reference: 'docs/review/rollback-floor-audit.md#accepted',
    reviewedAt: '2026-10-04T10:00:00.000Z',
  },
  candidate: {
    version: '0.3.0',
    commitSha: 'c'.repeat(40),
    schemaVersion: 50,
    historyFormatVersion: 1,
    spillFormatVersion: 1,
  },
  rollback: {
    version: '0.3.0-r',
    commitSha: 'b'.repeat(40),
    maxReadableSchemaVersion: 50,
    historyFormatVersions: [1],
    spillFormatVersions: [1],
    canonicalOnlyReader: true,
    cleanupStates: ['write-stopped', 'pending', 'complete'],
    artifacts: {
      'mac-arm64': {
        downloadUrl: 'https://example.invalid/rollback.dmg',
        sha256: 'a'.repeat(64),
      },
    },
  },
}

const validInput = () => ({
  currentBuild: {
    version: record.candidate.version,
    commitSha: record.candidate.commitSha,
    schemaVersion: record.candidate.schemaVersion,
    historyFormatVersion: record.candidate.historyFormatVersion,
    spillFormatVersion: record.candidate.spillFormatVersion,
  },
  target: { platform: 'mac', arch: 'arm64' },
  deployment: {
    allowContentCleanup: true,
    compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(record),
  },
  record,
})

describe('会话存储清理发布门禁', () => {
  it('部署未显式启用清理时关闭', () => {
    const input = validInput()
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      deployment: { ...input.deployment, allowContentCleanup: false },
    })).toMatchObject({ allowed: false, reason: 'deployment-disabled' })
  })

  it('未提供回滚兼容评审记录时关闭', () => {
    const input = validInput()
    expect(evaluateSessionStorageCleanupReleaseGate({ ...input, record: undefined }))
      .toMatchObject({ allowed: false, reason: 'record-missing' })
  })

  it('仅放行绑定当前 C 构建和目标 R 产物的已评审记录', () => {
    expect(evaluateSessionStorageCleanupReleaseGate(validInput())).toEqual({ allowed: true, reason: 'authorized' })
  })

  it('拒绝与部署配置摘要不一致的兼容记录', () => {
    const input = validInput()
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      deployment: { ...input.deployment, compatibilityRecordSha256: '0'.repeat(64) },
    })).toMatchObject({ allowed: false, reason: 'record-digest-mismatch' })
  })

  it('拒绝属于其它 C commit 或 schema 的记录', () => {
    const input = validInput()
    const otherRecord = { ...record, candidate: { ...record.candidate, commitSha: 'd'.repeat(40) } }
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      record: otherRecord,
      deployment: { ...input.deployment, compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(otherRecord) },
    })).toMatchObject({ allowed: false, reason: 'candidate-mismatch' })

    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      currentBuild: { ...input.currentBuild, schemaVersion: 49 },
    })).toMatchObject({ allowed: false, reason: 'candidate-mismatch' })
  })

  it('拒绝不支持 canonical-only、清理状态或当前数据格式的记录', () => {
    const input = validInput()
    const incompatible = {
      ...record,
      rollback: {
        ...record.rollback,
        canonicalOnlyReader: false,
        cleanupStates: ['write-stopped', 'pending'] as const,
        historyFormatVersions: [2],
      },
    }
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      record: incompatible,
      deployment: { ...input.deployment, compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(incompatible) },
    })).toMatchObject({ allowed: false, reason: 'rollback-incompatible' })
  })

  it('schema v50 的清理构建拒绝只支持到 v49 的回滚版本', () => {
    const input = validInput()
    const incompatible = { ...record, rollback: { ...record.rollback, maxReadableSchemaVersion: 49 } }
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      record: incompatible,
      deployment: { ...input.deployment,
        compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(incompatible) },
    })).toMatchObject({ allowed: false, reason: 'rollback-incompatible' })
  })

  it('拒绝缺少目标安装包或评审未接受的记录', () => {
    const input = validInput()
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      target: { platform: 'win', arch: 'x64' },
    })).toMatchObject({ allowed: false, reason: 'target-artifact-missing' })

    const rejected = { ...record, decision: 'no-go' as const }
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      record: rejected,
      deployment: { ...input.deployment, compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(rejected) },
    })).toMatchObject({ allowed: false, reason: 'review-not-accepted' })
  })

  it('摘要固定完整记录且不受键顺序影响，并拒绝畸形记录', () => {
    const input = validInput()
    const reverseObjectKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseObjectKeys)
      if (value === null || typeof value !== 'object') return value
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)]))
    }
    const reordered = reverseObjectKeys(record) as SessionStorageCleanupCompatibilityRecord
    expect(getSessionStorageCleanupCompatibilityRecordSha256(reordered))
      .toBe(getSessionStorageCleanupCompatibilityRecordSha256(record))

    const malformed = { ...record, rollback: { ...record.rollback, artifacts: undefined } }
    expect(() => evaluateSessionStorageCleanupReleaseGate({
      ...input,
      record: malformed as unknown as SessionStorageCleanupCompatibilityRecord,
      deployment: {
        ...input.deployment,
        compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(
          malformed as unknown as SessionStorageCleanupCompatibilityRecord,
        ),
      },
    })).not.toThrow()
    expect(evaluateSessionStorageCleanupReleaseGate({
      ...input,
      record: malformed as unknown as SessionStorageCleanupCompatibilityRecord,
      deployment: {
        ...input.deployment,
        compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(
          malformed as unknown as SessionStorageCleanupCompatibilityRecord,
        ),
      },
    })).toMatchObject({ allowed: false, reason: 'rollback-incompatible' })
  })
})
