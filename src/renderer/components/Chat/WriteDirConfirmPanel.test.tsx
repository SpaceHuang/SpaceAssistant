import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WriteDirConfirmPanel } from './WriteDirConfirmPanel'

const candidates = [
  { key: 'A', dir: 'D:/proj/sub1', label: 'sub1' },
  { key: 'B', dir: 'D:/proj', label: '.' }
]

describe('WriteDirConfirmPanel', { timeout: 60000 }, () => {
  it('submits selected candidate', () => {
      const onRespond = vi.fn()
      render(
        <WriteDirConfirmPanel
          requestId="r1"
          sessionId="s1"
          candidates={candidates}
          onRespond={onRespond}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }))
      expect(onRespond).toHaveBeenCalledWith({ type: 'candidate', key: 'A' })
  })

  it('submits custom dir', () => {
    const onRespond = vi.fn()
    render(
      <WriteDirConfirmPanel
        requestId="r1"
        sessionId="s1"
        candidates={candidates}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByText('自定义输入目录'))
    fireEvent.change(screen.getByPlaceholderText(/输入相对工作目录/), {
      target: { value: 'D:/proj/new' }
    })
    fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }))
    expect(onRespond).toHaveBeenCalledWith({ type: 'custom', dir: 'D:/proj/new' })
  })

  it('submits null on cancel', () => {
    const onRespond = vi.fn()
    render(
      <WriteDirConfirmPanel
        requestId="r1"
        sessionId="s1"
        candidates={candidates}
        onRespond={onRespond}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    expect(onRespond).toHaveBeenCalledWith(null)
  })

  it('renders recent session candidate label via i18n', () => {
    render(
      <WriteDirConfirmPanel
        requestId="r1"
        sessionId="s1"
        candidates={[{ key: 'A', dir: 'D:/proj/Script', label: 'Script', labelKind: 'recentSession' }]}
        onRespond={vi.fn()}
      />
    )
    expect(screen.getByText('最近会话 · Script')).toBeTruthy()
  })
})
