import { describe, expect, it } from 'vitest'
import { AUTO_CONTRACT, UTF8_CONTRACT, oemContract } from './contracts'
import { detectEncoding } from './detectEncoding'
import { buildStreamDiagnostics, formatOutputDiagLine, resolveLossStage, resolveOutputTrust } from './diagnostics'
import { ACCIDENT_BYTES, GBK_ZH_TEST_BARE_HEX } from './testFixtures'

const WIN = 'win32' as NodeJS.Platform

describe('diagnostics', () => {
  it('事故样本的诊断行可机器读取，且 suspect=false', () => {
    const { meta } = detectEncoding(ACCIDENT_BYTES, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    const diagnostics = buildStreamDiagnostics(meta, 'Windows PowerShell 内部错误。', false)
    expect(diagnostics.replacements).toBe(0)
    expect(diagnostics.suspect).toBe(false)
    const line = formatOutputDiagLine({ stream: 'stderr', diagnostics, contract: oemContract(936) })
    expect(line).toBe(
      '[output-diag] stream=stderr encoding=utf-16le source=utf16-pattern confidence=high replacements=0 contract=oem:936 conflict=none suspect=false rawArtifact=none'
    )
  })

  it('M2：rawArtifact 只输出 artifactId，绝不输出绝对路径', () => {
    const { meta } = detectEncoding(ACCIDENT_BYTES, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    const diagnostics = buildStreamDiagnostics(meta, 'Windows PowerShell 内部错误。', false)
    const hashed = formatOutputDiagLine({
      stream: 'stderr',
      diagnostics,
      contract: oemContract(936),
      rawArtifactPath: 'C:\\Users\\alice\\AppData\\Roaming\\SpaceAssistant\\shell-output\\' + 'a'.repeat(64) + '.log'
    })
    expect(hashed).toContain('rawArtifact=artifact-' + 'a'.repeat(64))
    expect(hashed).not.toContain('Users')
    expect(hashed).not.toContain(':\\')

    const unhashed = formatOutputDiagLine({
      stream: 'stderr',
      diagnostics,
      contract: oemContract(936),
      rawArtifactPath: '/home/alice/.config/SpaceAssistant/shell-output/tmp.log'
    })
    expect(unhashed).toContain('rawArtifact=artifact-redacted')
    expect(unhashed).not.toContain('alice')

    const alreadyAnId = formatOutputDiagLine({
      stream: 'stderr',
      diagnostics,
      contract: oemContract(936),
      rawArtifactPath: 'artifact-' + 'b'.repeat(64)
    })
    expect(alreadyAnId).toContain('rawArtifact=artifact-' + 'b'.repeat(64))
  })

  it('解码器层面的损坏（GBK 被按 UTF-8 解）不误报为 host 损失', () => {
    const buf = Buffer.from(GBK_ZH_TEST_BARE_HEX, 'hex')
    const { meta } = detectEncoding(buf, { contract: AUTO_CONTRACT, oemCodepage: 936, platform: WIN })
    expect(resolveLossStage({ contract: AUTO_CONTRACT, meta, text: '\uFFFD\uFFFD' })).toBeUndefined()
    expect(resolveLossStage({ contract: oemContract(936), meta, text: '\uFFFD\uFFFD' })).toBeUndefined()
  })

  it('契约钉死 UTF-8 且字节本身合法时，U+FFFD 归因于宿主内损失', () => {
    const buf = Buffer.from('efbfbd', 'hex')
    const { meta } = detectEncoding(buf, { contract: UTF8_CONTRACT, platform: WIN })
    expect(meta.contractConflict).toBeUndefined()
    expect(resolveLossStage({ contract: UTF8_CONTRACT, meta, text: '\uFFFD' })).toBe('host')
    expect(resolveLossStage({ contract: UTF8_CONTRACT, meta, text: 'ok' })).toBeUndefined()
  })

  it('outputTrust 由任一条流的 suspect 决定', () => {
    const safe = { encoding: 'utf-8', source: 'strict-utf8', confidence: 'high', replacements: 0, suspect: false } as const
    const risky = { ...safe, suspect: true } as const
    expect(resolveOutputTrust(safe, safe)).toBe('ok')
    expect(resolveOutputTrust(safe, risky)).toBe('suspect')
  })
})
