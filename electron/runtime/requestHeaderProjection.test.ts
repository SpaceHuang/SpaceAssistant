import { describe, expect, it } from 'vitest'
import { buildRequestHeaderPayload } from '../../src/shared/requestContext'
import { projectRequestHeaderForWindow } from './requestHeaderProjection'

describe('projectRequestHeaderForWindow', () => {
  it('writes constant fields once per window and restores them when the header changes', () => {
    const windowId = `window-${Date.now()}-${Math.random()}`
    const makeHeader = (system: string, toolName: string) => buildRequestHeaderPayload({
      requestId: `request-${system}-${toolName}`,
      system,
      tools: [{ name: toolName, input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hello' }]
    })

    const first = projectRequestHeaderForWindow(windowId, makeHeader('system-a', 'tool-a'))
    const stable = projectRequestHeaderForWindow(windowId, makeHeader('system-a', 'tool-a'))
    const changedSystem = projectRequestHeaderForWindow(windowId, makeHeader('system-b', 'tool-a'))
    const changedTools = projectRequestHeaderForWindow(windowId, makeHeader('system-b', 'tool-b'))

    expect(first.system).toBe('system-a')
    expect(first.tools).toEqual([{ name: 'tool-a', input_schema: { type: 'object' } }])
    expect(stable.system).toBeUndefined()
    expect(stable.tools).toBeUndefined()
    expect(changedSystem.system).toBe('system-b')
    expect(changedSystem.tools).toEqual([{ name: 'tool-a', input_schema: { type: 'object' } }])
    expect(changedTools.system).toBe('system-b')
    expect(changedTools.tools).toEqual([{ name: 'tool-b', input_schema: { type: 'object' } }])
  })
})
