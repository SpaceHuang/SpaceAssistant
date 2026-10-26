import { describe, expect, it } from 'vitest'
import { extractWebContentsConsoleMessage } from './consoleMessage'

describe('extractWebContentsConsoleMessage', () => {
  it('reads the deprecated Electron WebContents callback message argument', () => {
    const event = { preventDefault() {} }
    expect(extractWebContentsConsoleMessage(event, 1, '[session.switch.trace.renderer] {}'))
      .toBe('[session.switch.trace.renderer] {}')
  })

  it('accepts a details object shape and rejects non-message arguments', () => {
    expect(extractWebContentsConsoleMessage({ message: 'renderer message' })).toBe('renderer message')
    expect(extractWebContentsConsoleMessage({ preventDefault() {} }, 1)).toBeUndefined()
  })
})
