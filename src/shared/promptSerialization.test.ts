import { describe, expect, it } from 'vitest'
import { serializePromptAssembly } from './promptSerialization'

describe('prompt serialization boundary', () => {
  it('appends selected skill fragments as user messages without mutating history', () => {
    const history = [{ role: 'user', content: 'hello' }]
    const result = serializePromptAssembly({ history, skillFragments: [{ name: 'review', contents: 'Check tests.' }] })
    expect(result).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: '<skill name="review">\nCheck tests.\n</skill>' }
    ])
    expect(history).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('returns a fresh copy when no fragments are selected', () => {
    const history = [{ role: 'assistant', content: 'ok' }]
    const result = serializePromptAssembly({ history, skillFragments: [] })
    expect(result).toEqual(history)
    expect(result).not.toBe(history)
  })
})
