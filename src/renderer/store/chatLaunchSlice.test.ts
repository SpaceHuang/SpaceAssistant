import { describe, expect, it } from 'vitest'
import reducer, { setChatLaunchIntent, clearChatLaunchIntent } from './chatLaunchSlice'

describe('chatLaunchSlice', () => {
  it('sets and clears launch intent', () => {
    let state = reducer(undefined, { type: 'init' })
    expect(state.intent).toBeNull()

    state = reducer(
      state,
      setChatLaunchIntent({
        sessionId: 's1',
        skillName: 'browser-setup-guide',
        initialUserMessage: 'fix please',
        source: 'browser-settings-repair'
      })
    )
    expect(state.intent?.sessionId).toBe('s1')
    expect(state.intent?.skillName).toBe('browser-setup-guide')

    state = reducer(state, clearChatLaunchIntent())
    expect(state.intent).toBeNull()
  })
})
