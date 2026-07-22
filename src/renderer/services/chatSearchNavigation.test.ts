import { describe, expect, it } from 'vitest'
import type { ChatSearchMatch } from '../../shared/chatSearchFragments'
import {
  findDomMarkForStructuredMatch,
  resolveNavigationTarget
} from './chatSearchNavigation'

function match(partial: Partial<ChatSearchMatch> & Pick<ChatSearchMatch, 'messageId' | 'fragmentId'>): ChatSearchMatch {
  return {
    order: { kind: 'persisted', sequence: 0 },
    start: 0,
    end: 1,
    ...partial
  }
}

describe('chatSearchNavigation', () => {
  it('resolveNavigationTarget returns structured match without requiring DOM marks', () => {
    const matches = [
      match({ messageId: 'm5', fragmentId: 'f5', order: { kind: 'persisted', sequence: 5 } })
    ]
    expect(resolveNavigationTarget(matches, 0)?.messageId).toBe('m5')
    expect(resolveNavigationTarget([], 0)).toBeNull()
  })

  it('findDomMarkForStructuredMatch maps by messageId not global index', () => {
    document.body.innerHTML = `
      <div data-message-id="m100"><mark class="sa-search-highlight">late</mark></div>
    `
    const mark = document.querySelector('mark') as HTMLElement
    const matches = [
      match({ messageId: 'm5', fragmentId: 'f5', order: { kind: 'persisted', sequence: 5 } }),
      match({ messageId: 'm100', fragmentId: 'f100', order: { kind: 'persisted', sequence: 100 } })
    ]
    // matchIndex=1 是 m100；marks 只有一项，若误用 marks[1] 会是 undefined
    expect(findDomMarkForStructuredMatch([mark], matches, 1)).toBe(mark)
    expect(findDomMarkForStructuredMatch([mark], matches, 0)).toBeUndefined()
  })

  it('findDomMarkForStructuredMatch uses local order within same message', () => {
    document.body.innerHTML = `
      <div data-message-id="m1">
        <mark class="sa-search-highlight">a</mark>
        <mark class="sa-search-highlight">b</mark>
      </div>
    `
    const marks = [...document.querySelectorAll('mark')] as HTMLElement[]
    const matches = [
      match({ messageId: 'm0', fragmentId: 'x', order: { kind: 'persisted', sequence: 0 } }),
      match({ messageId: 'm1', fragmentId: 'a', start: 0, end: 1, order: { kind: 'persisted', sequence: 1 } }),
      match({ messageId: 'm1', fragmentId: 'b', start: 2, end: 3, order: { kind: 'persisted', sequence: 1 } })
    ]
    expect(findDomMarkForStructuredMatch(marks, matches, 2)?.textContent).toBe('b')
  })
})
