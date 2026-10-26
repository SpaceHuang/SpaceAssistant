import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readProjectionHistorySegmentItems, type ProjectionHistorySegmentDescriptor } from './projectionHistorySegmentReader'

function segment(locator: string, payload: string, fields: Partial<ProjectionHistorySegmentDescriptor> = {}):
  readonly [ProjectionHistorySegmentDescriptor, Buffer] {
  const bytes = Buffer.from(payload)
  return [{ locator, byteLength: bytes.byteLength, payloadDigest: createHash('sha256').update(bytes).digest('hex'),
    itemCount: 1, ...fields }, bytes]
}

describe('projection History segment reader', () => {
  it('yields normal array items in order without requiring a combined item array', async () => {
    const parts = [segment('first', '[{"id":"one"},{"id":"two"}]', { itemCount: 2, firstItemIndex: 0 }),
      segment('second', '[{"id":"three"}]', { itemCount: 1, firstItemIndex: 2 })]
    const byLocator = new Map(parts.map(([descriptor, bytes]) => [descriptor.locator, bytes]))
    const seen: string[] = []
    for await (const item of readProjectionHistorySegmentItems<{ id: string }>({ segments: parts.map(([value]) => value), itemCount: 3,
      readVerified: async (descriptor) => byLocator.get(descriptor.locator)! })) seen.push(item.id)
    expect(seen).toEqual(['one', 'two', 'three'])
  })

  it('reassembles fragmented items and rejects an invalid item index', async () => {
    const encoded = '{"id":"fragmented"}'
    const first = segment('fragment-0', encoded.slice(0, 8), { itemCount: 1, encoding: 'json-item-fragment',
      firstItemIndex: 0, fragmentIndex: 0, fragmentCount: 2 })
    const second = segment('fragment-1', encoded.slice(8), { itemCount: 0, encoding: 'json-item-fragment',
      firstItemIndex: 0, fragmentIndex: 1, fragmentCount: 2 })
    const parts = [first, second]
    const byLocator = new Map(parts.map(([descriptor, bytes]) => [descriptor.locator, bytes]))
    const values: Array<{ id: string }> = []
    for await (const item of readProjectionHistorySegmentItems<{ id: string }>({ segments: parts.map(([value]) => value), itemCount: 1,
      readVerified: async (descriptor) => byLocator.get(descriptor.locator)! })) values.push(item)
    expect(values).toEqual([{ id: 'fragmented' }])

    await expect(async () => {
      for await (const _item of readProjectionHistorySegmentItems({ segments: [{ ...first[0], firstItemIndex: 1 }, second[0]], itemCount: 1,
        readVerified: async (descriptor) => byLocator.get(descriptor.locator)! })) { /* consume */ }
    }).rejects.toThrow('PROJECTION_PENDING_CHUNK_SHAPE_INVALID')
  })
})
