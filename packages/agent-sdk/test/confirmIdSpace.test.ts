import { describe, expect, it } from 'vitest'
import { ConfirmIdSpace } from '../src/runtime/components'

describe('ConfirmIdSpace two digit leases', () => {
  it('allocates the complete 00–99 namespace without collisions and releases the exact lease', () => {
    const space = new ConfirmIdSpace()
    const leases = Array.from({ length: 100 }, () => space.allocate())
    const codes = leases.map((lease) => lease.code)

    expect(codes.every((code) => /^\d{2}$/.test(code))).toBe(true)
    expect(new Set(codes).size).toBe(100)
    expect(new Set(codes)).toEqual(new Set(Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'))))
    expect(() => space.allocate()).toThrow('CONFIRM_ID_SPACE_EXHAUSTED')
    space.release(leases[0]!)
    expect(space.allocate().code).toBe(leases[0]!.code)
    space.clear()
    expect(() => space.allocate()).not.toThrow()
  })

  it('does not let a stale or forged lease release a code after immediate reuse', () => {
    const space = new ConfirmIdSpace()
    const existing = Array.from({ length: 100 }, () => space.allocate())
    const first = existing[0]!
    space.release(first)
    const second = space.allocate()
    expect(second.code).toBe(first.code)

    space.release(first)
    space.release({ code: second.code, allocationToken: {} })

    expect(space.isInUse(second.code)).toBe(true)
    expect(() => space.allocate()).toThrow('CONFIRM_ID_SPACE_EXHAUSTED')
  })
})
