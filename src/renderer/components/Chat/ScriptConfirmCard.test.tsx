import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import configReducer from '../../store/configSlice'
import { ScriptConfirmCard } from './ScriptConfirmCard'
import { ShikiHighlightedCodeBody } from './ShikiHighlightedCode'

vi.mock('../../utils/shikiHighlighter', () => ({
  getCachedHighlight: vi.fn(() => null),
  highlightCode: vi.fn().mockResolvedValue('<pre class="shiki"><code>highlighted</code></pre>')
}))

function record(partial: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'script-1',
    toolName: 'run_script',
    input: { code: 'import os\nos.makedirs("tmp")' },
    status: 'confirming',
    riskLevel: 'high',
    ...partial
  }
}

function findings(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    pattern: `fixture-pattern-${index + 1}`,
    class: 'process-creation' as const,
    range: { startLine: index + 1, startCol: 1, endLine: index + 1, endCol: 20 },
    snippet: `subprocess.Popen(['job-${index + 1}'])`,
    evidence: { kind: 'process-create' as const, module: 'subprocess', attr: 'Popen', argvLiteral: `['job-${index + 1}']` }
  }))
}

function renderCard(ui: ReactElement) {
  const store = configureStore({ reducer: { config: configReducer } })
  return render(<Provider store={store}>{ui}</Provider>)
}

describe('ScriptConfirmCard', () => {
  it('uses shared confirm card chrome with icon actions', async () => {
    const onConfirm = vi.fn()
    renderCard(<ScriptConfirmCard record={record()} onConfirm={onConfirm} />)

    expect(document.querySelector('.write-confirm-card.script-confirm-card')).not.toBeNull()
    expect(screen.getByText('运行 Python 脚本')).toBeDefined()
    expect(screen.getByRole('button', { name: '确认运行' })).toBeDefined()
    expect(screen.getByRole('button', { name: '拒绝运行' })).toBeDefined()

    await waitFor(() => {
      expect(document.querySelector('.script-confirm-card__code--highlighted .shiki')).not.toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: '确认运行' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('shows localized structured evidence phrase for each finding', () => {
    const item = findings(1)[0]!
    renderCard(<ScriptConfirmCard record={record({ scriptFindings: [item] })} onConfirm={vi.fn()} />)
    expect(screen.getByText('进程调用')).toBeDefined()
  })

  it('highlights python code via shiki', async () => {
    const { highlightCode } = await import('../../utils/shikiHighlighter')
    render(
      <ShikiHighlightedCodeBody
        code={'import os\nos.makedirs("tmp")'}
        language="python"
        className="script-confirm-card__code script-confirm-card__code--highlighted"
      />
    )

    await waitFor(() => {
      expect(highlightCode).toHaveBeenCalledWith(
        expect.stringContaining('import os'),
        'python',
        'dark'
      )
    })
  })

  it('does not let a stale highlight overwrite a cached code block', async () => {
    const { getCachedHighlight, highlightCode } = await import('../../utils/shikiHighlighter')
    let resolveOld!: (value: string) => void
    const oldResult = new Promise<string>((resolve) => { resolveOld = resolve })
    vi.mocked(getCachedHighlight).mockImplementation((code) => code === 'B' ? '<pre>cached B</pre>' : null)
    vi.mocked(highlightCode).mockImplementation((code) => code === 'A' ? oldResult : Promise.resolve('<pre>new</pre>'))

    const view = render(<ShikiHighlightedCodeBody code="A" language="text" />)
    view.rerender(<ShikiHighlightedCodeBody code="B" language="text" />)
    expect(await screen.findByText('cached B')).toBeDefined()

    await act(async () => {
      resolveOld('<pre>stale A</pre>')
      await oldResult
    })

    expect(screen.getByText('cached B')).toBeDefined()
    expect(screen.queryByText('stale A')).toBeNull()
    vi.mocked(getCachedHighlight).mockReturnValue(null)
    vi.mocked(highlightCode).mockResolvedValue('<pre class="shiki"><code>highlighted</code></pre>')
  })

  it('shows timeout meta when provided', () => {
    renderCard(
      <ScriptConfirmCard
        record={record({ input: { code: 'print(1)', timeout: 120 } })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText('120s')).toBeDefined()
  })

  it('shows the path analysis reason when it is available', () => {
    renderCard(<ScriptConfirmCard record={record({ scriptPathHint: '路径分析未覆盖：custom_accessor' })} onConfirm={vi.fn()} />)
    expect(screen.getByText('路径分析未覆盖：custom_accessor')).toBeDefined()
  })

  it.each([0, 1, 3, 4, 8])('renders %i findings with a three-item default and a keyboard-operable per-card disclosure', async (count) => {
    const items = findings(count)
    renderCard(<ScriptConfirmCard record={record({ scriptFindings: items, scriptFindingTotalCount: count })} onConfirm={vi.fn()} />)
    if (count > 0) {
      await waitFor(() => {
        expect(document.querySelector('.script-confirm-card__code--highlighted .shiki')).not.toBeNull()
      })
    }

    const section = screen.queryByRole('region', { name: '脚本风险发现' })
    if (count === 0) {
      expect(section).toBeNull()
      expect(screen.queryByRole('button', { name: /另有/ })).toBeNull()
      return
    }

    expect(section).not.toBeNull()
    const visibleCount = Math.min(count, 3)
    for (let index = 0; index < visibleCount; index += 1) {
      expect(section?.textContent).toContain(`第 ${index + 1} 行`)
      expect(section?.textContent).toContain(items[index]!.snippet)
    }
    if (count <= 3) {
      expect(screen.queryByRole('button', { name: /另有/ })).toBeNull()
      return
    }

    const toggle = screen.getByRole('button', { name: `另有 ${count - 3} 条` })
    expect(toggle.tabIndex).toBe(0)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(section?.textContent).not.toContain(items[3]!.snippet)
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    fireEvent.keyDown(toggle, { key: 'Enter' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(section?.textContent).toContain(items[3]!.snippet)
  })

  it('keeps finding disclosure state isolated between confirmation cards', async () => {
    const first = findings(4)
    const second = findings(4).map((finding) => ({ ...finding, snippet: `other_${finding.snippet}` }))
    renderCard(<>
      <ScriptConfirmCard record={record({ id: 'first', scriptFindings: first, scriptFindingTotalCount: 4 })} onConfirm={vi.fn()} />
      <ScriptConfirmCard record={record({ id: 'second', scriptFindings: second, scriptFindingTotalCount: 4 })} onConfirm={vi.fn()} />
    </>)
    await waitFor(() => {
      expect(document.querySelectorAll('.script-confirm-card__code--highlighted .shiki')).toHaveLength(2)
    })

    const toggles = screen.getAllByRole('button', { name: '另有 1 条' })
    fireEvent.click(toggles[0]!)
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(toggles[1]?.getAttribute('aria-expanded')).toBe('false')
  })
})
