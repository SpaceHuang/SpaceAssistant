import { describe, expect, it } from 'vitest'
import { createContinuationSafetySnapshot } from './continuationSafetySnapshot'

describe('continuation safety snapshot', () => {
  it('只保留工作目录和工具边界指纹，不泄露路径', () => {
    const snapshot = createContinuationSafetySnapshot({
      workDirProfileId: 'profile-1', workDir: '/Users/alice/private-project', authorizationVersion: 'policy-v1',
      tools: [{ name: 'edit_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }]
    })
    expect(snapshot.workDirProfileId).toBe('profile-1')
    expect(snapshot.workDirSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(snapshot)).not.toContain('/Users/alice')
  })

  it('工作目录、权限版本或工具 schema 改变时指纹随之改变', () => {
    const base = { workDirProfileId: 'profile-1', workDir: '/project', authorizationVersion: 'policy-v1', tools: [{ name: 'edit_file', inputSchema: { required: ['path'] } }] }
    const first = createContinuationSafetySnapshot(base)
    expect(createContinuationSafetySnapshot({ ...base, workDir: '/other' })).not.toEqual(first)
    expect(createContinuationSafetySnapshot({ ...base, authorizationVersion: 'policy-v2' })).not.toEqual(first)
    expect(createContinuationSafetySnapshot({ ...base, tools: [{ name: 'edit_file', inputSchema: { required: ['path', 'content'] } }] })).not.toEqual(first)
  })

  it('缺少路径/profile/权限版本或重复工具名时 fail closed', () => {
    expect(() => createContinuationSafetySnapshot({ workDirProfileId: '', workDir: '/project', authorizationVersion: 'v1', tools: [] })).toThrow('CONTINUATION_SAFETY_SNAPSHOT_INCOMPLETE')
    expect(() => createContinuationSafetySnapshot({ workDirProfileId: 'p', workDir: '/project', authorizationVersion: 'v1', tools: [{ name: 'x', inputSchema: {} }, { name: 'x', inputSchema: {} }] })).toThrow('CONTINUATION_TOOL_SNAPSHOT_INVALID')
  })
})
