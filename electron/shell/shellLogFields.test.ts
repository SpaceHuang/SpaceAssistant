import { describe, expect, it } from 'vitest'
import { projectShellAgentLogFields } from './shellLogFields'

describe('shellLogFields', () => {
  it('只保留指纹和元数据，不保留命令或输出预览', () => {
    const out = projectShellAgentLogFields('shell.exec.start', {
      command: 'curl --token raw-secret /Users/Alice/private file',
      stdout: 'token=raw-secret',
      stderr: '/etc/passwd:1:2',
      cwd: '/Users/Alice/private project',
      description: 'test run'
    })
    expect(out.command).toBeUndefined()
    expect(out.invocationFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(out.stdout).toBeUndefined()
    expect(out.stdoutPreview).toBeUndefined()
    expect(out.stdoutBytes).toBe(16)
    expect(out.stdoutSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out.cwd).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('raw-secret')
    expect(JSON.stringify(out)).not.toContain('/etc/passwd')
  })

  it('拒绝、确认和路径事件中的原始命令只变为 invocationFingerprint', () => {
    const out = projectShellAgentLogFields('shell.security.deny', {
      command: 'echo raw-secret /Users/Alice/private project',
      reason: '危险命令包含原始诊断文本',
      userAction: 'blocked'
    })
    expect(out.command).toBeUndefined()
    expect(out.invocationFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(out)).not.toContain('raw-secret')
    expect(JSON.stringify(out)).not.toContain('/Users/Alice')
    expect(out.reason).toBeUndefined()
  })
})
