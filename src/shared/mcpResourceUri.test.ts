import { describe, expect, it } from 'vitest'
import { sanitizeMcpResourceUri } from './mcpResourceUri'

describe('sanitizeMcpResourceUri', () => {
  it('removes credentials and sensitive query/fragment while preserving the resource identity', () => {
    expect(sanitizeMcpResourceUri('https://user:secret@example.com/file?token=abc&name=x#access_token=y'))
      .toBe('https://example.com/file?name=x')
  })

  it('bounds malformed or extremely long values without throwing', () => {
    expect(sanitizeMcpResourceUri('not a uri')).toBe('not a uri')
    expect(sanitizeMcpResourceUri('x'.repeat(5000)).length).toBeLessThanOrEqual(2048)
  })
})
