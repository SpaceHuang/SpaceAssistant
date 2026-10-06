import { describe, expect, it } from 'vitest'
import { createSessionStorageCleanupProductionBoundary, type SessionStorageCleanupProductionStep } from './sessionStorageCleanupProduction'

const resourceFiles = new Map([
  ['session-storage-build-identity.json', JSON.stringify({
    formatVersion: 2, version: '0.2.4', commitSha: 'c'.repeat(40), sourceTreeClean: true,
    buildId: 'b'.repeat(36), target: { platform: 'mac', arch: 'arm64' },
  })],
  ['session-storage-cleanup-deployment.json', JSON.stringify({
    formatVersion: 1, allowContentCleanup: false, compatibilityRecordSha256: null,
  })],
  ['session-storage-cleanup-compatibility.json', 'null'],
])

const createBoundary = () => createSessionStorageCleanupProductionBoundary({
  resourcesPath: '/bundle/resources', appVersion: '0.2.4', schemaVersion: 48,
  historyFormatVersion: 1, spillFormatVersion: 1, platform: 'darwin', arch: 'arm64',
  readFile: (filePath) => {
    const value = resourceFiles.get(filePath.split('/').at(-1)!)
    if (!value) throw new Error('ENOENT')
    return value
  },
})

describe('会话正文清理生产边界', () => {
  it.each<SessionStorageCleanupProductionStep>([
    { kind: 'certify' },
    { kind: 'write-stop' },
    { kind: 'begin' },
    { kind: 'batch', batchSize: 1 },
    { kind: 'verify-complete' },
  ])('每个清理阶段在 gate 关闭时都不会触碰数据库（%s）', (step) => {
    const result = createBoundary()({} as never, 'must-not-be-read', step)
    expect(result).toMatchObject({ status: 'blocked', gate: { allowed: false, reason: 'deployment-disabled' } })
  })
})
