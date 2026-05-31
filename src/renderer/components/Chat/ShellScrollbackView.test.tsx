import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

async function flushRaf(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

const dispose = vi.fn()

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    clear = vi.fn()
    resize = vi.fn()
    dispose = dispose
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn()
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }))
  }
  return { FitAddon }
})

import { ShellScrollbackView } from './ShellScrollbackView'

describe('ShellScrollbackView', () => {
  it('restores serialized scrollback when expanded', async () => {
    const { unmount } = render(
      <ShellScrollbackView
        expanded
        scrollback={{ cols: 80, rows: 24, serialized: 'restore-me' }}
        exitCode={0}
      />
    )
    expect(document.querySelector('.shell-terminal-host')).not.toBeNull()
    await flushRaf()
    unmount()
    await flushRaf()
    await waitFor(() => expect(dispose).toHaveBeenCalled())
  })

  it('falls back to plain output when only plainText', () => {
    render(
      <ShellScrollbackView
        expanded
        scrollback={{ cols: 80, rows: 24, plainText: 'plain only' }}
        stdout="plain only"
        exitCode={0}
      />
    )
    expect(document.querySelector('.shell-output')).not.toBeNull()
  })
})
