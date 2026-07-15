import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { RemoteSecurityUpgradeModal } from './RemoteSecurityUpgradeModal'
import { planRemoteSecurityMigration } from '../../../shared/remoteSecurityMigration'

function renderModal(overrides: {
  onCommit?: (patch: unknown) => Promise<void>
  onCancel?: () => void
} = {}) {
  const plan = planRemoteSecurityMigration({ isNewInstall: true })
  const onCommit = overrides.onCommit ?? vi.fn().mockResolvedValue(undefined)
  const onCancel = overrides.onCancel ?? vi.fn()
  render(
    <ConfigProvider>
      <App>
        <RemoteSecurityUpgradeModal open plan={plan} onCommit={onCommit} onCancel={onCancel} />
      </App>
    </ConfigProvider>
  )
  return { plan, onCommit, onCancel }
}

/** antd inserts a space between two CJK chars in buttons; normalize before matching. */
function clickButton(text: string) {
  const btn = screen
    .getAllByRole('button')
    .find((b) => (b.textContent ?? '').replace(/\s+/g, '') === text)
  if (!btn) throw new Error(`button not found: ${text}`)
  fireEvent.click(btn)
}

describe('RemoteSecurityUpgradeModal', () => {
  it('renders the effective-strength summary', () => {
    renderModal()
    expect(screen.getByText(/当前生效强度/)).toBeTruthy()
  })

  it('commits the recommended preset by default on confirm', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    renderModal({ onCommit })
    clickButton('确认并保存')
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    const patch = onCommit.mock.calls[0][0]
    expect(patch.common.remoteScriptRequiresConfirm).toBe(false)
    expect(patch.common.remoteBrowserActRequiresConfirm).toBe(true)
  })

  it('commits the safer preset when selected', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    renderModal({ onCommit })
    fireEvent.click(screen.getByText(/更安全/))
    clickButton('确认并保存')
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    const patch = onCommit.mock.calls[0][0]
    expect(patch.common.remoteScriptRequiresConfirm).toBe(true)
    expect(patch.common.remoteBrowserNavigateRequiresConfirm).toBe(true)
  })

  it('cancel does not commit', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    renderModal({ onCommit, onCancel })
    clickButton('取消')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
