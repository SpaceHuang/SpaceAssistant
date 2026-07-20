import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactDecisionCard, buildArtifactDecisionOptions } from './ArtifactDecisionCard'

describe('ArtifactDecisionCard', () => {
  const t = (key: string) => key

  it('renders all decision kinds with their option sets', () => {
    for (const kind of ['path-type', 'output-location', 'ownership', 'overwrite', 'reference-retention', 'git-ignore'] as const) {
      const options = buildArtifactDecisionOptions(kind, t)
      expect(options.length).toBeGreaterThan(0)
    }
  })

  it('submits rename and change-directory choices with validated input', () => {
    const onRespond = vi.fn()
    render(
      <ArtifactDecisionCard
        request={{
          decisionId: 'd1',
          requestId: 'r1',
          sessionId: 's1',
          toolUseId: 't1',
          attempt: 1,
          kind: 'overwrite',
          options: [
            { key: 'overwrite', label: '覆盖' },
            { key: 'rename', label: '改名', requiresInput: 'rename' },
            { key: 'change-directory', label: '改目录', requiresInput: 'directory' },
            { key: 'cancel', label: '取消' }
          ]
        }}
        onRespond={onRespond}
        onCancel={() => {}}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('新文件名（不含路径）'), {
      target: { value: 'review-v2.md' }
    })
    fireEvent.click(screen.getByRole('button', { name: '改名' }))
    expect(onRespond).toHaveBeenCalledWith('rename:review-v2.md')

    fireEvent.change(screen.getByPlaceholderText('相对工作区的目录'), {
      target: { value: 'reports/final/' }
    })
    fireEvent.click(screen.getByRole('button', { name: '改目录' }))
    expect(onRespond).toHaveBeenCalledWith('change-directory:reports/final')
  })

  it('shows stale message and hides actions when uiStatus is stale', () => {
    const onRespond = vi.fn()
    render(
      <ArtifactDecisionCard
        request={{
          decisionId: 'd1',
          requestId: 'r1',
          sessionId: 's1',
          toolUseId: 't1',
          attempt: 1,
          kind: 'overwrite',
          options: [
            { key: 'overwrite', label: '覆盖' },
            { key: 'cancel', label: '取消' }
          ]
        }}
        uiStatus="stale"
        onRespond={onRespond}
        onCancel={() => {}}
      />
    )
    expect(screen.getByRole('status').textContent).toContain('该决策已处理或已失效')
    expect(screen.queryByRole('button', { name: '覆盖' })).toBeNull()
    expect(onRespond).not.toHaveBeenCalled()
  })
})
