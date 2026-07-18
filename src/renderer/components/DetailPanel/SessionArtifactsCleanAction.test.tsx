import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntApp } from 'antd'
import { SessionArtifactsCleanAction } from './SessionArtifactsCleanAction'

function renderWithApp(ui: React.ReactNode) {
  return render(<AntApp>{ui}</AntApp>)
}

describe('SessionArtifactsCleanAction', () => {
  it('requires a second confirmation before cleaning references', async () => {
    const clean = vi.spyOn(window.api, 'artifactCleanSession').mockResolvedValue({ deleted: ['ref-1'], skipped: [] })
    renderWithApp(<SessionArtifactsCleanAction sessionId="sess-1" />)

    fireEvent.click(screen.getByRole('button', { name: '清理草稿' }))
    const firstDialog = screen.getByRole('dialog', { name: '清理本会话草稿？' })
    fireEvent.click(within(firstDialog).getByRole('checkbox'))
    fireEvent.click(within(firstDialog).getByRole('button', { name: /清\s*理/ }))

    expect(clean).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText('确认清理研究资料？')).toBeTruthy()
    })
    const secondDialog = screen.getAllByRole('dialog').find((dialog) =>
      within(dialog).queryByText('确认清理研究资料？')
    )!
    fireEvent.click(within(secondDialog).getByRole('button', { name: /清\s*理/ }))
    await waitFor(() => {
      expect(clean).toHaveBeenCalledWith({ sessionId: 'sess-1', includeReferences: true })
    })
  })
})
