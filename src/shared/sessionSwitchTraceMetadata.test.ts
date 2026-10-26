import { describe, expect, it } from 'vitest'
import { attachSessionSwitchTraceMetadata, nextSessionSwitchTraceOrdinal, readSessionSwitchTraceMetadata } from './sessionSwitchTraceMetadata'

describe('session switch trace metadata', () => {
  it('keeps a monotonic request ordinal in the renderer process state', () => {
    const processState = {}
    expect(nextSessionSwitchTraceOrdinal(processState)).toBe(1)
    expect(nextSessionSwitchTraceOrdinal(processState)).toBe(2)
    expect(nextSessionSwitchTraceOrdinal({})).toBe(1)
  })

  it('attaches renderer correlation locally without changing the enumerable IPC page shape', () => {
    const page = { entries: [{ sequence: 1 }], oldestSequence: 1, hasMoreBefore: false }
    const result = attachSessionSwitchTraceMetadata(page, { processId: 21, requestOrdinal: 4 })
    expect(result).toBe(page)
    expect(Object.keys(page)).toEqual(['entries', 'oldestSequence', 'hasMoreBefore'])
    expect(JSON.stringify(page)).toBe('{"entries":[{"sequence":1}],"oldestSequence":1,"hasMoreBefore":false}')
    expect(readSessionSwitchTraceMetadata(page)).toEqual({ processId: 21, requestOrdinal: 4 })
    expect(readSessionSwitchTraceMetadata(JSON.parse(JSON.stringify(page)))).toBeUndefined()
  })

  it('rejects invalid correlation values', () => {
    const page = { entries: [] }
    expect(() => attachSessionSwitchTraceMetadata(page, { processId: -1, requestOrdinal: 1 })).toThrow()
    expect(() => attachSessionSwitchTraceMetadata(page, { processId: 1, requestOrdinal: 0 })).toThrow()
  })

  it('supports renderer-world correlation when process identity is supplied by the main receiver', () => {
    const page = {}
    attachSessionSwitchTraceMetadata(page, { requestOrdinal: 7 })
    expect(readSessionSwitchTraceMetadata(page)).toEqual({ requestOrdinal: 7 })
  })

  it('supports attaching correlation to the original IPC error object without changing its message', () => {
    const error = new Error('stable error')
    expect(attachSessionSwitchTraceMetadata(error, { processId: 21, requestOrdinal: 5 })).toBe(error)
    expect(error.message).toBe('stable error')
    expect(readSessionSwitchTraceMetadata(error)).toEqual({ processId: 21, requestOrdinal: 5 })
  })
})
