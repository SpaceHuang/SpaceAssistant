import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CapabilityRegistry } from './registry'

describe('CapabilityRegistry descriptor snapshot', () => {
  it('publishes an immutable descriptor and immutable metadata arrays', () => {
    const registry = new CapabilityRegistry()
    registry.register({
      id: 'env.snapshot', family: 'env', summary: 'snapshot', keywords: ['read'],
      paramsSchema: z.object({}), paramsDoc: '{}', returnsDoc: '{}', risk: 'read', notes: ['stable'],
      handler: async () => ({ ok: true })
    })
    const descriptor = registry.get('env.snapshot')!
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.keywords)).toBe(true)
    expect(Object.isFrozen(descriptor.notes)).toBe(true)
    expect(Reflect.set(descriptor, 'risk', 'act')).toBe(false)
    expect(Reflect.set(descriptor.keywords, '0', 'write')).toBe(false)
    expect(registry.get('env.snapshot')?.risk).toBe('read')
    expect(registry.get('env.snapshot')?.keywords).toEqual(['read'])
  })
})
