import { describe, expect, it } from 'vitest'
import { summarizeSurface, resetSurface } from './compactionActions'

const items = [{ id: 'old', tokens: 100, required: false }, { id: 'required', tokens: 30, required: true }, { id: 'tail', tokens: 20, required: false }]

describe('compaction actions', () => {
  it('replaces old content with a smaller checkpoint while retaining required items', () => {
    const result = summarizeSurface(items, { checkpointId: 'c1', checkpointTokens: 10 })
    expect(result.status).toBe('applied')
    expect(result.items.map((x) => x.id)).toEqual(['c1', 'required', 'tail'])
    expect(result.items.find((x) => x.id === 'required')?.required).toBe(true)
    expect(result.record.shadowedRanges).toEqual([{ start: 'old', end: 'old' }])
  })
  it('resets to required and tail content without deleting facts', () => {
    const result = resetSurface(items, { checkpointId: 'c2', checkpointTokens: 8 })
    expect(result.items.map((x) => x.id)).toEqual(['c2', 'required', 'tail'])
    expect(result.facts).toHaveLength(3)
  })
})
