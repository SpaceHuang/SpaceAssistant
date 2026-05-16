import { describe, expect, it } from 'vitest'
import { buildUnifiedDiffLines, diffLineStats } from './writeConfirmDiff'

describe('writeConfirmDiff', () => {
  it('treats new file content as additions only', () => {
    const lines = buildUnifiedDiffLines('', 'a\nb')
    expect(lines).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' }
    ])
    expect(diffLineStats(lines)).toEqual({ add: 2, remove: 0 })
  })

  it('marks removed and added lines in edits', () => {
    const lines = buildUnifiedDiffLines('old\nkeep', 'keep\nnew')
    expect(lines).toEqual([
      { type: 'remove', text: 'old' },
      { type: 'context', text: 'keep' },
      { type: 'add', text: 'new' }
    ])
    expect(diffLineStats(lines)).toEqual({ add: 1, remove: 1 })
  })
})
