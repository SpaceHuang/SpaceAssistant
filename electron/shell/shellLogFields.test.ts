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

  it('shell.exec.finish 的编码/字节/留档字段不被 allowlist 静默丢弃（§10.5）', () => {
    const out = projectShellAgentLogFields('shell.exec.finish', {
      exitCode: 4294901760,
      stdoutEncoding: 'gbk',
      stderrEncoding: 'utf-16le',
      encodingSource: 'utf16-pattern',
      encodingConfidence: 'high',
      contractKind: 'oem',
      contractConflict: 'contract-mismatch',
      outputTrust: 'ok',
      outputDiag: ['[output-diag] stream=stderr encoding=utf-16le source=utf16-pattern confidence=high replacements=0 contract=oem conflict=contract-mismatch suspect=false rawArtifact=none'],
      decodeReplacements: 0,
      stdoutRawBytes: 10,
      stderrRawBytes: 136,
      stdoutTextBytes: 10,
      stderrTextBytes: 104,
      stdoutRawSha256: 'a'.repeat(64),
      stderrRawSha256: 'b'.repeat(64),
      rawArtifactPath: 'C:\\\\d\\\\shell-output\\\\deadbeef.log',
      rawArtifactBytes: 136,
      rawArtifactSha256: 'c'.repeat(64),
      rawArtifactReason: 'failed',
      outputPersistError: 'artifact directory is not writable',
      outputArtifactReason: 'failed',
      exitCodeFamily: 'windows-host',
      exitCodeSemantics: 'WINDOWS_HOST_INIT_FAILED',
      planMs: 3,
      spawnToExitMs: 124,
      lossStage: undefined
    })
    expect(out.stderrRawBytes).toBe(136)
    expect(out.stderrEncoding).toBe('utf-16le')
    expect(out.encodingSource).toBe('utf16-pattern')
    expect(out.contractConflict).toBe('contract-mismatch')
    expect(out.outputTrust).toBe('ok')
    expect(out.rawArtifactReason).toBe('failed')
    // MINOR: artifact 落盘失败的原因不能被白名单静默丢弃
    expect(out.outputPersistError).toBe('artifact directory is not writable')
    expect(out.spawnToExitMs).toBe(124)
    expect(out.lossStage).toBeUndefined()
    expect(Array.isArray(out.outputDiag)).toBe(true)
  })

  // ===== P0-B：诊断字段进得了日志（回归 D2，§7.1 #3；§5.2 验收断言）=====
  it('shell.exec.finish 保留 hresult / exitCodeAdvice / degradedFrom（数组形态正确）', () => {
    const out = projectShellAgentLogFields('shell.exec.finish', {
      exitCode: 4294901760,
      exitCodeHint: 'Windows 宿主进程初始化失败（0xFFFF0000）',
      hresult: {
        code: '0x8009001D',
        name: 'NTE_PROVIDER_DLL_FAIL',
        meaning: '加密服务提供程序 DLL 加载或初始化失败',
        advice: ['疑似宿主机安全/加密组件拦截；宿主级降级链会自动尝试其他 shell 宿主，无需改写命令']
      },
      exitCodeAdvice: [
        'shell 宿主不可用，属宿主机环境问题，请勿改写命令或改用其他执行工具',
        '稍后重试一次；若持续失败，按诊断字段上报（含 hresult 原文）'
      ],
      degradedFrom: 'builtin-windows-powershell'
    })
    expect(out.hresult).toBeDefined()
    expect((out.hresult as { code?: string }).code).toBe('0x8009001D')
    expect(Array.isArray(out.exitCodeAdvice)).toBe(true)
    expect((out.exitCodeAdvice as string[]).length).toBe(2)
    expect(out.degradedFrom).toBe('builtin-windows-powershell')
  })

  it('P0-B 验收断言：WINDOWS_HOST_INIT_FAILED 失败的 finish 日志可检索到 8009001d', () => {
    const out = projectShellAgentLogFields('shell.exec.finish', {
      hresult: { code: '0x8009001D', name: 'NTE_PROVIDER_DLL_FAIL', meaning: '加密服务提供程序 DLL 加载或初始化失败', advice: [] }
    })
    expect(JSON.stringify(out)).toContain('8009001D')
  })

})
