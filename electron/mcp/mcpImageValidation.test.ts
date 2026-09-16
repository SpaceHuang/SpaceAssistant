import { describe, expect, it } from 'vitest'
import { validateMcpImage } from './mcpImageValidation'

describe('validateMcpImage', () => {
  it('accepts a valid PNG preview under the limit', () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    expect(validateMcpImage('image/png', Buffer.from(bytes).toString('base64'))).toMatchObject({ previewable: true, byteLength: 16 })
  })

  it('rejects mismatched MIME/signature and malformed base64', () => {
    expect(validateMcpImage('image/png', Buffer.from('GIF89a').toString('base64')).previewable).toBe(false)
    expect(validateMcpImage('image/png', 'not-base64').previewable).toBe(false)
    expect(validateMcpImage('image/svg+xml', 'PHN2Zz4=').previewable).toBe(false)
  })
})
