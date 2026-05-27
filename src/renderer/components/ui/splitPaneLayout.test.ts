import { describe, expect, it } from 'vitest'
import { clampSplitPaneSize, maxSplitPaneSize } from './splitPaneLayout'

function mockShell(opts: { shellW: number; leftW?: number; rightW?: number; mainMin?: number }): Element {
  const shell = document.createElement('div')
  shell.className = 'app-shell'
  Object.defineProperty(shell, 'getBoundingClientRect', {
    value: () => ({ width: opts.shellW, height: 800, top: 0, left: 0, right: opts.shellW, bottom: 800 })
  })

  const main = document.createElement('main')
  main.className = 'app-main'
  const minWidth = String(opts.mainMin ?? 400)
  main.style.minWidth = minWidth
  document.body.appendChild(main)
  shell.appendChild(main)

  if (opts.leftW != null) {
    const left = document.createElement('div')
    left.className = 'app-sider'
    Object.defineProperty(left, 'getBoundingClientRect', {
      value: () => ({ width: opts.leftW, height: 800 })
    })
    shell.appendChild(left)
  }

  if (opts.rightW != null) {
    const right = document.createElement('div')
    right.className = 'app-detail-sider'
    Object.defineProperty(right, 'getBoundingClientRect', {
      value: () => ({ width: opts.rightW, height: 800 })
    })
    shell.appendChild(right)
  }

  document.body.appendChild(shell)
  return shell
}

describe('splitPaneLayout', () => {
  it('caps right pane when shell narrows', () => {
    const shell = mockShell({ shellW: 1000, leftW: 328, mainMin: 400 })
    expect(maxSplitPaneSize(shell, 'right', 180, 480)).toBe(272)
    expect(clampSplitPaneSize(shell, 'right', 480, 180, 480)).toBe(272)
    shell.remove()
    document.querySelector('.app-main')?.remove()
  })

  it('caps left pane using right sibling width', () => {
    const shell = mockShell({ shellW: 900, rightW: 240, mainMin: 400 })
    expect(maxSplitPaneSize(shell, 'left', 248, 520)).toBe(260)
    shell.remove()
    document.querySelector('.app-main')?.remove()
  })
})
