import { describe, expect, it } from 'vitest'
import { mergeStreamedToolInputsIntoContent } from './toolUseInputMerge'

describe('mergeStreamedToolInputsIntoContent', () => {
  it('fills write_file content from streamed block when final input omits it', () => {
    const streamed = [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'write_file',
        input: { path: 'a.txt', content: 'hello' }
      }
    ]
    const final = [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'write_file',
        input: { path: 'a.txt' }
      }
    ]
    const out = mergeStreamedToolInputsIntoContent(final, streamed)
    expect((out[0] as { input: { path: string; content: string } }).input).toEqual({
      path: 'a.txt',
      content: 'hello'
    })
  })

  it('parses stringified tool input on final block', () => {
    const streamed: unknown[] = []
    const final = [
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'write_file',
        input: JSON.stringify({ path: 'b.txt', content: 'x' })
      }
    ]
    const out = mergeStreamedToolInputsIntoContent(final, streamed)
    expect((out[0] as { input: { path: string; content: string } }).input).toEqual({
      path: 'b.txt',
      content: 'x'
    })
  })

  it('prefers valid string content from final when streamed is empty', () => {
    const streamed: unknown[] = []
    const final = [
      {
        type: 'tool_use',
        id: 'toolu_3',
        name: 'write_file',
        input: { path: 'c.txt', content: 'from-final' }
      }
    ]
    const out = mergeStreamedToolInputsIntoContent(final, streamed)
    expect((out[0] as { input: { content: string } }).input.content).toBe('from-final')
  })
})
