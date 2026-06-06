import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ToolCallCard } from './ToolCallCard'

vi.mock('./ShikiHighlightedCode', () => ({
  ShikiHighlightedCode: ({ code, className }: { code: string; className?: string }) => (
    <div className={className}>
      <pre className="shiki">{code}</pre>
    </div>
  )
}))

vi.mock('../DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => ({ openUrl: vi.fn().mockResolvedValue(undefined) })
}))

function writeRecord(status: ToolCallRecord['status'], extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tool-1',
    toolName: 'write_file',
    input: { path: 'notes.txt', content: 'hello' },
    status,
    riskLevel: 'medium',
    ...extra
  }
}

describe('ToolCallCard file write expand behavior', () => {
  it('shows write confirm card with icon actions while confirming', () => {
    render(
      <ToolCallCard
        record={writeRecord('confirming', {
          confirmDiff: { oldContent: '', newContent: 'hello', oldPath: 'notes.txt' }
        })}
        confirmMode="diff"
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '允许写入' })).toBeDefined()
    expect(screen.getByRole('button', { name: '拒绝写入' })).toBeDefined()
    expect(screen.getByText(/写入「notes\.txt」/)).toBeDefined()
    expect(document.querySelector('.write-confirm-card')).not.toBeNull()
  })

  it('shows write success card after completion', () => {
    const onOpenFile = vi.fn()
    const { rerender } = render(
      <ToolCallCard
        record={writeRecord('confirming')}
        confirmMode="direct"
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '允许写入' })).toBeDefined()

    rerender(
      <ToolCallCard
        record={writeRecord('completed', {
          result: { success: true },
          completedAt: Date.now(),
          confirmDiff: { oldContent: '', newContent: 'hello', oldPath: 'notes.txt' }
        })}
        confirmMode="direct"
        onOpenFile={onOpenFile}
      />
    )
    expect(screen.queryByRole('button', { name: '允许写入' })).toBeNull()
    expect(document.querySelector('.write-success-card')).not.toBeNull()
    expect(screen.getByText('notes.txt')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(onOpenFile).toHaveBeenCalledWith('notes.txt')
  })

  it('keeps list_directory collapsed by default when completed', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-2',
          toolName: 'list_directory',
          input: { path: 'src' },
          status: 'completed',
          riskLevel: 'low',
          result: { success: true, data: [{ name: 'a.ts', type: 'file' }] },
          completedAt: Date.now()
        }}
        confirmMode="direct"
      />
    )
    expect(document.querySelector('.tool-row--expanded')).toBeNull()
    expect(document.querySelector('.tool-row-detail--collapsed')).not.toBeNull()
  })

  it('calls onConfirm when allow or deny icon is clicked', () => {
    const onConfirm = vi.fn()
    render(
      <ToolCallCard record={writeRecord('confirming')} confirmMode="direct" onConfirm={onConfirm} />
    )
    fireEvent.click(screen.getByRole('button', { name: '允许写入' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: '拒绝写入' }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('does not show per-card cancel while browser is executing', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-browser-exec',
          toolName: 'browser',
          input: { action: 'navigate', mode: 'open', url: 'https://example.com' },
          status: 'executing',
          riskLevel: 'medium'
        }}
        confirmMode="direct"
        onCancel={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: '取消执行' })).toBeNull()
  })

  it('does not show per-card cancel while run_shell is executing', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-shell-exec',
          toolName: 'run_shell',
          input: { command: 'npm test' },
          status: 'executing',
          riskLevel: 'medium'
        }}
        confirmMode="direct"
        onCancel={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: '取消执行' })).toBeNull()
  })

  it('does not show per-card cancel while browser_detect is executing', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-detect-exec',
          toolName: 'browser_detect',
          input: {},
          status: 'executing',
          riskLevel: 'low'
        }}
        confirmMode="direct"
        onCancel={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: '取消执行' })).toBeNull()
  })

  it('does not show per-card cancel while grep is executing', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-grep-exec',
          toolName: 'grep',
          input: { pattern: 'foo' },
          status: 'executing',
          riskLevel: 'low'
        }}
        confirmMode="direct"
        onCancel={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: '取消执行' })).toBeNull()
  })

  it('collapses browser_detect row when detection completes successfully', () => {
    const { rerender, container } = render(
      <ToolCallCard
        record={{
          id: 'tool-detect',
          toolName: 'browser_detect',
          input: {},
          status: 'executing',
          riskLevel: 'low'
        }}
        confirmMode="direct"
      />
    )
    expect(container.querySelector('.tool-row--expanded')).toBeNull()
    expect(container.querySelector('.tool-row-detail')).toBeNull()

    rerender(
      <ToolCallCard
        record={{
          id: 'tool-detect',
          toolName: 'browser_detect',
          input: {},
          status: 'completed',
          riskLevel: 'low',
          result: {
            success: true,
            data: {
              canInitialize: false,
              primaryFailure: 'chromium_missing',
              errors: ['Chromium 浏览器未安装']
            }
          },
          completedAt: Date.now()
        }}
        confirmMode="direct"
      />
    )
    expect(container.querySelector('.tool-row--expanded')).toBeNull()
    expect(container.querySelector('.tool-row-detail--collapsed')).not.toBeNull()
  })

  it('keeps browser_detect row expanded when detection fails', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-detect-fail',
          toolName: 'browser_detect',
          input: {},
          status: 'failed',
          riskLevel: 'low',
          result: { success: false, error: '检测超时' }
        }}
        confirmMode="direct"
      />
    )
    expect(document.querySelector('.tool-row--expanded')).not.toBeNull()
    expect(screen.getByText('检测超时')).toBeDefined()
  })

  it('keeps browser list row collapsed except confirm card', () => {
    const cases: ToolCallRecord[] = [
      {
        id: 'nav',
        toolName: 'browser',
        input: { action: 'navigate', mode: 'open', url: 'https://example.com' },
        status: 'executing',
        riskLevel: 'medium'
      },
      {
        id: 'extract',
        toolName: 'browser',
        input: { action: 'extract', instruction: 'get titles' },
        status: 'executing',
        riskLevel: 'medium'
      },
      {
        id: 'failed',
        toolName: 'browser',
        input: { action: 'observe', instruction: 'x' },
        status: 'failed',
        riskLevel: 'medium',
        result: { success: false, error: '失败' }
      }
    ]
    for (const record of cases) {
      const { container, unmount } = render(<ToolCallCard record={record} confirmMode="direct" />)
      expect(container.querySelector('.tool-row--expanded')).toBeNull()
      if (record.status === 'failed') {
        expect(container.querySelector('.tool-row-detail--collapsed')).not.toBeNull()
      } else {
        expect(container.querySelector('.tool-row-detail')).toBeNull()
      }
      unmount()
    }
  })

  it('still shows per-card cancel for other tools while executing', () => {
    const onCancel = vi.fn()
    render(
      <ToolCallCard
        record={{
          id: 'tool-script',
          toolName: 'run_script',
          input: { code: 'print(1)' },
          status: 'executing',
          riskLevel: 'high'
        }}
        confirmMode="direct"
        onCancel={onCancel}
      />
    )
    fireEvent.click(document.querySelector('.tool-row__main')!)
    fireEvent.click(screen.getByRole('button', { name: '取消执行' }))
    expect(onCancel).toHaveBeenCalled()
  }, 15_000)

  it('shows browser confirm card with URL while confirming navigate', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-browser',
          toolName: 'browser',
          input: { action: 'navigate', mode: 'open', url: 'https://www.zhihu.com/billboard' },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        confirmMode="direct"
        onConfirm={vi.fn()}
      />
    )
    expect(document.querySelector('.browser-confirm-card')).not.toBeNull()
    expect(screen.getByText('https://www.zhihu.com/billboard')).toBeDefined()
    expect(screen.getByRole('button', { name: '确认操作' })).toBeDefined()
  })
})

const plainShellCardProps = {
  shellConfig: { enabled: false, shellDefaultTimeoutSec: 300, outputMode: 'plain' as const }
}

const terminalShellCardProps = {
  shellConfig: { enabled: true, shellDefaultTimeoutSec: 300, outputMode: 'terminal' as const }
}

function shellRecord(status: ToolCallRecord['status'], extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tool-shell',
    toolName: 'run_shell',
    input: { command: 'npm install' },
    status,
    riskLevel: 'medium',
    ...extra
  }
}

describe('ToolCallCard run_shell output display', () => {
  it('shows live progressOutput while executing', () => {
    render(
      <ToolCallCard
        record={shellRecord('executing', { progressOutput: 'added 47 packages in 3s' })}
        confirmMode="direct"
        {...plainShellCardProps}
      />
    )
    fireEvent.click(document.querySelector('.tool-row__main')!)
    expect(screen.getByText(/added 47 packages/)).toBeDefined()
    expect(document.querySelector('.shell-output--live')).not.toBeNull()
    expect(screen.queryByText(/"exitCode"/)).toBeNull()
  })

  it('uses plain live output for progressOutput when outputMode is terminal', () => {
    render(
      <ToolCallCard
        record={shellRecord('executing', { progressOutput: 'added 47 packages in 3s' })}
        confirmMode="direct"
        {...terminalShellCardProps}
      />
    )
    fireEvent.click(document.querySelector('.tool-row__main')!)
    expect(screen.getByText(/added 47 packages/)).toBeDefined()
    expect(document.querySelector('.shell-output--live')).not.toBeNull()
    expect(document.querySelector('.shell-terminal-host')).toBeNull()
  })

  it('shows formatted stdout when completed', () => {
    render(
      <ToolCallCard
        record={shellRecord('completed', {
          result: {
            success: true,
            data: { stdout: 'On branch main\nnothing to commit', stderr: '', exitCode: 0 }
          },
          completedAt: Date.now()
        })}
        confirmMode="direct"
        {...plainShellCardProps}
      />
    )
    fireEvent.click(document.querySelector('.tool-row__main')!)
    expect(screen.getByText(/On branch main/)).toBeDefined()
    expect(screen.queryByText(/"exitCode"/)).toBeNull()
  })

  it('shows stderr on failed run_shell without generic error message', () => {
    render(
      <ToolCallCard
        record={shellRecord('failed', {
          result: {
            success: false,
            error: '命令执行失败（退出码: 1）',
            data: { stdout: '', stderr: 'error TS2322: type mismatch', exitCode: 1 }
          },
          completedAt: Date.now()
        })}
        confirmMode="direct"
        {...plainShellCardProps}
      />
    )
    expect(screen.getByText(/退出码 1/)).toBeDefined()
    expect(screen.getByText(/error TS2322/)).toBeDefined()
    expect(screen.queryByText('命令执行失败（退出码: 1）')).toBeNull()
  })

  it('keeps read-only shell command collapsed by default when completed', () => {
    render(
      <ToolCallCard
        record={shellRecord('completed', {
          input: { command: 'git status' },
          result: {
            success: true,
            data: { stdout: 'On branch main', stderr: '', exitCode: 0 }
          },
          completedAt: Date.now()
        })}
        confirmMode="direct"
        {...plainShellCardProps}
      />
    )
    expect(document.querySelector('.tool-row--expanded')).toBeNull()
    expect(document.querySelector('.tool-row-detail--collapsed')).not.toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(document.querySelector('.tool-row--expanded')).not.toBeNull()
    expect(screen.getByText(/On branch main/)).toBeDefined()
  })

  it('keeps silent shell command collapsed', () => {
    render(
      <ToolCallCard
        record={shellRecord('completed', {
          input: { command: 'git status' },
          result: {
            success: true,
            data: { stdout: '', stderr: '', exitCode: 0 }
          },
          completedAt: Date.now()
        })}
        confirmMode="direct"
        {...plainShellCardProps}
      />
    )
    expect(screen.getByText('已完成（无输出）')).toBeDefined()
    expect(document.querySelector('.tool-row-detail')).toBeNull()
  })

  it('does not show external terminal hint for normal commands', () => {
    render(
      <ToolCallCard
        record={shellRecord('executing', { progressOutput: 'added 47 packages', input: { command: 'npm install' } })}
        confirmMode="direct"
        {...plainShellCardProps}
      />
    )
    expect(document.querySelector('.shell-tui-fallback')).toBeNull()
  })

  it('shows external terminal hint for interactive TUI commands', () => {
    render(
      <ToolCallCard
        record={shellRecord('executing', { input: { command: 'less README.md' } })}
        confirmMode="direct"
        workDir="E:\\work"
        {...terminalShellCardProps}
      />
    )
    expect(document.querySelector('.shell-tui-fallback')).not.toBeNull()
    expect(document.querySelector('.shell-tui-fallback')?.textContent).toMatch(/交互式终端/)
    expect(document.querySelector('.shell-terminal-host')).toBeNull()
  })

  it('still shows ShellConfirmCard while confirming', () => {
    render(
      <ToolCallCard
        record={shellRecord('confirming', { input: { command: 'rm -rf /tmp/test' } })}
        confirmMode="direct"
        onConfirm={vi.fn()}
      />
    )
    expect(document.querySelector('.shell-confirm-card')).not.toBeNull()
    expect(document.querySelector('.shell-output')).toBeNull()
  })

  it('shows ScriptConfirmCard while run_script is confirming', () => {
    render(
      <ToolCallCard
        record={{
          id: 'script-tool',
          toolName: 'run_script',
          input: { code: 'print("hello")' },
          status: 'confirming',
          riskLevel: 'high'
        }}
        confirmMode="direct"
        onConfirm={vi.fn()}
      />
    )
    expect(document.querySelector('.script-confirm-card')).not.toBeNull()
    expect(screen.getByRole('button', { name: '确认运行' })).toBeDefined()
    expect(document.querySelector('.tool-row-detail')).toBeNull()
  })

  it('shows script code and stdout when completed run_script is expanded', () => {
    render(
      <ToolCallCard
        record={{
          id: 'script-auto',
          toolName: 'run_script',
          input: { code: 'print("hello")' },
          status: 'completed',
          riskLevel: 'high',
          result: {
            success: true,
            data: { exitCode: 0, stdout: 'hello\n', stderr: '' }
          }
        }}
        confirmMode="direct"
      />
    )
    expect(document.querySelector('.tool-row--clickable')).not.toBeNull()
    fireEvent.click(document.querySelector('.tool-row__main')!)
    expect(document.querySelector('.tool-row-detail--open')).not.toBeNull()
    expect(document.querySelector('.tool-row-detail__script-code .shiki')?.textContent).toContain('print("hello")')
    expect(screen.getByText('hello')).toBeDefined()
    expect(document.querySelector('.sa-chat-inset-code')).toBeNull()
  })

  it('shows script code when completed run_script has no output', () => {
    render(
      <ToolCallCard
        record={{
          id: 'script-silent',
          toolName: 'run_script',
          input: { code: 'import os\nos.makedirs("tmp")' },
          status: 'completed',
          riskLevel: 'high',
          result: {
            success: true,
            data: { exitCode: 0, stdout: '', stderr: '' }
          }
        }}
        confirmMode="direct"
      />
    )
    fireEvent.click(document.querySelector('.tool-row__main')!)
    expect(document.querySelector('.tool-row-detail__script-code .shiki')?.textContent).toContain('os.makedirs')
    expect(document.querySelector('.shell-output')).toBeNull()
  })

  it('shows LarkCliConfirmCard while run_lark_cli is confirming', () => {
    render(
      <ToolCallCard
        record={{
          id: 'lark-tool',
          toolName: 'run_lark_cli',
          input: { args: ['message', 'search', '--query', 'hello'] },
          status: 'confirming',
          riskLevel: 'high'
        }}
        confirmMode="direct"
        onConfirm={vi.fn()}
      />
    )
    expect(document.querySelector('.lark-cli-confirm-card')).not.toBeNull()
    expect(screen.getByRole('button', { name: '确认飞书命令' })).toBeDefined()
    expect(document.querySelector('.tool-row-detail')).toBeNull()
  })
})

const terminalWrite = vi.fn()
const terminalDispose = vi.fn()

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    loadAddon = vi.fn()
    open = vi.fn()
    write = terminalWrite
    clear = vi.fn()
    resize = vi.fn()
    dispose = terminalDispose
    scrollToBottom = vi.fn()
    onScroll = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    hasSelection = vi.fn(() => false)
    getSelection = vi.fn(() => '')
    buffer = {
      active: {
        length: 1,
        baseY: 0,
        viewportY: 0,
        getLine: () => ({ translateToString: () => 'line' })
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
    serialize = vi.fn(() => 'serialized')
  }
  return { SerializeAddon }
})

describe('ToolCallCard run_shell terminal collapse', () => {
  it('keeps live terminal mounted when collapsed during execution', () => {
    terminalWrite.mockClear()
    const raw = Buffer.from('downloading packages\n').toString('base64')
    render(
      <ToolCallCard
        record={shellRecord('executing', { progressOutputRaw: raw })}
        confirmMode="direct"
        {...terminalShellCardProps}
      />
    )
    expect(document.querySelector('.shell-terminal-host')).not.toBeNull()
    const detail = document.querySelector('.tool-row-detail')
    expect(detail?.classList.contains('tool-row-detail--collapsed')).toBe(true)
    expect(detail?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(document.querySelector('.tool-row__main')!)
    expect(document.querySelector('.tool-row-detail')?.classList.contains('tool-row-detail--open')).toBe(true)
    expect(document.querySelector('.shell-terminal-host')).not.toBeNull()
  })
})
