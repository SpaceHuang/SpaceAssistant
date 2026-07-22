import { describe, expect, it } from 'vitest'
import { compareDisplayOrder, type DisplayOrder } from './displayOrder'

describe('compareDisplayOrder', () => {
  it('orders persisted by sequence ascending', () => {
    const a: DisplayOrder = { kind: 'persisted', sequence: 1 }
    const b: DisplayOrder = { kind: 'persisted', sequence: 10 }
    expect(compareDisplayOrder(a, b)).toBeLessThan(0)
    expect(compareDisplayOrder(b, a)).toBeGreaterThan(0)
  })

  it('places all optimistic after all persisted', () => {
    const persisted: DisplayOrder = { kind: 'persisted', sequence: 999 }
    const optimistic: DisplayOrder = { kind: 'optimistic', ordinal: 0 }
    expect(compareDisplayOrder(persisted, optimistic)).toBeLessThan(0)
    expect(compareDisplayOrder(optimistic, persisted)).toBeGreaterThan(0)
  })

  it('orders optimistic by ordinal', () => {
    const a: DisplayOrder = { kind: 'optimistic', ordinal: 1 }
    const b: DisplayOrder = { kind: 'optimistic', ordinal: 2 }
    expect(compareDisplayOrder(a, b)).toBeLessThan(0)
  })
})
