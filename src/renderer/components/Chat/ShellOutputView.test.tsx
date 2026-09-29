import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
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

  it('auto-scrolls to bottom when live content commits', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<ShellOutputView content="line 1" isLive />)
      const pre = document.querySelector('pre.shell-output--live') as HTMLPreElement
      Object.defineProperty(pre, 'scrollHeight', { value: 200, configurable: true })
      pre.scrollTop = 0
      // 高频推送先被节流合并；提交时贴底
      rerender(<ShellOutputView content={'line 1\nline 2\nline 3'} isLive />)
      expect(pre.scrollTop).toBe(0)
      act(() => { vi.advanceTimersByTime(120) })
      expect(pre.scrollTop).toBe(200)
    } finally {
      vi.useRealTimers()
    }
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

  // ---- live 输出提交节流：主进程 tool-progress 每次输出都推 4KB 尾部快照（窗口前移、
  // 整块文本全变），不节流时 <pre> 每帧整块重绘 + scrollTop 强制贴底 = 详情区「内容快速刷新」。
  // 尾随节流把提交节奏固定为 ~8fps，末帧保证最终提交。
  it('live 输出高频变化时节流提交：间隔窗口内只提交一次，末帧最终提交', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<ShellOutputView content="v1" isLive />)
      const text = () => container.querySelector('pre.shell-output--live')?.textContent
      expect(text()).toBe('v1')
      // 挂载后同一间隔窗口内的连续推送：不逐帧提交（旧实现立即提交 v2 → 此断言失败）
      rerender(<ShellOutputView content="v2" isLive />)
      rerender(<ShellOutputView content="v3" isLive />)
      expect(text()).toBe('v1')
      // 窗口到期：尾随提交最新值（中间帧合并丢弃）
      act(() => { vi.advanceTimersByTime(120) })
      expect(text()).toBe('v3')
    } finally {
      vi.useRealTimers()
    }
  })

  it('距上次提交超过间隔后的 live 变化立即提交', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<ShellOutputView content="v1" isLive />)
      const text = () => container.querySelector('pre.shell-output--live')?.textContent
      act(() => { vi.advanceTimersByTime(300) })
      rerender(<ShellOutputView content="v2" isLive />)
      expect(text()).toBe('v2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('内容未变化的重复推送不触发重新提交', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = render(<ShellOutputView content="same" isLive />)
      const text = () => container.querySelector('pre.shell-output--live')?.textContent
      rerender(<ShellOutputView content="same" isLive />)
      rerender(<ShellOutputView content="same" isLive />)
      act(() => { vi.advanceTimersByTime(500) })
      expect(text()).toBe('same')
    } finally {
      vi.useRealTimers()
    }
  })
})
