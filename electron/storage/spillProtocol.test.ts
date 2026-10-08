import { describe, expect, it } from 'vitest'
import { collectSpillDescriptorsStrict, iterateSpillDescriptorReferencesStrict } from './spillProtocol'

const source = (locator: string) => ({
  version: 1, kind: 'source-of-truth', locator, byteLength: 1, sha256: 'a'.repeat(64), createdAt: 1, head: '', tail: ''
})

describe('spill descriptor traversal', () => {
  it('collects each known marker, sibling subtrees, arrays, and stable JSON Pointer paths', () => {
    const payload = {
      'a/b': {
        __spaceassistant_spill_v1: source('a.spill'),
        __spaceassistant_session_transcript_spill_v1: { ...source('b.spill'), kind: 'degradable' },
        sibling: [{ deep: { __spaceassistant_spill_v1: source('c.spill') } }]
      }
    }

    expect([...iterateSpillDescriptorReferencesStrict(payload)].map(({ path, descriptor }) => [path, descriptor.locator, descriptor.kind])).toEqual([
      ['/a~1b/__spaceassistant_spill_v1', 'a.spill', 'source-of-truth'],
      ['/a~1b/__spaceassistant_session_transcript_spill_v1', 'b.spill', 'degradable'],
      ['/a~1b/sibling/0/deep/__spaceassistant_spill_v1', 'c.spill', 'source-of-truth']
    ])
    expect(collectSpillDescriptorsStrict(payload).map(({ locator }) => locator)).toEqual(['a.spill', 'b.spill', 'c.spill'])
  })

  it('rejects unknown markers and ambiguous inline descriptors with nested descriptors', () => {
    expect(() => collectSpillDescriptorsStrict({ nested: { __spaceassistant_spill_v2: source('bad.spill') } })).toThrow()
    expect(() => collectSpillDescriptorsStrict({
      ...source('inline.spill'), nested: { __spaceassistant_spill_v1: source('nested.spill') }
    })).toThrow()
  })

  it('decodes JSON unicode escapes before validating and indexing a locator', () => {
    const escaped = JSON.parse('{"file":{"__spaceassistant_spill_v1":{"version":1,"kind":"source-of-truth","locator":"\\u0061.spill","byteLength":1,"sha256":"' + 'a'.repeat(64) + '","createdAt":1,"head":"","tail":""}}}')
    expect([...iterateSpillDescriptorReferencesStrict(escaped)].map(({ descriptor }) => descriptor.locator)).toEqual(['a.spill'])
  })
})
