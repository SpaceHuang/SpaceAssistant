import { describe, expect, it } from 'vitest'
import { projectAgentToolResult, serializeAgentToolResult } from './agentToolResult'

describe('serializeAgentToolResult', () => {
  it('失败结果使用稳定 JSON envelope，并保留 data', () => {
    expect(JSON.parse(serializeAgentToolResult({
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      userMessage: '命令执行失败',
      data: { status: 'failed', exitCode: 2 }
    }, { processTool: true }))).toEqual({
      ok: false,
      error: 'SHELL_PROCESS_EXIT',
      userMessage: '命令执行失败',
      data: { status: 'failed', exitCode: 2 }
    })
  })

  it('保留 diagnostic 机器字段', () => {
    const payload = JSON.parse(serializeAgentToolResult({ success: false, error: 'X', diagnostic: { caseId: 'c', retryable: false }, data: null }))
    expect(payload.diagnostic).toEqual({ caseId: 'c', retryable: false })
  })

  it('diagnostic 只保留 allowlist 字段并丢弃异常详情', () => {
    const payload = JSON.parse(serializeAgentToolResult({
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      diagnostic: {
        caseId: 'c',
        retryable: false,
        category: 'executor',
        stack: 'at secret(/Users/Alice/private.ts:1:1)',
        cause: { rawDump: 'password=raw-secret' },
        message: 'internal detail',
        arbitrary: 'unclassified diagnostic'
      },
      data: null
    }))
    expect(payload.diagnostic).toEqual({ caseId: 'c', retryable: false, category: 'executor' })
    expect(JSON.stringify(payload)).not.toContain('raw-secret')
    expect(JSON.stringify(payload)).not.toContain('/Users/Alice')
  })

  it('无进程结果明确序列化为 null', () => {
    expect(JSON.parse(serializeAgentToolResult({ success: false, error: 'POLICY_DENIED', data: { processResult: null } }, { processTool: true }))).toMatchObject({
      ok: false,
      data: { processResult: null }
    })
  })

  it('成功纯文本保持终端输出兼容性', () => {
    expect(serializeAgentToolResult({ success: true, data: 'hello\n' })).toBe('hello\n')
  })

  it('成功纯文本不能绕过路径和秘密脱敏', () => {
    const text = serializeAgentToolResult({ success: true, data: '/usr/bin/tool token=raw-secret' })
    expect(text).not.toContain('/usr/bin/tool')
    expect(text).not.toContain('raw-secret')
    expect(text).toContain('<path:redacted>')
  })

  it('不向 Agent 暴露宿主 artifact 绝对路径', () => {
    const payload = JSON.parse(serializeAgentToolResult({ success: false, data: { persistedOutputPath: '/Users/me/.app/shell-output/a.log' } }))
    expect(payload.data.persistedOutputPath).toBeUndefined()
    expect(payload.data.artifactId).toBe('artifact-redacted')
    expect(payload.data.artifactId).not.toContain('a.log')
  })

  it('外部事实投影移除 artifact 路径但保留可展示的安全输出', () => {
    const projected = projectAgentToolResult({
      success: true,
      data: {
        stdout: 'ok',
        persistedOutputPath: '/Users/Alice/.app/shell-output/' + 'a'.repeat(64) + '.log'
      }
    }, { processTool: true })
    expect(projected.data).toEqual({
      stdout: 'ok',
      artifactId: 'artifact-' + 'a'.repeat(64)
    })
    expect(JSON.stringify(projected)).not.toContain('/Users/Alice')
  })

  it('带空格路径和冒号字段不会泄露或吞掉错误信息', () => {
    const text = serializeAgentToolResult({
      success: false,
      error: 'cwd:/Users/Alice Smith/private file.txt: Permission denied',
      data: { message: 'path:/etc/app/config.json error: failed' }
    })
    expect(text).not.toContain('/Users/Alice Smith')
    expect(text).not.toContain('/etc/app/config.json')
    expect(text).toContain('Permission denied')
    expect(text).toContain('error: failed')
  })

  it('进程结果未知字段不会进入 Agent payload，错误保持稳定码', () => {
    const payload = JSON.parse(serializeAgentToolResult({
      success: false,
      error: 'spawn failed at /usr/bin/python token=raw-secret',
      data: {
        status: 'spawn_failed',
        processResult: null,
        reason: 'raw diagnostic /Users/Alice/private',
        executable: '/usr/bin/python',
        arbitrary: 'secret output'
      }
    }, { processTool: true }))
    expect(payload.error).toBe('TOOL_EXECUTION_FAILED')
    expect(payload.data).toEqual({ status: 'spawn_failed', processResult: null })
    expect(JSON.stringify(payload)).not.toContain('/usr/bin/python')
    expect(JSON.stringify(payload)).not.toContain('raw-secret')
  })

  it('递归脱敏 executable、嵌套路径和凭据', () => {
    const text = serializeAgentToolResult({ success: false, data: { executable: '/Users/alice/bin/python', nested: { cwd: 'C:\\Users\\alice\\project', API_KEY: 'secret' } } })
    expect(text).not.toContain('/Users/alice')
    expect(text).not.toContain('C:\\Users\\alice')
    expect(text).not.toContain('"secret"')
  })

  it('脱敏常见 POSIX 绝对路径', () => {
    const text = serializeAgentToolResult({ success: false, data: { paths: ['/usr/local/bin/tool', '/etc/app/credentials.json', '/bin/custom-shell'] } })
    expect(text).not.toContain('/usr/local/bin/tool')
    expect(text).not.toContain('/etc/app/credentials.json')
    expect(text).not.toContain('/bin/custom-shell')
  })

  it('完整脱敏 Windows/UNC 路径且保留 URL 与相对路径', () => {
    const text = serializeAgentToolResult({ success: false, data: { value: 'C:\\Users\\alice\\secret.txt \\\\server\\share\\secret.txt https://example.com/a src/shared/file.ts 1/2' } })
    expect(text).not.toContain('C:\\Users\\alice\\secret.txt')
    expect(text).not.toContain('\\\\server\\share\\secret.txt')
    expect(text).toContain('https://example.com/a')
    expect(text).toContain('src/shared/file.ts')
    expect(text).toContain('1/2')
  })

  it('脱敏带空格路径并保留 traceback 行列号', () => {
    const text = serializeAgentToolResult({ success: false, data: { value: 'File "/Users/Alice Smith/private file.txt", line 37\n/tmp/project/app.py:37:4' } })
    expect(text).not.toContain('Alice Smith/private file.txt')
    expect(text).toContain('line 37')
    expect(text).toContain(':37:4')
  })

  it('循环引用不会抛出，而是返回稳定序列化错误', () => {
    const data: Record<string, unknown> = { status: 'failed' }
    data.self = data
    expect(() => serializeAgentToolResult({ success: false, error: 'X', data })).not.toThrow()
    expect(JSON.parse(serializeAgentToolResult({ success: false, error: 'X', data }))).toMatchObject({
      ok: false,
      error: 'SHELL_RESULT_SERIALIZATION_FAILED',
      data: null
    })
  })

  it('允许不同字段共享同一个对象引用', () => {
    const shared = { value: 'ok' }
    const payload = JSON.parse(serializeAgentToolResult({ success: true, data: { left: shared, right: shared } }))
    expect(payload).toEqual({ ok: true, data: { left: { value: 'ok' }, right: { value: 'ok' } } })
  })

  it('允许数组元素共享同一个对象引用', () => {
    const shared = { value: 'ok' }
    const payload = JSON.parse(serializeAgentToolResult({ success: true, data: [shared, shared] }))
    expect(payload).toEqual({ ok: true, data: [{ value: 'ok' }, { value: 'ok' }] })
  })

  it('超深数据不会触发 RangeError', () => {
    let data: Record<string, unknown> = {}
    const root = data
    for (let i = 0; i < 40; i++) {
      data.next = {}
      data = data.next as Record<string, unknown>
    }
    expect(JSON.parse(serializeAgentToolResult({ success: false, error: 'X', data: root }))).toMatchObject({ error: 'SHELL_RESULT_SERIALIZATION_FAILED' })
  })

  it('普通工具结果保留 status、stdout、code 等合法业务字段', () => {
    const payload = JSON.parse(serializeAgentToolResult({
      success: true,
      data: {
        status: 'failed',
        stdout: 'ticket created',
        code: 'INC-42',
        issueId: 'INC-42'
      }
    }))

    expect(payload).toEqual({
      ok: true,
      data: {
        status: 'failed',
        stdout: 'ticket created',
        code: 'INC-42',
        issueId: 'INC-42'
      }
    })
  })
})
