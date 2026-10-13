import { describe, expect, it } from 'vitest'
import { classifyLarkCliImpact, classifyLarkMessageTarget, larkCliWriteNeedsConfirm } from './larkCliImpactPolicy'

describe('larkCliImpactPolicy', () => {
  it('classifies group message as high-impact', () => {
    const r = classifyLarkCliImpact(['message', 'send', '--chat-type', 'group', '--receive-id', 'oc_x'])
    expect(r.impact).toBe('high_impact')
  })

  it('classifies single message as low_write', () => {
    const r = classifyLarkCliImpact(['message', 'send', '--receive-id', 'ou_one'])
    expect(r.impact).toBe('low_write')
  })

  it('classifies Feishu message recipients only from explicit open_id and trusted actor identity', () => {
    expect(classifyLarkMessageTarget(['message', 'send', '--receive-id-type', 'open_id', '--receive-id', 'ou_self'], 'ou_self')).toBe('self')
    expect(classifyLarkMessageTarget(['message', 'send', '--receive-id-type', 'open_id', '--receive-id', 'ou_other'], 'ou_self')).toBe('direct-other')
    expect(classifyLarkMessageTarget(['message', 'send', '--receive-id', 'ou_self'], 'ou_self')).toBe('unknown')
    expect(classifyLarkMessageTarget(['message', 'send', '--receive-id-type', 'user_id', '--receive-id', 'u_self'], 'ou_self')).toBe('unknown')
    expect(classifyLarkMessageTarget(['message', 'send', '--chat-type', 'group', '--receive-id', 'oc_group'], 'ou_self')).toBe('group-or-multiple')
    expect(classifyLarkMessageTarget(['message', 'send', '--receive-id-type', 'open_id', '--receive-id', 'ou_a,ou_b'], 'ou_self')).toBe('group-or-multiple')
    expect(classifyLarkMessageTarget(['message', 'send', '--receive-id-type', 'chat_id', '--receive-id', 'oc_unknown'], 'ou_self')).toBe('unknown')
  })

  it('classifies doc delete / batch / permission as high-impact', () => {
    expect(classifyLarkCliImpact(['doc', 'delete', '--token', 't']).impact).toBe('high_impact')
    expect(classifyLarkCliImpact(['bitable', 'batch-create', '--table', 'x']).impact).toBe('high_impact')
    expect(classifyLarkCliImpact(['doc', 'permission', 'update']).impact).toBe('high_impact')
  })

  it('calendar invite with attendees is high-impact', () => {
    expect(
      classifyLarkCliImpact(['calendar', 'create', '--attendees', 'ou_a,ou_b']).impact
    ).toBe('high_impact')
  })

  it('unknown / missing fail closed to ask', () => {
    expect(classifyLarkCliImpact([]).impact).toBe('unknown')
    expect(classifyLarkCliImpact(['doc', 'create']).impact).toBe('low_write')
    expect(classifyLarkCliImpact(['api', 'invoke']).impact).toBe('unknown')
  })

  it('larkCliWriteNeedsConfirm: high always ask; low follows switch', () => {
    expect(larkCliWriteNeedsConfirm(['message', 'send', '--chat-type', 'group'], false)).toBe(true)
    expect(larkCliWriteNeedsConfirm(['message', 'send', '--receive-id', 'ou_1'], false)).toBe(false)
    expect(larkCliWriteNeedsConfirm(['message', 'send', '--receive-id', 'ou_1'], true)).toBe(true)
    expect(larkCliWriteNeedsConfirm(['doc', 'get', '--token', 't'], true)).toBe(false)
    expect(larkCliWriteNeedsConfirm(['doc', 'delete', '--token', 't'], false)).toBe(true)
    expect(larkCliWriteNeedsConfirm(['calendar', 'delete', '--event-id', 'e1'], false)).toBe(true)
  })

  it('non-string argv elements fail closed without throwing', () => {
    expect(() => classifyLarkCliImpact(['doc', 1])).not.toThrow()
    expect(classifyLarkCliImpact(['doc', 1]).impact).toBe('unknown')
    expect(classifyLarkCliImpact([1]).impact).toBe('unknown')
    expect(classifyLarkCliImpact(['doc', null, 'delete']).impact).toBe('unknown')
    expect(larkCliWriteNeedsConfirm(['doc', 1], false)).toBe(true)
  })
})
