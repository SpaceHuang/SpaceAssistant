import { describe, expect, it } from 'vitest'
import { buildImQueueScope, parseQueueScope, serializeQueueScope } from './queueScope'

describe('buildImQueueScope', () => {
  it('returns the same normalized scope for the same channel and session', () => {
    expect(buildImQueueScope('feishu', 'session-a')).toEqual(buildImQueueScope('feishu', 'session-a'))
  })

  it('keeps different channels and sessions in different scopes', () => {
    const feishu = buildImQueueScope('feishu', 'session-a')
    expect(buildImQueueScope('wechat', 'session-a')).not.toEqual(feishu)
    expect(buildImQueueScope('feishu', 'session-b')).not.toEqual(feishu)
  })
})


describe('queue scope serialization', () => {
  it('escapes delimiters and round-trips IM session identifiers', () => {
    const scope = buildImQueueScope('feishu', 'tenant:session/one')
    const serialized = serializeQueueScope(scope)
    expect(serialized).toContain('%3A')
    expect(parseQueueScope(serialized)).toEqual(scope)
  })

  it('serializes the same scope deterministically', () => {
    const scope = buildImQueueScope('wechat', 'session-a')
    expect(serializeQueueScope(scope)).toBe(serializeQueueScope(scope))
  })

  it('rejects empty or unsupported scope fields and malformed encodings', () => {
    expect(() => buildImQueueScope('feishu', '   ')).toThrow()
    expect(() => buildImQueueScope('discord' as never, 'session-a')).toThrow()
    expect(() => parseQueueScope('im:discord:session-a')).toThrow()
    expect(() => parseQueueScope('im:feishu:')).toThrow()
    expect(() => parseQueueScope('im:feishu:%E0%A4%A')).toThrow()
  })

  it('round-trips the desktop scope', () => {
    expect(parseQueueScope(serializeQueueScope({ kind: 'desktop' }))).toEqual({ kind: 'desktop' })
  })
})
