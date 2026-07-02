import { describe, it, expect } from 'vitest'
import { getWriteDirChoice, setWriteDirChoice, clearWriteDirChoice } from './sessionWriteDir'

describe('sessionWriteDir', () => {
  it('returns null when metadata missing', () => {
    expect(getWriteDirChoice({})).toBeNull()
  })

  it('round-trips choice', () => {
    const meta: Record<string, unknown> = {}
    setWriteDirChoice(meta, { dir: 'D:/proj', confirmedAt: 123 })
    expect(getWriteDirChoice(meta)).toEqual({ dir: 'D:/proj', confirmedAt: 123 })
  })

  it('clears choice', () => {
    const meta: Record<string, unknown> = {}
    setWriteDirChoice(meta, { dir: 'D:/proj', confirmedAt: 123 })
    clearWriteDirChoice(meta)
    expect(getWriteDirChoice(meta)).toBeNull()
  })
})
