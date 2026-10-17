/**
 * T2.6：WikiTab 受控改名流程（调用序列 + 失败回滚）与迁移报告查看（数据源 config.wiki.migration）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { WikiTab } from './WikiTab'
import { DEFAULT_WIKI_CONFIG } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'

function buttonByText(text: string): HTMLElement {
  const el = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.replace(/\s/g, '') === text
  )
  if (!el) throw new Error(`button not found: ${text}`)
  return el
}

function modalPrimaryButton(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.ant-modal-content .ant-btn-primary')
  if (!el) throw new Error('modal primary button not found')
  return el
}

function modalInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.ant-modal-content input[placeholder="llm-wiki"]')
  if (!el) throw new Error('modal input not found')
  return el
}

describe('WikiTab 受控改名（T2.6①）', () => {
  const wikiRenameRoot = vi.fn()

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    wikiRenameRoot.mockReset()
    window.api = {
      ...window.api,
      wikiRenameRoot,
      wikiMigrationStatus: vi.fn().mockResolvedValue({ pendingLegacyMigration: false, migration: undefined }),
      wikiInit: vi.fn().mockResolvedValue({ ok: true, rootPath: 'llm-wiki', skillInstalled: false }),
      skillInvalidateCache: vi.fn(),
      fileShowInExplorer: vi.fn()
    } as typeof window.api
  })

  afterEach(() => cleanup())

  function renderTab(onChange = vi.fn()) {
    render(
      <ConfigProvider locale={{}}>
        <App>
          <WikiTab wiki={{ ...DEFAULT_WIKI_CONFIG, rootPath: 'llm-wiki' }} onChange={onChange} />
        </App>
      </ConfigProvider>
    )
  }

  it('改名成功序列：rename IPC → onChange 配置更新', async () => {
    wikiRenameRoot.mockResolvedValue({ ok: true })
    const onChange = vi.fn()
    renderTab(onChange)

    fireEvent.click(buttonByText('改名'))
    await waitFor(() => expect(modalInput()).toBeTruthy())
    fireEvent.change(modalInput(), { target: { value: 'my-lib' } })
    fireEvent.click(modalPrimaryButton())

    await waitFor(() => {
      expect(wikiRenameRoot).toHaveBeenCalledWith({ newRootPath: 'my-lib' })
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rootPath: 'my-lib' }))
    })
  })

  it('改名失败回滚：不调用 onChange（配置保持原值），展示错误', async () => {
    wikiRenameRoot.mockResolvedValue({ ok: false, error: '目标目录名已被占用' })
    const onChange = vi.fn()
    renderTab(onChange)

    fireEvent.click(buttonByText('改名'))
    await waitFor(() => expect(modalInput()).toBeTruthy())
    fireEvent.change(modalInput(), { target: { value: 'my-lib' } })
    fireEvent.click(modalPrimaryButton())

    await waitFor(() => {
      expect(wikiRenameRoot).toHaveBeenCalled()
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WikiTab 迁移报告查看（T2.6② 数据源 config.wiki.migration）', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    window.api = {
      ...window.api,
      wikiRenameRoot: vi.fn(),
      wikiInit: vi.fn().mockResolvedValue({ ok: true, rootPath: 'llm-wiki', skillInstalled: false }),
      skillInvalidateCache: vi.fn(),
      fileShowInExplorer: vi.fn(),
      wikiMigrationStatus: vi.fn().mockResolvedValue({
        pendingLegacyMigration: true,
        legacyRoots: ['old-wiki'],
        migration: {
          status: 'completed',
          report: {
            startedAt: '2026-10-10T00:00:00Z',
            profiles: [{ workDir: 'E:\\a', rootDirName: 'old-wiki', status: 'migrated' }],
            conflicts: [{ path: 'llm-wiki/wiki/old.md', keptAs: 'old.from-p-12345678.md' }],
            renames: [{ from: 'llm-wiki/wiki/old.md', to: 'llm-wiki/wiki/old.from-p-12345678.md' }]
          }
        }
      })
    } as typeof window.api
  })

  afterEach(() => cleanup())

  it('点击迁移入口 → 从 wikiMigrationStatus().migration 渲染报告（冲突清单）', async () => {
    render(
      <ConfigProvider locale={{}}>
        <App>
          <WikiTab wiki={{ ...DEFAULT_WIKI_CONFIG, rootPath: 'llm-wiki' }} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )

    fireEvent.click(buttonByText('迁移本地Wiki'))
    expect(await screen.findByText('冲突双保留清单')).toBeTruthy()
    expect(screen.getByText(/old\.from-p-12345678\.md/)).toBeTruthy()
    expect(screen.getByText(/检测到 1 个本地 Wiki 根/)).toBeTruthy()
  })

  it('打开共享库目录按钮调用 showInExplorer（词汇路径）', async () => {
    render(
      <ConfigProvider locale={{}}>
        <App>
          <WikiTab wiki={{ ...DEFAULT_WIKI_CONFIG, rootPath: 'my-lib' }} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(buttonByText('打开共享库目录'))
    await waitFor(() => {
      expect(window.api.fileShowInExplorer).toHaveBeenCalledWith('llm-wiki')
    })
  })
})
