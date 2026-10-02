import { describe, expect, it } from 'vitest'
import { assertContinuationExecutionConfigUnchanged, createContinuationSafetySnapshot, fingerprintContinuationExecutionConfig } from './continuationSafetySnapshot'

describe('continuation safety snapshot', () => {
  it('只保留工作目录和工具边界指纹，不泄露路径', () => {
    const snapshot = createContinuationSafetySnapshot({
      workDirProfileId: 'profile-1', workDir: '/Users/alice/private-project', authorizationVersion: 'policy-v1',
      tools: [{ name: 'edit_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }], executionConfigFingerprint: 'a'.repeat(64)
    })
    expect(snapshot.workDirProfileId).toBe('profile-1')
    expect(snapshot.workDirSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(snapshot)).not.toContain('/Users/alice')
  })

  it('工作目录、权限版本或工具 schema 改变时指纹随之改变', () => {
    const base = { workDirProfileId: 'profile-1', workDir: '/project', authorizationVersion: 'policy-v1', tools: [{ name: 'edit_file', inputSchema: { required: ['path'] } }], executionConfigFingerprint: 'a'.repeat(64) }
    const first = createContinuationSafetySnapshot(base)
    expect(createContinuationSafetySnapshot({ ...base, workDir: '/other' })).not.toEqual(first)
    expect(createContinuationSafetySnapshot({ ...base, authorizationVersion: 'policy-v2' })).not.toEqual(first)
    expect(createContinuationSafetySnapshot({ ...base, tools: [{ name: 'edit_file', inputSchema: { required: ['path', 'content'] } }] })).not.toEqual(first)
    expect(createContinuationSafetySnapshot({ ...base, executionConfigFingerprint: 'b'.repeat(64) })).not.toEqual(first)
  })

  it('同名同 schema 的 MCP 工具切换后端，执行配置指纹改变且不暴露后端明文', () => {
    const first = fingerprintContinuationExecutionConfig({ toolsConfig: {}, browserConfig: {}, shellConfig: {}, mcpBackends: [{ id: 'server', endpoint: 'https://private.example/a?token=secret' }] })
    const changed = fingerprintContinuationExecutionConfig({ toolsConfig: {}, browserConfig: {}, shellConfig: {}, mcpBackends: [{ id: 'server', endpoint: 'https://private.example/b?token=secret' }] })
    expect(changed).not.toBe(first)
    expect(JSON.stringify({ first, changed })).not.toContain('private.example')
    expect(JSON.stringify({ first, changed })).not.toContain('secret')
    expect(() => assertContinuationExecutionConfigUnchanged(first, changed)).toThrow('CONTINUATION_EXECUTION_CONFIG_CHANGED')
  })

  it('缺少路径/profile/权限版本或重复工具名时 fail closed', () => {
    expect(() => createContinuationSafetySnapshot({ workDirProfileId: '', workDir: '/project', authorizationVersion: 'v1', tools: [], executionConfigFingerprint: 'a'.repeat(64) })).toThrow('CONTINUATION_SAFETY_SNAPSHOT_INCOMPLETE')
    expect(() => createContinuationSafetySnapshot({ workDirProfileId: 'p', workDir: '/project', authorizationVersion: 'v1', tools: [{ name: 'x', inputSchema: {} }, { name: 'x', inputSchema: {} }], executionConfigFingerprint: 'a'.repeat(64) })).toThrow('CONTINUATION_TOOL_SNAPSHOT_INVALID')
  })
})
