import { describe, expect, it } from 'vitest'
import { getSelectionTextInContainer } from './selectionCopy'

function mockSelection(container: HTMLElement, startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => range.toString(),
    getRangeAt: () => range
  } as Selection
}

describe('getSelectionTextInContainer', () => {
  it('returns selected text when selection is inside container', () => {
    const container = document.createElement('div')
    const pre = document.createElement('pre')
    pre.textContent = 'hello world'
    container.appendChild(pre)
    document.body.appendChild(container)

    const textNode = pre.firstChild!
    const selection = mockSelection(container, textNode, 0, textNode, 5)
    expect(getSelectionTextInContainer(container, selection)).toBe('hello')

    document.body.removeChild(container)
  })

  it('returns null when selection is outside container', () => {
    const container = document.createElement('div')
    const outside = document.createElement('p')
    outside.textContent = 'outside'
    container.appendChild(document.createElement('span'))
    document.body.append(container, outside)

    const textNode = outside.firstChild!
    const selection = mockSelection(outside, textNode, 0, textNode, 7)
    expect(getSelectionTextInContainer(container, selection)).toBeNull()

    document.body.removeChild(container)
    document.body.removeChild(outside)
  })

  it('returns null for collapsed selection', () => {
    const container = document.createElement('div')
    const p = document.createElement('p')
    p.textContent = 'abc'
    container.appendChild(p)

    const range = document.createRange()
    range.selectNodeContents(p)
    range.collapse(true)
    const selection = {
      rangeCount: 1,
      isCollapsed: true,
      toString: () => '',
      getRangeAt: () => range
    } as Selection

    expect(getSelectionTextInContainer(container, selection)).toBeNull()
  })
})
