import { describe, expect, it } from 'vitest'
import {
  projectAgentToolResultForSink,
  projectLocalHistoryToolResult,
  projectTelemetryToolResult,
  type ProcessProjectionOptions
} from './processResultProjection'

const options: ProcessProjectionOptions = {
  workspaceRoot: '/Users/alice/project'
}

describe('process result projections', () => {
  it('给 Agent 保留可解释的系统路径，并将 workspace 路径转换为相对路径', () => {
    const result = {
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      data: {
        status: 'failed',
        exitCode: 1,
        cwd: '/Users/alice/project',
        executable: '/usr/bin/python3',
        stderr: '/Users/alice/project/src/app.py:37:4: missing import',
        command: 'python3 src/app.py'
      }
    }
    const projected = projectAgentToolResultForSink(result, { ...options, processTool: true })

    expect(projected.data).toMatchObject({
      cwd: '.',
      executable: '/usr/bin/python3'
    })
    expect(projected.data).not.toHaveProperty('command')
    expect((projected.data as Record<string, unknown>).stderr).toContain('<path:redacted>:37:4')
    expect(projectLocalHistoryToolResult(result, { ...options, processTool: true })).toEqual(projected)
  })

  it('对 workspace 外路径只保留有限诊断信息，不暴露宿主路径主体', () => {
    const projected = projectAgentToolResultForSink({
      success: false,
      data: {
        status: 'spawn_failed',
        cwd: '/Users/alice/customer-data',
        executable: '/Users/alice/.local/bin/private-tool',
        stderr: 'cannot open /Users/alice/customer-data/secret.csv'
      }
    }, { ...options, processTool: true })

    const data = projected.data as Record<string, unknown>
    expect(data.cwd).toBeUndefined()
    expect(data.executable).toBe('private-tool')
    expect(String(data.stderr)).not.toContain('/Users/alice/customer-data')
    expect(String(data.stderr)).toContain('<path:redacted>')
  })

  it('telemetry 只输出稳定结构化字段和不可逆指纹', () => {
    const projected = projectTelemetryToolResult({
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      userMessage: '命令执行失败',
      data: {
        status: 'failed',
        exitCode: 2,
        cwd: '/Users/alice/project',
        executable: '/usr/bin/python3',
        stdout: 'token=raw-secret',
        stderr: 'failed at /Users/alice/project/app.py:8',
        stdoutBytes: 17,
        stderrBytes: 40,
        stdoutSha256: 'a'.repeat(64),
        stderrSha256: 'b'.repeat(64),
        command: 'deploy --token raw-secret',
        script: 'print("raw-secret")',
        environment: { API_TOKEN: 'raw-secret' }
      }
    }, { ...options, processTool: true })

    expect(projected).toEqual({
      ok: false,
      errorCode: 'SHELL_PROCESS_EXIT',
      data: {
        status: 'failed',
        exitCode: 2,
        stdoutBytes: 17,
        stderrBytes: 40,
        stdoutSha256: 'a'.repeat(64),
        stderrSha256: 'b'.repeat(64),
        cwdScope: 'workspace',
        cwdFingerprint: expect.any(String),
        executableScope: 'system',
        executableFingerprint: expect.any(String)
      }
    })
    expect(JSON.stringify(projected)).not.toContain('raw-secret')
    expect(JSON.stringify(projected)).not.toContain('/Users/alice')
    expect(JSON.stringify(projected)).not.toContain('/usr/bin/python3')
  })

  it('未知 diagnostic 字段不会进入任何出口', () => {
    const projected = projectAgentToolResultForSink({
      success: false,
      diagnostic: {
        caseId: 'SHELL_PROCESS_EXIT',
        retryable: false,
        category: 'command',
        stack: '/Users/alice/project/index.ts:1',
        cause: { secret: 'raw-secret' },
        rawDump: 'raw-secret'
      },
      data: null
    }, options)

    expect(projected.diagnostic).toEqual({
      caseId: 'SHELL_PROCESS_EXIT',
      retryable: false,
      category: 'command'
    })
  })

  it('Agent 输出有界且会阻断私钥块', () => {
    const projected = projectAgentToolResultForSink({
      success: true,
      data: {
        status: 'succeeded',
        stdout: `${'x'.repeat(100)}\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----`
      }
    }, { ...options, maxOutputChars: 40, processTool: true })

    const data = projected.data as Record<string, unknown>
    expect(String(data.stdout)).not.toContain('PRIVATE KEY')
    expect(String(data.stdout)).not.toContain('private')
    expect(String(data.stdout).length).toBeLessThan(80)
    expect(data.truncated).toBe(true)
  })

  it('所有显式出口遇到循环数据都稳定降级而不抛异常', () => {
    const data: Record<string, unknown> = { status: 'failed' }
    data.self = data
    const result = { success: false, error: 'SHELL_PROCESS_EXIT', data }

    const processOptions = { processTool: true }
    expect(projectAgentToolResultForSink(result, processOptions)).toMatchObject({ error: 'SHELL_RESULT_SERIALIZATION_FAILED', data: null })
    expect(projectLocalHistoryToolResult(result, processOptions)).toMatchObject({ error: 'SHELL_RESULT_SERIALIZATION_FAILED', data: null })
    expect(projectTelemetryToolResult(result, processOptions)).toEqual({ ok: false, errorCode: 'SHELL_RESULT_SERIALIZATION_FAILED', data: null })
  })

  it('普通工具和 MCP 结果不触发进程终态校验，也不丢弃业务字段', () => {
    const result = {
      success: true,
      data: {
        status: 'failed',
        stdout: 'ticket created',
        code: 'INC-42',
        cwd: 'relative/service',
        issueId: 'INC-42',
        summary: 'created successfully'
      }
    }

    expect(projectAgentToolResultForSink(result, options)).toEqual(result)
    expect(projectLocalHistoryToolResult(result, options)).toEqual(result)

    const connectedResult = {
      success: true,
      data: {
        status: 'connected',
        stdout: 'ready',
        code: 'OK',
        issueId: 'INC-43'
      }
    }
    expect(projectAgentToolResultForSink(connectedResult, options)).toEqual(connectedResult)
    expect(projectLocalHistoryToolResult(connectedResult, options)).toEqual(connectedResult)
  })

  it('只对真正像凭据的键脱敏，不误伤 key / keys / keyCode / monkey', () => {
    const result = {
      success: true,
      data: {
        key: 'Enter',
        keys: ['Enter', 'Escape'],
        keyCode: 13,
        monkey: 'banana',
        sessionId: 'session-123'
      }
    }
    expect(projectAgentToolResultForSink(result, options)).toEqual(result)
    expect(projectLocalHistoryToolResult(result, options)).toEqual(result)
  })

  it('凭据键名与看起来像凭据的裸 key 值仍被脱敏', () => {
    const projected = projectAgentToolResultForSink({
      success: true,
      data: {
        apiKey: 'sk-abcdefghijklmnop',
        accessToken: 'opaque-access-token',
        clientSecret: 'opaque-client-secret',
        userPassword: 'hunter2',
        'set-cookie': 'session=abc',
        key: 'sk-live-abcdefghijklmnop',
        keys: ['ghp_0123456789012345678901']
      }
    }, options) as { data: Record<string, unknown> }

    expect(projected.data).toEqual({
      apiKey: '<secret:redacted>',
      accessToken: '<secret:redacted>',
      clientSecret: '<secret:redacted>',
      userPassword: '<secret:redacted>',
      'set-cookie': '<secret:redacted>',
      key: '<secret:redacted>',
      keys: '<secret:redacted>'
    })
  })
})
