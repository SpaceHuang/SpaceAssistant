import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { WorkDirList, validateWorkDirProfiles, buildFeishuAliasHint } from './WorkDirList'
import type { WorkDirProfile } from '../../../shared/feishuTypes'

const profiles: WorkDirProfile[] = [
  { id: 'p1', name: 'Project A', path: '/a', isDefault: true },
  { id: 'p2', name: 'Project B', path: '/b' }
]

function renderWithI18n(ui: React.ReactElement) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ConfigProvider>
        <App>
          {ui}
        </App>
      </ConfigProvider>
    </I18nextProvider>
  )
}

describe('validateWorkDirProfiles', () => {
  const t = (key: string) => key

  it('空列表时阻止保存', () => {
    expect(validateWorkDirProfiles([], t)).toBe('workDir.validation.atLeastOne')
  })

  it('名称重复时阻止', () => {
    expect(
      validateWorkDirProfiles([
        { id: '1', name: 'A', path: '/a', isDefault: true },
        { id: '2', name: 'A', path: '/b' }
      ], t)
    ).toBe('workDir.validation.nameDuplicate')
  })
})

describe('buildFeishuAliasHint', () => {
  const t = (key: string, opts?: Record<string, unknown>) => {
    if (opts?.alias) return key + '|alias=' + opts.alias
    return key
  }

  it('留空时提示按名称匹配', () => {
    expect(buildFeishuAliasHint('', t)).toBe('workDir.aliasHint.empty')
    expect(buildFeishuAliasHint('  ', t)).toBe('workDir.aliasHint.empty')
  })

  it('随输入别名联动示例文案', () => {
    expect(buildFeishuAliasHint('SX', t)).toBe('workDir.aliasHint.withAlias|alias=SX')
  })
})

describe('WorkDirList', () => {
  beforeEach(() => {
    vi.stubGlobal('api', {
      dialogSelectDirectory: vi.fn(),
      workdirCheckWritable: vi.fn().mockResolvedValue({ ok: true })
    })
  })

  it('显示工作目录列表', () => {
    renderWithI18n(
      <WorkDirList profiles={profiles} onChange={vi.fn()} />
    )
    expect(screen.getByText('Project A')).toBeTruthy()
    expect(screen.getByText('Project B')).toBeTruthy()
  })

  it('空列表时显示提示', () => {
    renderWithI18n(
      <WorkDirList profiles={[]} onChange={vi.fn()} />
    )
    expect(screen.getByText('请添加工作目录')).toBeTruthy()
  })

  it('尝试删除最后一个目录时阻止', () => {
    const messageError = vi.fn()
    vi.spyOn(App, 'useApp').mockReturnValue({ message: { error: messageError, warning: vi.fn(), success: vi.fn() } } as never)
    renderWithI18n(
      <WorkDirList profiles={[profiles[0]!]} onChange={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(messageError).toHaveBeenCalledWith('请至少保留一个工作目录')
  })
})
