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

  it('opens a truncated log by opaque artifact id', () => {
    render(<ShellOutputView stdout="partial" truncated artifactId="artifact-abc123" />)
    fireEvent.click(screen.getByRole('button', { name: /打开完整日志/ }))
    expect(openOutputPath).toHaveBeenCalledWith('artifact-abc123')
  })

  it('redacted artifact id 不渲染打开入口（主进程必然拒绝）', () => {
    render(<ShellOutputView stdout="partial" truncated artifactId="artifact-redacted" />)
    expect(screen.queryByRole('button', { name: /打开完整日志/ })).toBeNull()
    expect(openOutputPath).not.toHaveBeenCalled()
  })

  it('outputTrust=suspect 时提示输出编码可疑且原始字节已保存', () => {
    render(<ShellOutputView stdout="乱码" outputTrust="suspect" />)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('输出编码可疑')
    expect(notice.textContent).toContain('原始字节')
  })

  it('outputTrust 为 ok 或未提供时不渲染可疑提示', () => {
    const { unmount } = render(<ShellOutputView stdout="正常输出" outputTrust="ok" />)
    expect(screen.queryByRole('status')).toBeNull()
    unmount()
    render(<ShellOutputView stdout="正常输出" />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('M3：无输出文本但 outputTrust=suspect 时仍必须渲染提示', () => {
    render(<ShellOutputView stdout="" stderr="" exitCode={0} outputTrust="suspect" />)
    expect(screen.getByRole('status').textContent).toContain('输出编码可疑')
  })

  it('returns null when completed mode has no output', () => {
    const { container } = render(<ShellOutputView stdout="" stderr="" exitCode={0} />)
    expect(container.firstChild).toBeNull()
  })
})
