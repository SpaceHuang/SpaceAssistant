import { describe, expect, it } from 'vitest'
import {
  SHELL_OUTPUT_TRUST_SUSPECT_NOTICE,
  needsOutputTrustNotice,
  parseShellResultData
} from './shellToolDisplay'

describe('parseShellResultData', () => {
  it('保留生命周期、输出 artifact 和终止确认字段', () => {
    expect(parseShellResultData({
      status: 'timed_out', signal: 'SIGTERM', terminationReason: 'timeout', treeKillVerified: true,
      durationMs: 123, stdoutBytes: 10, stderrBytes: 2, outputArtifactBytes: 12,
      outputArtifactSha256: 'a'.repeat(64), caseId: 'SHELL-LIFECYCLE-001'
    })).toMatchObject({ status: 'timed_out', signal: 'SIGTERM', treeKillVerified: true, outputArtifactBytes: 12 })
  })

  it('拒绝未知 status 和错误类型字段', () => {
    const result = parseShellResultData({ status: 'unknown', durationMs: '123', treeKillVerified: 'yes' })
    expect(result?.status).toBeUndefined()
    expect(result?.durationMs).toBeUndefined()
    expect(result?.treeKillVerified).toBeUndefined()
  })

  it('保留 outputTrust 与编码/字节口径诊断字段（§9.5/§10.4）', () => {
    const parsed = parseShellResultData({
      outputTrust: 'suspect',
      stdoutEncoding: 'utf-16le',
      stderrEncoding: 'gbk',
      stdoutRawBytes: 136,
      stderrRawBytes: 0,
      stdoutTextBytes: 104,
      stderrTextBytes: 0,
      decodeReplacements: 0,
      lossStage: 'host',
      outputArtifactReason: 'failed',
      exitCodeFamily: 'windows-host',
      exitCodeSemantics: 'WINDOWS_HOST_INIT_FAILED',
      hresult: { code: '0x8009001D', name: 'NTE_PROVIDER_DLL_FAIL', advice: ['改用 run_script 重试'] }
    })
    expect(parsed).toMatchObject({
      outputTrust: 'suspect',
      stdoutRawBytes: 136,
      stdoutTextBytes: 104,
      decodeReplacements: 0,
      lossStage: 'host',
      outputArtifactReason: 'failed',
      exitCodeFamily: 'windows-host',
      hresult: { code: '0x8009001D', name: 'NTE_PROVIDER_DLL_FAIL' }
    })
    expect(parsed?.hresult?.advice).toEqual(['改用 run_script 重试'])
  })

  it('拒绝非法 outputTrust / lossStage / hresult 形态', () => {
    const parsed = parseShellResultData({ outputTrust: 'unknown', lossStage: 'decoder', hresult: { code: 42 } })
    expect(parsed?.outputTrust).toBeUndefined()
    expect(parsed?.lossStage).toBeUndefined()
    expect(parsed?.hresult).toBeUndefined()
  })
})

describe('needsOutputTrustNotice（§10.4）', () => {
  it('仅 outputTrust=suspect 需要提示', () => {
    expect(needsOutputTrustNotice({ outputTrust: 'suspect' })).toBe(true)
    expect(needsOutputTrustNotice({ outputTrust: 'ok' })).toBe(false)
    expect(needsOutputTrustNotice({})).toBe(false)
    expect(needsOutputTrustNotice(undefined)).toBe(false)
  })

  it('提示文案点明「原始字节已保存」', () => {
    expect(SHELL_OUTPUT_TRUST_SUSPECT_NOTICE).toContain('输出编码可疑')
    expect(SHELL_OUTPUT_TRUST_SUSPECT_NOTICE).toContain('原始字节')
  })
})
