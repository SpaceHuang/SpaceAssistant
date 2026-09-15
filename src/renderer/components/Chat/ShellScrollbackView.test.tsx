import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

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

  it('M3：终端 scrollback 分支同样渲染 outputTrust=suspect 提示', () => {
    render(
      <ShellScrollbackView
        expanded
        scrollback={{ cols: 80, rows: 24, serialized: 'restore-me' }}
        stdout="乱码"
        outputTrust="suspect"
        exitCode={1}
      />
    )
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('输出编码可疑')
    expect(notice.textContent).toContain('原始字节')
  })

  it('M3：终端分支的 plain 兜底也透传 outputTrust', () => {
    render(
      <ShellScrollbackView
        expanded
        scrollback={{ cols: 80, rows: 24, plainText: '乱码' }}
        stdout="乱码"
        outputTrust="suspect"
      />
    )
    expect(screen.getByRole('status').textContent).toContain('输出编码可疑')
  })

  it('M3：outputTrust=ok 时终端分支不渲染提示', () => {
    render(
      <ShellScrollbackView
        expanded
        scrollback={{ cols: 80, rows: 24, serialized: 'restore-me' }}
        outputTrust="ok"
        exitCode={1}
      />
    )
    expect(screen.queryByRole('status')).toBeNull()
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
