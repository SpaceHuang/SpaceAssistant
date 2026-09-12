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

  it('进程结果的新增编码/诊断字段到达 agent 侧，且路径降级为 artifactId（§9.4/§10.4）', () => {
    const result = {
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      data: {
        status: 'failed',
        exitCode: 4294901760,
        exitCodeHint: 'Windows 宿主进程初始化失败（0xFFFF0000）',
        exitCodeFamily: 'windows-host',
        exitCodeSemantics: 'WINDOWS_HOST_INIT_FAILED',
        exitCodeAdvice: ['改用 run_script 执行同一命令'],
        hresult: { code: '0x8009001D', name: 'NTE_PROVIDER_DLL_FAIL', meaning: '加密服务提供程序 DLL 加载或初始化失败', advice: ['重试一次'] },
        stdout: 'ok',
        stdoutBytes: 2,
        stdoutRawBytes: 2,
        stdoutTextBytes: 2,
        stdoutRawSha256: 'd'.repeat(64),
        stderrBytes: 104,
        stderrRawBytes: 136,
        stderrTextBytes: 104,
        stderrRawSha256: 'e'.repeat(64),
        decodeReplacements: 0,
        decode: {
          stdout: { encoding: 'utf-8', source: 'strict-utf8', confidence: 'high', replacements: 0, suspect: false },
          stderr: { encoding: 'utf-16le', source: 'utf16-pattern', confidence: 'high', replacements: 0, suspect: false },
          contractConflict: 'contract-mismatch',
          lossStage: undefined
        },
        outputTrust: 'ok',
        outputDiag: ['[output-diag] stream=stderr encoding=utf-16le source=utf16-pattern confidence=high replacements=0 contract=oem conflict=contract-mismatch suspect=false rawArtifact=none'],
        contract: { kind: 'oem', codepage: 936 },
        rawArtifact: { path: '/tmp/shell-output/' + 'f'.repeat(64) + '.log', bytes: 136, rawBytes: 136, omittedBytes: 0, truncated: false, sha256: 'a'.repeat(64), suspect: false, note: 'unredacted' },
        outputArtifactReason: 'failed',
        planMs: 3,
        spawnToExitMs: 124,
        durationMs: 200,
        planDigest: 'b'.repeat(64),
        processResult: null
      }
    }
    const projected = projectAgentToolResultForSink(result, { processTool: true }) as { data: Record<string, any> }
    expect(projected.data.decode.stderr).toMatchObject({ encoding: 'utf-16le', source: 'utf16-pattern', replacements: 0, suspect: false })
    expect(projected.data.decode.contractConflict).toBe('contract-mismatch')
    expect(projected.data.outputTrust).toBe('ok')
    expect(projected.data.stderrRawBytes).toBe(136)
    expect(projected.data.stderrTextBytes).toBe(104)
    expect(projected.data.hresult).toMatchObject({ code: '0x8009001D', name: 'NTE_PROVIDER_DLL_FAIL' })
    expect(projected.data.exitCodeFamily).toBe('windows-host')
    expect(projected.data.exitCodeAdvice).toEqual(['改用 run_script 执行同一命令'])
    expect(projected.data.contract).toEqual({ kind: 'oem', codepage: 936 })
    expect(projected.data.outputArtifactReason).toBe('failed')
    expect(projected.data.planMs).toBe(3)
    expect(projected.data.spawnToExitMs).toBe(124)
    expect(projected.data.outputDiag.length).toBe(1)
    // 绝对路径不得进入 agent 侧：只暴露 artifactId（与 persistedOutputPath 同规则）
    expect(projected.data.rawArtifact.path).toBeUndefined()
    expect(projected.data.rawArtifact.artifactId).toBe('artifact-' + 'f'.repeat(64))
    expect(JSON.stringify(projected.data.rawArtifact)).not.toContain('/tmp/')
  })

  it('M2：outputDiag 行里的 rawArtifact 绝对路径在投影层再次降级', () => {
    const result = {
      success: true,
      data: {
        status: 'succeeded',
        processResult: null,
        stdout: 'ok',
        outputDiag: [
          '[output-diag] stream=stdout encoding=gbk source=contract confidence=high replacements=0 contract=oem:936 conflict=none suspect=false rawArtifact=C:\\Users\\alice\\AppData\\Roaming\\SpaceAssistant\\shell-output\\' + 'c'.repeat(64) + '.log',
          '[output-diag] stream=stderr encoding=gbk source=contract confidence=high replacements=0 contract=oem:936 conflict=none suspect=false rawArtifact=/home/alice/tmp.log'
        ]
      }
    }
    const projected = projectAgentToolResultForSink(result, { processTool: true }) as { data: Record<string, any> }
    const lines = projected.data.outputDiag as string[]
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain('rawArtifact=artifact-' + 'c'.repeat(64))
    expect(lines[1]).toContain('rawArtifact=artifact-redacted')
    expect(JSON.stringify(lines)).not.toContain('alice')
    expect(JSON.stringify(lines)).not.toContain('C:\\')
  })

  it('不可信的编码/诊断字段被丢弃（枚举与哈希白名单）', () => {
    const result = {
      success: true,
      data: {
        status: 'succeeded',
        processResult: null,
        decode: { stdout: { encoding: 'not a label!!', confidence: 'ultra', source: 'magic', replacements: 'x', suspect: 'yes' } },
        outputTrust: 'maybe',
        contractConflict: 'mismatch',
        contract: { kind: 'cp936' },
        stdoutRawSha256: 'not-a-hash',
        rawArtifact: { path: 'x', bytes: 1, sha256: 'nope', note: 'redacted' },
        outputArtifactReason: 'because',
        outputDiag: ['rm -rf /']
      }
    }
    const projected = projectAgentToolResultForSink(result, { processTool: true }) as { data: Record<string, any> }
    expect(projected.data.decode).toBeUndefined()
    expect(projected.data.outputTrust).toBeUndefined()
    expect(projected.data.contractConflict).toBeUndefined()
    expect(projected.data.contract).toBeUndefined()
    expect(projected.data.stdoutRawSha256).toBeUndefined()
    expect(projected.data.outputArtifactReason).toBeUndefined()
    expect(projected.data.outputDiag).toBeUndefined()
    expect(projected.data.rawArtifact).toEqual({ bytes: 1, artifactId: 'artifact-redacted' })
  })


  it('MINOR：telemetry sink 不落 hresult/exitCodeAdvice 的自由文本', () => {
    const result = {
      success: true,
      data: {
        status: 'failed',
        processResult: null,
        exitCodeAdvice: ['检查 PATH 是否包含目标目录'],
        hresult: {
          code: '0x80070002',
          meaning: '系统找不到指定的文件',
          advice: ['确认路径拼写']
        }
      }
    }
    const telemetry = projectTelemetryToolResult(result, { ...options, processTool: true }) as { data: Record<string, any> }
    expect(telemetry.data.exitCodeAdvice).toBeUndefined()
    expect(telemetry.data.hresult).toMatchObject({ code: '0x80070002' })
    expect(telemetry.data.hresult.meaning).toBeUndefined()
    expect(telemetry.data.hresult.advice).toBeUndefined()

    const agent = projectAgentToolResultForSink(result, { ...options, processTool: true }) as { data: Record<string, any> }
    expect(agent.data.exitCodeAdvice).toEqual(['检查 PATH 是否包含目标目录'])
    expect(agent.data.hresult.meaning).toBe('系统找不到指定的文件')
  })

  it('MINOR：非法形态的 signals 不再为 reason 打开通道', () => {
    const result = {
      success: true,
      data: {
        status: 'succeeded',
        processResult: null,
        stdout: 'x',
        signals: [{ injected: true }],
        reason: '不该进模型的自由文本'
      }
    }
    const projected = projectAgentToolResultForSink(result, { processTool: true }) as { data: Record<string, any> }
    expect(projected.data.signals).toBeUndefined()
    expect(projected.data.reason).toBeUndefined()
  })

  it('方言错配计划错误的 signals/hints 能到达模型，且 telemetry 不落自由文本（§10.3 / T17）', () => {
    const result = {
      success: false,
      error: 'SHELL_DIALECT_MISMATCH',
      userMessage: 'SHELL_DIALECT_MISMATCH',
      data: {
        code: 'SHELL_DIALECT_MISMATCH',
        detectedSyntax: 'posix-bash',
        expectedDialect: 'windows-powershell',
        shellProfileId: 'builtin-windows-powershell',
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        signals: ['posix-operator', 'posix-export'],
        hints: ['使用 PowerShell 语法重写命令', '环境变量使用 $env:NAME，空输出使用 $null'],
        reason: '命令包含 POSIX 专有语法',
        processResult: null
      }
    }
    const projected = projectAgentToolResultForSink(result, { ...options, processTool: true })
    const data = projected.data as Record<string, unknown>
    expect(data.signals).toEqual(['posix-operator', 'posix-export'])
    expect(data.hints).toEqual(['使用 PowerShell 语法重写命令', '环境变量使用 $env:NAME，空输出使用 $null'])
    expect(data.detectedSyntax).toBe('posix-bash')
    expect(data.expectedDialect).toBe('windows-powershell')
    expect(data.shellProfileId).toBe('builtin-windows-powershell')
    // processResult=null（计划阶段失败，没有进程事实）时按既有规则不暴露 executable
    expect(data.executable).toBeUndefined()
    const telemetry = projectTelemetryToolResult(result, { ...options, processTool: true })
    const telemetryData = telemetry.data as Record<string, unknown>
    expect(telemetryData.signals).toEqual(['posix-operator', 'posix-export'])
    expect(telemetryData.hints).toBeUndefined()
    expect(telemetryData.reason).toBeUndefined()
  })

  it('普通进程结果的 reason 被丢弃，只有计划期诊断才转发（§10.3 回归）', () => {
    const planError = projectAgentToolResultForSink({
      success: false,
      error: 'SHELL_DIALECT_MISMATCH',
      data: {
        code: 'SHELL_DIALECT_MISMATCH',
        processResult: null,
        expectedDialect: 'windows-powershell',
        reason: '命令包含 POSIX 专有语法'
      }
    }, { ...options, processTool: true })
    expect((planError.data as Record<string, unknown>).reason).toBe('命令包含 POSIX 专有语法')

    const spawnFailure = projectAgentToolResultForSink({
      success: false,
      error: 'TOOL_EXECUTION_FAILED',
      data: {
        status: 'spawn_failed',
        processResult: null,
        reason: 'raw diagnostic /Users/Alice/private'
      }
    }, { ...options, processTool: true })
    const spawnData = spawnFailure.data as Record<string, unknown>
    expect(spawnData).toEqual({ status: 'spawn_failed', processResult: null })
    expect(spawnData.reason).toBeUndefined()
  })

  it('signals/hints 的非数组或非法形态被丢弃（§10.3 注入面控制）', () => {
    const projected = projectAgentToolResultForSink({
      success: false,
      error: 'SHELL_DIALECT_MISMATCH',
      data: {
        code: 'SHELL_DIALECT_MISMATCH',
        processResult: null,
        signals: 'posix-operator',
        hints: '使用 PowerShell 语法重写命令',
        shellProfileId: 'bad id with spaces',
        detectedSyntax: 'POSIX-BASH!',
        reason: 42
      }
    }, { ...options, processTool: true }) as { data: Record<string, unknown> }
    expect(projected.data.signals).toBeUndefined()
    expect(projected.data.hints).toBeUndefined()
    expect(projected.data.shellProfileId).toBeUndefined()
    expect(projected.data.detectedSyntax).toBeUndefined()
    expect(projected.data.reason).toBeUndefined()
  })

})
