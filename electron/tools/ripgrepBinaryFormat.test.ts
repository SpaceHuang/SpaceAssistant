import { describe, expect, it } from 'vitest'
import { detectBinaryArch } from '../../scripts/ripgrep-binary-format.mjs'

describe('ripgrep static binary architecture detection', () => {
  it('识别 Mach-O x64 和 arm64', () => {
    const x64 = Buffer.alloc(8); x64.writeUInt32BE(0xfeedfacf, 0); x64.writeInt32BE(0x01000007, 4)
    const arm64 = Buffer.alloc(8); arm64.writeUInt32BE(0xfeedfacf, 0); arm64.writeInt32BE(0x0100000c, 4)
    expect(detectBinaryArch(x64, 'darwin')).toBe('x64')
    expect(detectBinaryArch(arm64, 'darwin')).toBe('arm64')
  })
  it('识别 PE x64，拒绝非 PE', () => {
    const pe = Buffer.alloc(0x46); pe.writeUInt16LE(0x5a4d, 0); pe.writeUInt32LE(0x40, 0x3c); pe.writeUInt32LE(0x00004550, 0x40); pe.writeUInt16LE(0x8664, 0x44)
    expect(detectBinaryArch(pe, 'win32')).toBe('x64')
    expect(detectBinaryArch(Buffer.alloc(8), 'win32')).toBeNull()
  })
})
