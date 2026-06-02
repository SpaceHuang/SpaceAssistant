import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShellOutputView } from './ShellOutputView'

describe('ShellOutputView', () => {
  let openOutputPath: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openOutputPath = vi.fn()
    window.api = {
      ...window.api,
      shellOpenOutputPath: openOutputPath
    } as typeof window.api
  })

  it('renders live content in pre.shell-output', () => {
    render(<ShellOutputView content="npm notice\nadded 47 packages" isLive />)
    const pre = document.querySelector('pre.shell-output--live')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('added 47 packages')
  })

  it('returns null for empty live content', () => {
    const { container } = render(<ShellOutputView content="" isLive />)
    expect(container.firstChild).toBeNull()
  })

  it('auto-scrolls to bottom when live content updates', () => {
    const { rerender } = render(<ShellOutputView content="line 1" isLive />)
    const pre = document.querySelector('pre.shell-output--live') as HTMLPreElement
    Object.defineProperty(pre, 'scrollHeight', { value: 200, configurable: true })
    pre.scrollTop = 0
    rerender(<ShellOutputView content={'line 1\nline 2\nline 3'} isLive />)
    expect(pre.scrollTop).toBe(200)
  })

  it('renders stdout in completed mode', () => {
    render(<ShellOutputView stdout="On branch main\nnothing to commit" />)
    expect(screen.getByText(/On branch main/)).toBeDefined()
  })

  it('shows exit code and stderr styling when exitCode is non-zero', () => {
    render(<ShellOutputView stdout="" stderr="error TS2322" exitCode={1} />)
    expect(screen.getByText(/退出码 1/)).toBeDefined()
    expect(document.querySelector('.shell-output__stderr')?.textContent).toContain('error TS2322')
  })

  it('shows truncated hint and opens full log', () => {
    render(
      <ShellOutputView
        stdout="partial"
        truncated
        persistedOutputPath="/tmp/shell-output/tool-1.log"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /打开完整日志/ }))
    expect(openOutputPath).toHaveBeenCalledWith('/tmp/shell-output/tool-1.log')
  }, 15_000)

  it('returns null when completed mode has no output', () => {
    const { container } = render(<ShellOutputView stdout="" stderr="" exitCode={0} />)
    expect(container.firstChild).toBeNull()
  })
})
