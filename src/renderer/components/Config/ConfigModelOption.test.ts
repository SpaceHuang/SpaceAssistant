import { describe, expect, it } from 'vitest'
import type { ModelEntry } from '../../../shared/domainTypes'
import { sortModelsFastFirst } from './ConfigModelOption'

function model(name: string, isFast: boolean): ModelEntry {
  return {
    id: name,
    name,
    maximumContext: 1000,
    maxTokens: 100,
    isDefault: false,
    isFast,
    enabled: true
  }
}

describe('sortModelsFastFirst', () => {
  it('puts fast models before non-fast while preserving relative order', () => {
    const input = [model('a', false), model('b', true), model('c', false), model('d', true)]
    expect(sortModelsFastFirst(input).map((m) => m.name)).toEqual(['b', 'd', 'a', 'c'])
  })
})
