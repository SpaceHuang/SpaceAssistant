import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { changeAppLocale } from '../../i18n/localeSync'
import { StorageSettingsTab } from './StorageSettingsTab'

describe('StorageSettingsTab', () => {
  const overview = vi.fn()
  const audit = vi.fn()
  const clear = vi.fn()
  const compact = vi.fn()
  const subscribe = vi.fn()
  let overviewResult: any
  beforeEach(async () => {
    overview.mockClear()
    audit.mockClear()
    clear.mockClear()
    compact.mockClear()
    subscribe.mockClear()
    await changeAppLocale('zh-CN')
    overviewResult = { collectedAt: '2026-10-10T00:00:00.000Z', status: 'partial', totalBytes: null,
      database: { dbBytes: 1024, walBytes: 0, shmBytes: 0, complete: true },
      spill: { files: 2, observedBytes: 512, totalBytes: 512, classification: 'unknown', sourceOfTruthBytes: null, degradableBytes: null,
        orphanBytes: null, complete: false, errorCodes: ['SPILL_REFERENCE_INDEX_UNAVAILABLE'] },
      spillDegraded: { files: 0, observedBytes: 0, totalBytes: 0, complete: true, errorCodes: [] },
      pendingGc: { files: 0, bytes: 0, complete: true }, tables: { messages: { rows: 2, textBytes: 300 } } }
    overview.mockResolvedValue(overviewResult)
    audit.mockResolvedValue({ collectedAt: '2026-10-10T00:00:00.000Z', status: 'complete', errorCodes: [], canonicalCoverage: null,
      canonicalSessionCoverage: null, canonicalRequiredData: null, messageBodyCoverage: null,
      strictSpillReferences: { complete: true, descriptors: 1, uniqueLocators: 1, errorCodes: [] } })
    clear.mockResolvedValue({ cacheRows: 2, eligibilityRows: 1 })
    compact.mockResolvedValue({ archivePath: '/archive', bytesBefore: 100, bytesAfter: 60, reclaimedPages: 2 })
    subscribe.mockReturnValue(() => {})
    window.api = { ...window.api, storageGetOverview: overview, storageRunAudit: audit, storageClearCache: clear, storageCompact: compact, storageOnMaintenanceProgress: subscribe } as typeof window.api
  })
  afterEach(cleanup)

  it('shows categorized usage and refreshes after cache clear', async () => {
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    expect(screen.getByText('来源正文 spill')).toBeTruthy()
    expect((await screen.findAllByText('完整性分类暂不可用')).length).toBeGreaterThan(0)
    const totalRow = screen.getByText('存储总量').closest('tr')!
    expect(within(totalRow).getByText('—')).toBeTruthy()
    expect(overview).toHaveBeenCalledTimes(1)
    expect(audit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '清缓存' }))
    await waitFor(() => expect(clear).toHaveBeenCalledOnce())
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2))
    expect(overview).toHaveBeenLastCalledWith(true)
  })

  it('runs the strict audit only after an explicit action and keeps its state separate', async () => {
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    expect(audit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '检查完整性' }))
    await waitFor(() => expect(audit).toHaveBeenCalledOnce())
    expect(await screen.findByText('完整性检查已完成')).toBeTruthy()
    expect(overview).toHaveBeenCalledTimes(1)
  })

  it('shows partial audit status and stable error codes instead of presenting a directory scan as complete', async () => {
    audit.mockResolvedValueOnce({ collectedAt: '2026-10-10T00:00:00.000Z', status: 'partial', errorCodes: ['SPILL_ROOT_NOT_DIRECTORY'],
      canonicalCoverage: null, canonicalSessionCoverage: null, canonicalRequiredData: null, messageBodyCoverage: null,
      strictSpillReferences: { complete: true, descriptors: 0, uniqueLocators: 0, errorCodes: [] } })
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    fireEvent.click(screen.getByRole('button', { name: '检查完整性' }))
    expect((await screen.findAllByText('检查结果不完整')).length).toBeGreaterThanOrEqual(1)
    expect(await screen.findByText(/SPILL_ROOT_NOT_DIRECTORY/)).toBeTruthy()
  })

  it('ignores an older overview response after a newer manual refresh completes', async () => {
    let resolveFirst!: (value: any) => void
    let resolveSecond!: (value: any) => void
    overview.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const view = render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    fireEvent.click(screen.getByRole('button', { name: '清缓存' }))
    await waitFor(() => expect(resolveSecond).toBeTypeOf('function'))
    await act(async () => { resolveSecond({ ...overviewResult, database: { dbBytes: 2048, walBytes: 0, shmBytes: 0, complete: true } }) })
    await screen.findByText('2.0 KB')
    await act(async () => { resolveFirst({ ...overviewResult, database: { dbBytes: 1024, walBytes: 0, shmBytes: 0, complete: true } }) })
    expect(screen.getByText('2.0 KB')).toBeTruthy()
    view.unmount()
  })

  it('keeps the overview after audit failure and allows retry', async () => {
    audit.mockRejectedValueOnce(new Error('STORAGE_PROFILE_WORKER_ERROR')).mockResolvedValueOnce({
      collectedAt: '2026-10-10T00:00:00.000Z', status: 'complete', errorCodes: [], canonicalCoverage: null,
      canonicalSessionCoverage: null, canonicalRequiredData: null, messageBodyCoverage: null,
      strictSpillReferences: { complete: true, descriptors: 1, uniqueLocators: 1, errorCodes: [] }
    })
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('300 B')
    fireEvent.click(screen.getByRole('button', { name: '检查完整性' }))
    expect((await screen.findAllByText('完整性检查失败，可重试')).length).toBeGreaterThan(0)
    expect(screen.getByText('300 B')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '检查完整性' }))
    expect(await screen.findByText('完整性检查已完成')).toBeTruthy()
    expect(overview).toHaveBeenCalledTimes(1)
  })

  it('does not update UI state when the initial overview resolves after unmount', async () => {
    let resolveOverview!: (value: any) => void
    overview.mockImplementationOnce(() => new Promise((resolve) => { resolveOverview = resolve }))
    const view = render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    view.unmount()
    resolveOverview({ collectedAt: '2026-10-10T00:00:00.000Z', status: 'complete', totalBytes: 1,
      database: { dbBytes: 1, walBytes: 0, shmBytes: 0, complete: true }, spill: { files: 0, observedBytes: 0, totalBytes: 0,
        classification: 'complete', sourceOfTruthBytes: 0, degradableBytes: 0, orphanBytes: 0, complete: true, errorCodes: [] },
      spillDegraded: { files: 0, observedBytes: 0, totalBytes: 0, complete: true, errorCodes: [] },
      pendingGc: { files: 0, bytes: 0, complete: true }, tables: { messages: null } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('会话存储')).toBeNull()
  })

  it('runs archive compaction and presents completion progress', async () => {
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    fireEvent.click(screen.getByRole('button', { name: '归档并压缩' }))
    await waitFor(() => expect(compact).toHaveBeenCalledOnce())
    expect(await screen.findByText('维护完成')).toBeTruthy()
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2))
    expect(overview).toHaveBeenLastCalledWith(true)
  })

  it('explains a busy rejection with the dedicated copy instead of the generic failure', async () => {
    compact.mockRejectedValueOnce(new Error('STORAGE_MAINTENANCE_BUSY'))
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    fireEvent.click(screen.getByRole('button', { name: '归档并压缩' }))
    expect(await screen.findByText('仍有会话运行中，请等待会话结束后再压缩')).toBeTruthy()
    expect(screen.queryByText('存储维护失败，请稍后重试')).toBeNull()
    await waitFor(() => expect(screen.getByRole('button', { name: '归档并压缩' }).className).not.toContain('ant-btn-loading'))
  })

  it('explains an insufficient-space rejection with the dedicated copy instead of the generic failure', async () => {
    compact.mockRejectedValueOnce(new Error('STORAGE_MAINTENANCE_INSUFFICIENT_SPACE'))
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    fireEvent.click(screen.getByRole('button', { name: '归档并压缩' }))
    expect(await screen.findByText('磁盘剩余空间不足，归档压缩需要约与数据库相当的空间')).toBeTruthy()
    expect(screen.queryByText('存储维护失败，请稍后重试')).toBeNull()
  })

  it('derives percent from byte progress and falls back to phase tiers without bytes', async () => {
    let handler!: (progress: any) => void
    subscribe.mockImplementation((callback: typeof handler) => { handler = callback; return () => {} })
    let resolveCompact!: (value: unknown) => void
    compact.mockImplementationOnce(() => new Promise((resolve) => { resolveCompact = resolve }))
    render(<ConfigProvider><App><StorageSettingsTab /></App></ConfigProvider>)
    await screen.findByText('会话存储')
    fireEvent.click(screen.getByRole('button', { name: '归档并压缩' }))
    await act(async () => { handler({ phase: 'archive', completedBytes: 50, totalBytes: 100 }) })
    expect(screen.getByText('50%')).toBeTruthy()
    await act(async () => { handler({ phase: 'archive', completedBytes: 100, totalBytes: 100 }) })
    // antd 在 percent=100 时以成功图标替代文本，用状态类断言满进度。
    expect(document.querySelector('.ant-progress-text')?.textContent).toBe('100%')
    await act(async () => { handler({ phase: 'vacuum' }) })
    expect(screen.getByText('55%')).toBeTruthy()
    await act(async () => {
      resolveCompact({ archivePath: '/archive', bytesBefore: 100, bytesAfter: 60, reclaimedPages: 2 })
    })
    expect(await screen.findByText('维护完成')).toBeTruthy()
    expect(document.querySelector('.ant-progress')!.className).toContain('ant-progress-status-success')
  })
})
