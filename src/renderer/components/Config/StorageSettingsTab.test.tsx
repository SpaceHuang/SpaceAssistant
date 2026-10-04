import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { changeAppLocale } from '../../i18n/localeSync'
import { StorageSettingsTab } from './StorageSettingsTab'

describe('StorageSettingsTab', () => {
  const profile = vi.fn()
  const clear = vi.fn()
  const compact = vi.fn()
  const subscribe = vi.fn()
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    profile.mockReset()
    clear.mockReset()
    compact.mockReset()
    subscribe.mockReset()
    profile.mockResolvedValue({ dbBytes: 1024, spillFiles: { totalBytes: 512, sourceOfTruthBytes: 256, degradableBytes: 128, orphanBytes: 128 }, tables: { messages: { textBytes: 300 }, canonicalHistory: { textBytes: 400 }, transcriptSnapshots: { textBytes: 200 } } })
    clear.mockResolvedValue({ cacheRows: 2, eligibilityRows: 1 })
    compact.mockResolvedValue({ archivePath: '/archive', bytesBefore: 100, bytesAfter: 60, reclaimedPages: 2 })
    subscribe.mockReturnValue(() => {})
    window.api = { ...window.api, storageGetProfile: profile, storageClearCache: clear, storageCompact: compact, storageOnMaintenanceProgress: subscribe } as typeof window.api
  })
  afterEach(cleanup)

  it('shows categorized usage and refreshes after cache clear', async () => {
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    expect(screen.getByText('来源正文 spill')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清缓存' }))
    await waitFor(() => expect(clear).toHaveBeenCalledOnce())
    expect(profile.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('clears failed progress so a busy maintenance operation can be retried', async () => {
    compact.mockRejectedValueOnce(new Error('STORAGE_MAINTENANCE_BUSY: active turn'))
    compact.mockResolvedValueOnce({ archivePath: '/archive', bytesBefore: 100, bytesAfter: 60, reclaimedPages: 2 })
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    fireEvent.click(screen.getByRole('button', { name: '归档并压缩' }))
    await waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: '归档并压缩' }).getAttribute('disabled')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '归档并压缩' }))
    await waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
  })

  it('runs archive compaction and presents completion progress', async () => {
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    fireEvent.click(screen.getByRole('button', { name: '归档并压缩' }))
    await waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('维护完成')).toBeTruthy()
  })
})
