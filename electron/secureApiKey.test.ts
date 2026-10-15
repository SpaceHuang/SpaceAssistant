import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, isSecretEncrypted, markLegacySecret, setLegacySecretDecryptor } from './secureApiKey'

describe('secureApiKey', () => {
  it('encrypts and decrypts secrets using the versioned envelope', () => {
    const encrypted = encryptSecret('sk-test-secret')
    expect(isSecretEncrypted(encrypted)).toBe(true)
    expect(encrypted).not.toContain('sk-test-secret')
    expect(decryptSecret(encrypted)).toBe('sk-test-secret')
  })

  it('uses a fresh nonce for each encryption of the same secret', () => {
    const first = encryptSecret('same-secret')
    const second = encryptSecret('same-secret')
    expect(first).not.toBe(second)
    expect(decryptSecret(first)).toBe('same-secret')
    expect(decryptSecret(second)).toBe('same-secret')
  })

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSecret('secret')
    const payload = Buffer.from(encrypted.slice(4), 'base64')
    payload[payload.length - 1] ^= 1
    expect(() => decryptSecret(`sa1:${payload.toString('base64')}`)).toThrow()
  })

  it('rejects malformed and unsupported values', () => {
    expect(() => decryptSecret('sa1:')).toThrow()
    expect(() => decryptSecret('not-a-secret-envelope')).toThrow()
  })

  it('reads a tagged legacy safeStorage value for one-time migration', () => {
    setLegacySecretDecryptor((encoded) => {
      if (encoded !== 'old-cipher') throw new Error('unexpected legacy value')
      return 'legacy-plain'
    })
    const legacy = markLegacySecret('old-cipher')
    expect(decryptSecret(legacy)).toBe('legacy-plain')
    expect(encryptSecret(decryptSecret(legacy))).not.toBe(legacy)
  })
})
