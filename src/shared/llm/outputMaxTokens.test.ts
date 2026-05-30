import { describe, expect, it } from 'vitest'
import type { ModelEntry } from '../domainTypes'
import { resolveEffectiveOutputMaxTokens } from './outputMaxTokens'

describe('resolveEffectiveOutputMaxTokens', () => {
  const models: ModelEntry[] = [
    {
      id: '1',
      name: 'kimi-k2.6',
      maximumContext: 262144,
      maxTokens: 98304,
      isDefault: true,
      isFast: false,
      enabled: true
    }
  ]

  it('uses model row maxTokens when name matches', () => {
    expect(resolveEffectiveOutputMaxTokens('kimi-k2.6', models)).toBe(98304)
  })

  it('falls back to default when model not in list', () => {
    expect(resolveEffectiveOutputMaxTokens('unknown', models)).toBe(64_000)
  })
})
