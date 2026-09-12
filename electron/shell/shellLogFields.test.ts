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

})
