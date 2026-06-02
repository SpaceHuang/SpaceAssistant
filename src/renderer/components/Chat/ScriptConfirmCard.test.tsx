import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('shows timeout meta when provided', () => {
    renderCard(
      <ScriptConfirmCard
        record={record({ input: { code: 'print(1)', timeout: 120 } })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText('120s')).toBeDefined()
  })
})
