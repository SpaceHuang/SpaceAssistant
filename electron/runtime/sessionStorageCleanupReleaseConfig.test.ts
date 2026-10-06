import { describe, expect, it } from 'vitest'
import { readSessionStorageCleanupReleaseGateInput } from './sessionStorageCleanupReleaseConfig'

const buildIdentity = JSON.stringify({ formatVersion: 2, version: '0.3.0', commitSha: 'c'.repeat(40), sourceTreeClean: true,
  buildId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target: { platform: 'mac', arch: 'arm64' } })

describe('会话存储清理发布配置加载', () => {
  it('资源缺失或构建身份不干净时保持关闭', () => {
    const missing = readSessionStorageCleanupReleaseGateInput({
      resourcesPath: '/bundle/resources', appVersion: '0.3.0', schemaVersion: 50,
      historyFormatVersion: 1, spillFormatVersion: 1, platform: 'darwin', arch: 'arm64',
      readFile: () => { throw new Error('ENOENT') },
    })
    expect(missing.deployment.allowContentCleanup).toBe(false)
    expect(missing.record).toBeUndefined()

    const files = new Map([
      ['session-storage-build-identity.json', JSON.stringify({
        formatVersion: 2, version: '0.3.0', commitSha: null, sourceTreeClean: false,
        buildId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target: { platform: 'mac', arch: 'arm64' },
      })],
      ['session-storage-cleanup-deployment.json', JSON.stringify({
        formatVersion: 1, allowContentCleanup: true, compatibilityRecordSha256: 'a'.repeat(64),
      })],
    ])
    const dirty = readSessionStorageCleanupReleaseGateInput({
      resourcesPath: '/bundle/resources', appVersion: '0.3.0', schemaVersion: 50,
      historyFormatVersion: 1, spillFormatVersion: 1, platform: 'darwin', arch: 'arm64',
      readFile: (path) => {
        const value = files.get(path.split('/').at(-1)!)
        if (!value) throw new Error('ENOENT')
        return value
      },
    })
    expect(dirty.currentBuild.commitSha).toBe('')
  })

  it('从 bundle resources 读取版本绑定的评审记录与部署配置，并映射 macOS 目标名', () => {
    const files = new Map([
      ['session-storage-build-identity.json', buildIdentity],
      ['session-storage-cleanup-deployment.json', JSON.stringify({
        formatVersion: 1, allowContentCleanup: false, compatibilityRecordSha256: null,
      })],
      ['session-storage-cleanup-compatibility.json', JSON.stringify({ formatVersion: 1, decision: 'no-go' })],
    ])
    const loaded = readSessionStorageCleanupReleaseGateInput({
      resourcesPath: '/bundle/resources', appVersion: '0.3.0', schemaVersion: 50,
      historyFormatVersion: 1, spillFormatVersion: 1, platform: 'darwin', arch: 'arm64',
      readFile: (path) => {
        const value = files.get(path.split('/').at(-1)!)
        if (!value) throw new Error('ENOENT')
        return value
      },
    })
    expect(loaded.currentBuild).toEqual({
      version: '0.3.0', commitSha: 'c'.repeat(40), schemaVersion: 50,
      historyFormatVersion: 1, spillFormatVersion: 1,
    })
    expect(loaded.target).toEqual({ platform: 'mac', arch: 'arm64' })
    expect(loaded.record).toMatchObject({ decision: 'no-go' })
    expect(loaded.deployment.allowContentCleanup).toBe(false)
  })

  it('畸形部署配置按关闭处理，即使兼容记录文件损坏也不抛异常', () => {
    const files = new Map([
      ['session-storage-build-identity.json', buildIdentity],
      ['session-storage-cleanup-deployment.json', '{broken'],
      ['session-storage-cleanup-compatibility.json', '{broken'],
    ])
    const loaded = readSessionStorageCleanupReleaseGateInput({
      resourcesPath: '/bundle/resources', appVersion: '0.3.0', schemaVersion: 50,
      historyFormatVersion: 1, spillFormatVersion: 1, platform: 'darwin', arch: 'arm64',
      readFile: (path) => {
        const value = files.get(path.split('/').at(-1)!)
        if (!value) throw new Error('ENOENT')
        return value
      },
    })
    expect(loaded.deployment).toEqual({ allowContentCleanup: false, compatibilityRecordSha256: null })
    expect(loaded.record).toBeUndefined()
  })

  it('build identity 缺少合法 UUID 或打包目标与当前平台不符时不提供 commit identity', () => {
    const files = new Map([
      ['session-storage-build-identity.json', JSON.stringify({ formatVersion: 2, version: '0.3.0', commitSha: 'c'.repeat(40),
        sourceTreeClean: true, buildId: 'invalid', target: { platform: 'win', arch: 'x64' } })],
    ])
    const loaded = readSessionStorageCleanupReleaseGateInput({
      resourcesPath: '/bundle/resources', appVersion: '0.3.0', schemaVersion: 50,
      historyFormatVersion: 1, spillFormatVersion: 1, platform: 'darwin', arch: 'arm64',
      readFile: (path) => {
        const value = files.get(path.split('/').at(-1)!)
        if (!value) throw new Error('ENOENT')
        return value
      },
    })
    expect(loaded.currentBuild.commitSha).toBe('')
    expect(loaded.deployment.allowContentCleanup).toBe(false)
  })
})
