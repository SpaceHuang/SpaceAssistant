import { describe, expect, it } from 'vitest'
import {
  buildFragmentId,
  type ChatSearchMatch,
  type SearchFragment
} from '../../shared/chatSearchFragments'
import {
  applyActiveTargetHighlight,
  clearFragmentHighlights,
  resolveChatSearchActiveTarget
} from './chatSearchActiveTarget'

describe('resolveChatSearchActiveTarget', () => {
  it('keeps fragmentId, range, revealPath and renderStrategy', () => {
    const fragmentId = buildFragmentId('m1', { kind: 'thinking', segmentIndex: 0 })
    const fragment: SearchFragment = {
      fragmentId,
      messageId: 'm1',
      order: { kind: 'persisted', sequence: 1 },
      source: { kind: 'thinking', segmentIndex: 0 },
      revealPath: { thinkingSegmentIndex: 0 },
      renderStrategy: 'anchored-text',
      searchableText: 'secret thought',
      anchors: []
    }
    const match: ChatSearchMatch = {
      fragmentId,
      messageId: 'm1',
      order: fragment.order,
      start: 0,
      end: 6
    }
    const target = resolveChatSearchActiveTarget(match, [fragment])
    expect(target).toEqual({
      messageId: 'm1',
      fragmentId,
      start: 0,
      end: 6,
      order: fragment.order,
      source: fragment.source,
      renderStrategy: 'anchored-text',
      revealPath: { thinkingSegmentIndex: 0 },
      searchableText: 'secret thought'
    })
  })
})

describe('applyActiveTargetHighlight', () => {
  it('highlights by fragmentId + range, not same-message mark ordinal', () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <div data-search-fragment-id="m1|assistant-markdown-text:0:0">hello plain</div>
        <code data-search-fragment-id="m1|assistant-code:0:0:inline">needle</code>
        <span data-search-fragment-id="m1|assistant-math:0:0:inline">E=mc^2</span>
      </div>
    `
    const codeId = 'm1|assistant-code:0:0:inline'
    const mark = applyActiveTargetHighlight(document.body, {
      messageId: 'm1',
      fragmentId: codeId,
      start: 0,
      end: 6,
      order: { kind: 'persisted', sequence: 1 },
      source: { kind: 'assistant-code', segmentIndex: 0, codeIndex: 0, inline: true },
      renderStrategy: 'code-source',
      searchableText: 'needle'
    })
    expect(mark?.textContent).toBe('needle')
    expect(mark?.closest('[data-search-fragment-id]')?.getAttribute('data-search-fragment-id')).toBe(
      codeId
    )
    clearFragmentHighlights(document.body)
  })

  it('maps pretty-json coordinates without collapsing rendered whitespace', () => {
    document.body.innerHTML = '<pre data-search-fragment-id="tool">{\n  "name": "needle"\n}</pre>'
    const query = 'needle'
    const start = document.querySelector('[data-search-fragment-id="tool"]')!.textContent!.indexOf(query)
    const mark = applyActiveTargetHighlight(document.body, {
      messageId: 'm1', fragmentId: 'tool', start, end: start + query.length,
      order: { kind: 'persisted', sequence: 1 },
      source: { kind: 'tool-input', toolUseId: 't1' },
      renderStrategy: 'anchored-text', searchableText: '{\n  "name": "needle"\n}'
    })
    expect(mark?.textContent).toBe(query)
  })
})
