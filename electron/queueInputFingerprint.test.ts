import { describe, expect, it } from 'vitest'
import { queueInputFingerprint } from './queueInputFingerprint'

describe('queueInputFingerprint', () => {
  it('使用稳定的 SHA-256 指纹', () => {
    expect(queueInputFingerprint({ text: 'hello' })).toBe('9ba9fce891c6007f90419517998126276b0178a2f3d286dd9090ca8ff88510e4')
  })
})
