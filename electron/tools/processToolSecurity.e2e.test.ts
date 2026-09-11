import { describe, expect, it } from 'vitest'
import { projectAgentLogFields } from '../agentLogger/agentLogProjection'
import { projectAgentToolResult, serializeAgentToolResult } from '../../src/shared/agentToolResult'
import { assertNoSensitiveValues } from '../../src/shared/testSupport/leakAssertions'
import { createAgentLogCapture } from '../testSupport/agentLogCapture'

const SECRET = 'token=raw-secret'
const HOST_PATH = '/Users/Alice/private project'

function checkAllBoundaries(result: Parameters<typeof projectAgentToolResult>[0]): void {
  const external = projectAgentToolResult(result, { processTool: true })
  const realtime = serializeAgentToolResult(result, { processTool: true })
  const historical = serializeAgentToolResult(external, { processTool: true })
  const logs = projectAgentLogFields('tool.result', {
    toolName: 'run_shell',
    data: result.data,
    error: result.error,
    stdout: typeof result.data === 'object' && result.data ? (result.data as Record<string, unknown>).stdout : undefined
  })
  const capture = createAgentLogCapture()
  capture.record('info', 'tool.result', logs)
  const all = `${JSON.stringify(external)}\n${realtime}\n${historical}\n${capture.serialized()}`
  assertNoSensitiveValues(all, [SECRET, HOST_PATH, '/usr/bin/python', 'private file.txt'])
}

describe('process tool security boundary', () => {
  it('普通工具日志保留合法业务数据，不套用进程字段投影', () => {
    const logs = projectAgentLogFields('tool.result', {
      toolName: 'mcp_incident',
      success: true,
      data: {
        status: 'failed',
        stdout: 'ticket created',
        code: 'INC-42',
        issueId: 'INC-42'
      }
    })

    expect(logs.data).toEqual({
      status: 'failed',
      stdout: 'ticket created',
      code: 'INC-42',
      issueId: 'INC-42'
    })
  })

  it('successful shell keeps exit metadata but never exposes command output secrets', () => {
    const result = {
      success: true,
      data: {
        status: 'succeeded',
        exitCode: 0,
        stdout: `${SECRET}\npath=${HOST_PATH}`,
        stderr: ''
      }
    }
    checkAllBoundaries(result)
    expect(JSON.parse(serializeAgentToolResult(result, { processTool: true })).data.exitCode).toBe(0)
  })

  it('failed shell preserves error code and traceback location only', () => {
    const result = {
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      userMessage: '命令失败',
      data: { status: 'failed', exitCode: 2, stderr: `File "${HOST_PATH}/app.py", line 37: ${SECRET}` }
    }
    checkAllBoundaries(result)
    const payload = JSON.parse(serializeAgentToolResult(result, { processTool: true }))
    expect(payload.error).toBe('SHELL_PROCESS_EXIT')
    expect(payload.data.stderr).toContain('line 37')
  })

  it('script source, spawn executable and artifact filename remain outside external boundaries', () => {
    const result = {
      success: false,
      error: 'SCRIPT_SPAWN_ERROR',
      data: {
        status: 'spawn_failed',
        processResult: null,
        code: `print('${SECRET}')`,
        executable: '/usr/bin/python',
        persistedOutputPath: `${HOST_PATH}/customer-token-private.log`
      }
    }
    checkAllBoundaries(result)
    const payload = JSON.parse(serializeAgentToolResult(result, { processTool: true }))
    expect(payload.data.code).toBeUndefined()
    expect(payload.data.executable).toBeUndefined()
    expect(payload.data.artifactId).not.toContain('customer-token-private')
  })

  it('circular external result returns stable failure instead of throwing', () => {
    const data: Record<string, unknown> = { status: 'failed', processResult: null }
    data.self = data
    expect(() => checkAllBoundaries({ success: false, error: 'SHELL_PROCESS_EXIT', data })).not.toThrow()
  })
})
