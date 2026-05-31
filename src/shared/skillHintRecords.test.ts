import { describe, expect, it } from 'vitest'
import { appendSkillHintRecord, createSkillHintRecord } from './skillHintRecords'

describe('skillHintRecords', () => {
  it('appendSkillHintRecord keeps prior hints', () => {
    const first = createSkillHintRecord('a', 100)
    const next = appendSkillHintRecord([first], 'b', 200)
    expect(next).toHaveLength(2)
    expect(next[0]).toEqual(first)
    expect(next[1]?.text).toBe('b')
    expect(next[1]?.shownAt).toBe(200)
  })
})
