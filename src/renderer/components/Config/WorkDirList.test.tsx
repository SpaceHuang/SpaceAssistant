import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { WorkDirList, validateWorkDirProfiles, buildFeishuAliasHint } from './WorkDirList'
import type { WorkDirProfile } from '../../../shared/feishuTypes'

const profiles: WorkDirProfile[] = [
  { id: 'p1', name: 'Project A', path: '/a', isDefault: true },
  { id: 'p2', name: 'Project B', path: '/b' }
]

describe('validateWorkDirProfiles', () => {
  it('空列表时阻止保存', () => {
    expect(validateWorkDirProfiles([])).toBe('请至少添加一个工作目录')
  })

  it('名称重复时阻止', () => {
    expect(
      validateWorkDirProfiles([
        { id: '1', name: 'A', path: '/a', isDefault: true },
        { id: '2', name: 'A', path: '/b' }
      ])
    ).toBe('工作目录名称不能重复')
  })
})

describe('buildFeishuAliasHint', () => {
  it('留空时提示按名称匹配', () => {
    expect(buildFeishuAliasHint('')).toContain('留空则只按名称匹配')
    expect(buildFeishuAliasHint('  ')).toContain('留空则只按名称匹配')
  })

  it('随输入别名联动示例文案', () => {
    expect(buildFeishuAliasHint('SX')).toBe(
      '仅用于飞书远程：在消息里用 @别名 或「在 SX 项目里…」指定此工作目录。例如别名 SX 时，可发 /sa @SX 跑测试。'
    )
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
    render(
      <ConfigProvider>
        <App>
          <WorkDirList profiles={profiles} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    expect(screen.getByText('Project A')).toBeTruthy()
    expect(screen.getByText('Project B')).toBeTruthy()
  })

  it('空列表时显示提示', () => {
    render(
      <ConfigProvider>
        <App>
          <WorkDirList profiles={[]} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    expect(screen.getByText('请添加工作目录')).toBeTruthy()
  })

  it('尝试删除最后一个目录时阻止', () => {
    const messageError = vi.fn()
    vi.spyOn(App, 'useApp').mockReturnValue({ message: { error: messageError, warning: vi.fn(), success: vi.fn() } } as never)
    render(
      <ConfigProvider>
        <App>
          <WorkDirList profiles={[profiles[0]!]} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(messageError).toHaveBeenCalledWith('请至少保留一个工作目录')
  })
})
