import { describe, expect, it } from 'vitest'
import { classifyLarkCliImpact, larkCliWriteNeedsConfirm } from './larkCliImpactPolicy'

describe('larkCliImpactPolicy', () => {
  it('classifies group message as high-impact', () => {
    const r = classifyLarkCliImpact(['message', 'send', '--chat-type', 'group', '--receive-id', 'oc_x'])
    expect(r.impact).toBe('high_impact')
  })

  it('classifies single message as low_write', () => {
    const r = classifyLarkCliImpact(['message', 'send', '--receive-id', 'ou_one'])
    expect(r.impact).toBe('low_write')
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
  })
})
