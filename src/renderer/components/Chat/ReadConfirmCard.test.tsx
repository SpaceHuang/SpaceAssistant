import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReadConfirmCard } from './ReadConfirmCard'
import type { ToolCallRecord } from '../../../shared/domainTypes'

vi.mock('../../i18n/useTypedTranslation', () => ({
  useTypedTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let text = key
      for (const [k, v] of Object.entries(options ?? {})) text = text.replace(`{{${k}}}`, String(v))
      return text
    }
  })
}))

function confirmingGrepRecord(): ToolCallRecord {
  return {
    id: 'call-1',
    toolName: 'grep',
    status: 'confirming',
    input: { pattern: 'SAFE_TEST_ONLY', path: '.env' }
  } as unknown as ToolCallRecord
}

describe('ReadConfirmCard（读取类工具确认卡，真机验证发现的桌面批准入口缺失修复）', () => {
  it('grep confirming：显示动作摘要、敏感说明与批准/拒绝按钮', () => {
    const onConfirm = vi.fn()
    render(<ReadConfirmCard record={confirmingGrepRecord()} onConfirm={onConfirm} />)
    expect(screen.getByText(/confirm\.read\.grepAction/)).toBeDefined()
    expect(screen.getByText('confirm.read.sensitiveNote')).toBeDefined()
    const allow = screen.getByText('confirm.read.allow')
    expect(screen.getByText('confirm.read.deny')).toBeDefined()
    fireEvent.click(allow)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0]?.[0]).toBe(true)
  })

  it('拒绝路径回传 approved=false', () => {
    const onConfirm = vi.fn()
    render(<ReadConfirmCard record={confirmingGrepRecord()} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByText('confirm.read.deny'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0]?.[0]).toBe(false)
  })

  it('path 缺失时回退到占位摘要（不抛错）', () => {
    const record = { id: 'c2', toolName: 'read_file', status: 'confirming', input: {} } as unknown as ToolCallRecord
    const onConfirm = vi.fn()
    render(<ReadConfirmCard record={record} onConfirm={onConfirm} />)
    expect(screen.getByText(/confirm\.read\.readAction/)).toBeDefined()
  })
})
