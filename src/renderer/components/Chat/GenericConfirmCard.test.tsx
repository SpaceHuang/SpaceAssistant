import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GenericConfirmCard } from './GenericConfirmCard'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../shared/builtinToolDefinitions'
import type { ToolCallRecord } from '../../../shared/domainTypes'

vi.mock('../../i18n/useTypedTranslation', () => ({
  useTypedTranslation: () => ({
    t: (key: string) => key
  })
}))

// 真机缺陷教训：confirming 工具若没有批准入口（无确认卡分支），桌面 lane 会永久挂起。
// 对全部内置工具 + MCP 动态工具形态，GenericConfirmCard 必须给出可用批准按钮。
describe('GenericConfirmCard（confirming 批准入口兜底，全工具守卫）', () => {
  const toolNames = [
    ...new Set([
      ...BUILTIN_TOOL_DEFINITIONS.map((d) => d.name),
      'mcp_dynamic_server_tool',
      'toolkit.find',
      'tool_search',
      'history.read',
      'skills.read',
      'switch_work_dir'
    ])
  ]

  it.each(toolNames)('%s：confirming 状态渲染批准/拒绝按钮且回传结果', (toolName) => {
    const onConfirm = vi.fn()
    const record = {
      id: `call-${toolName}`,
      toolName,
      status: 'confirming',
      input: { path: 'demo/x.txt', pattern: 'p' }
    } as unknown as ToolCallRecord
    render(<GenericConfirmCard record={record} onConfirm={onConfirm} />)
    const allow = screen.getByText('confirm.generic.allow')
    expect(screen.getByText('confirm.generic.deny')).toBeDefined()
    fireEvent.click(allow)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0]?.[0]).toBe(true)
    onConfirm.mockClear()
    fireEvent.click(screen.getByText('confirm.generic.deny'))
    expect(onConfirm.mock.calls[0]?.[0]).toBe(false)
  })

  it('超长参数摘要被截断（不撑爆卡片）', () => {
    const record = {
      id: 'c-big',
      toolName: 'tool_search',
      status: 'confirming',
      input: { blob: 'x'.repeat(5000) }
    } as unknown as ToolCallRecord
    render(<GenericConfirmCard record={record} onConfirm={vi.fn()} />)
    expect(screen.getByText(/…$/)).toBeDefined()
  })
})
