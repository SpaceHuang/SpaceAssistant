import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

async function flushRaf(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

const write = vi.fn()
const clear = vi.fn()
const resize = vi.fn()
const dispose = vi.fn()
const serialize = vi.fn(() => 'serialized')

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    loadAddon = vi.fn()
    open = vi.fn()
    write = write
    clear = clear
    resize = resize
    dispose = dispose
    scrollToBottom = vi.fn()
    onScroll = vi.fn()
    buffer = {
      active: {
        length: 1,
        baseY: 0,
        viewportY: 0,
        getLine: () => ({ translateToString: (trim: boolean) => (trim ? 'ansi' : 'plain') })
      }
    }
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

vi.mock('@xterm/addon-serialize', () => {
  class SerializeAddon {
    serialize = serialize
  }
  return { SerializeAddon }
})

import { ShellTerminalView } from './ShellTerminalView'

describe('ShellTerminalView', () => {
  beforeEach(() => {
    write.mockClear()
    dispose.mockClear()
  })

  it('writes decoded raw progress', async () => {
    const raw = Buffer.from('hello\rworld').toString('base64')
    render(<ShellTerminalView progressOutputRaw={raw} />)
    await flushRaf(8)
    await waitFor(() => expect(write).toHaveBeenCalled())
  })

  it('exports scrollback on dispose', async () => {
    const onBeforeDispose = vi.fn()
    const { unmount } = render(<ShellTerminalView onBeforeDispose={onBeforeDispose} />)
    await flushRaf()
    unmount()
    await flushRaf()
    expect(onBeforeDispose).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 80, rows: 24, serialized: 'serialized' })
    )
    expect(dispose).toHaveBeenCalled()
  })
})
