import { describe, expect, it } from 'vitest'
import { projectProcessResultForAgentLog } from './agentSafeProjection'

describe('projectProcessResultForAgentLog', () => {
  it('只保留显式允许的进程元数据', () => {
    const source: Record<string, unknown> = {
      status: 'failed',
      errorCode: 'SHELL_PROCESS_EXIT',
      caseId: 'process_exit',
      exitCode: 2,
      signal: null,
      durationMs: 12,
      stdoutBytes: 10,
      stderrBytes: 20,
      stdoutSha256: 'a'.repeat(64),
      stderrSha256: 'b'.repeat(64),
      command: 'curl --token secret https://example.com',
      code: 'print("secret")',
      cwd: '/Users/Alice/private project',
      executable: '/usr/bin/python3',
      stdout: 'token=secret',
      stderr: '/etc/passwd:1:2',
      arbitrary: { secret: 'must disappear' }
    }
    const projected = projectProcessResultForAgentLog(source)
    expect(projected).toMatchObject({
      status: 'failed',
      errorCode: 'SHELL_PROCESS_EXIT',
      caseId: 'process_exit',
      exitCode: 2,
      signal: null,
      durationMs: 12,
      stdoutBytes: 10,
      stderrBytes: 20,
      stdoutSha256: 'a'.repeat(64),
      stderrSha256: 'b'.repeat(64)
    })
    expect(projected).toMatchObject({
      cwdScope: 'external',
      executableScope: 'system'
    })
    expect(projected).not.toHaveProperty('cwd')
    expect(projected).not.toHaveProperty('executable')
  })

  it('未知循环、Error 和深层对象不会抛出或穿透', () => {
    const source: Record<string, unknown> = { status: 'failed' }
    source.circular = source
    source.error = new Error('/Users/Alice/token=secret')
    expect(() => projectProcessResultForAgentLog(source)).not.toThrow()
    expect(projectProcessResultForAgentLog(source)).toEqual({ status: 'failed' })
  })
})
