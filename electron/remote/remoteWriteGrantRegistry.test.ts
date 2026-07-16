import { describe, expect, it, beforeEach } from 'vitest'
import {
  REMOTE_WRITE_GRANT_MAX_OPS,
  buildRemoteWriteGrantPrompt,
  remoteWriteGrantRegistry
} from './remoteWriteGrantRegistry'

describe('RemoteWriteGrantRegistry', () => {
  beforeEach(() => {
    remoteWriteGrantRegistry.clearAll()
  })

  it('issues grant and reserves within budget', () => {
    const g = remoteWriteGrantRegistry.issue({
      channel: 'feishu',
      owner: 'ou_1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0
    })
    expect(g.remainingOps).toBe(REMOTE_WRITE_GRANT_MAX_OPS)
    const r = remoteWriteGrantRegistry.reserve({
      channel: 'feishu',
      owner: 'ou_1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0,
      byteCount: 100
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.grant.remainingOps).toBe(REMOTE_WRITE_GRANT_MAX_OPS - 1)
  })

  it('does not let a second owner reuse another owner grant on the same session/workdir', () => {
    remoteWriteGrantRegistry.issue({
      channel: 'feishu',
      owner: 'ou_1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0
    })
    const cross = remoteWriteGrantRegistry.reserve({
      channel: 'feishu',
      owner: 'ou_2',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0,
      byteCount: 10
    })
    expect(cross.ok).toBe(false)
    const own = remoteWriteGrantRegistry.reserve({
      channel: 'feishu',
      owner: 'ou_1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0,
      byteCount: 10
    })
    expect(own.ok).toBe(true)
  })

  it('revokeByOriginSession clears grants', () => {
    remoteWriteGrantRegistry.issue({
      channel: 'wechat',
      owner: 'u1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0
    })
    expect(remoteWriteGrantRegistry.revokeByOriginSession('s1', 'switch')).toBeGreaterThan(0)
    const r = remoteWriteGrantRegistry.reserve({
      channel: 'wechat',
      owner: 'u1',
      originSessionId: 's1',
      workDirProfileId: 'wd1',
      authorizationGeneration: 0,
      byteCount: 1
    })
    expect(r.ok).toBe(false)
  })

  it('prompt template contains required scope fields', () => {
    const text = buildRemoteWriteGrantPrompt({
      sessionLabel: 'sess-abc',
      workDirName: '项目A',
      confirmId: 'AB12'
    })
    expect(text).toContain('临时文件写入授权')
    expect(text).toContain('sess-abc')
    expect(text).toContain('项目A')
    expect(text).toContain('30 分钟')
    expect(text).toContain('500')
    expect(text).toContain('50 MiB')
    expect(text).toContain('write_file')
    expect(text).toContain('edit_file')
    expect(text).toContain('shell')
    expect(text).toContain('AB12')
  })
})
