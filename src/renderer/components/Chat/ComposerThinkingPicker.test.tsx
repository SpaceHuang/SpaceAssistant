import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ComposerThinkingPicker } from './ComposerThinkingPicker'

function renderPicker(props: Partial<React.ComponentProps<typeof ComposerThinkingPicker>> = {}) {
  const onSelect = vi.fn()
  render(
    <ComposerThinkingPicker
      value="medium"
      overridden={false}
      globalEffort="medium"
      onSelect={onSelect}
      {...props}
    />
  )
  return { onSelect }
}

describe('ComposerThinkingPicker（§5.2 会话级强度覆盖）', () => {
  it('未覆盖时展示「默认（<全局档位>）」', () => {
    renderPicker({ value: 'medium', overridden: false, globalEffort: 'medium' })
    expect(screen.getByRole('button', { name: /默认（中）/ })).not.toBeNull()
  })

  it('已覆盖时展示显式档位文案', () => {
    renderPicker({ value: 'low', overridden: true, globalEffort: 'high' })
    expect(screen.getByRole('button', { name: /低/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /默认/ })).toBeNull()
  })

  it('点击弹出 5 项：默认 / 关闭 / 低 / 中 / 高', () => {
    renderPicker()
    fireEvent.click(screen.getByRole('button', { name: /默认（中）/ }))
    const options = screen.getAllByRole('menuitem')
    expect(options.map((o) => o.textContent)).toEqual(['默认', '关闭', '低', '中', '高'])
  })

  it('选择「默认」回调 null（清除覆盖）', () => {
    const { onSelect } = renderPicker({ value: 'low', overridden: true })
    fireEvent.click(screen.getByRole('button', { name: /低/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '默认' }))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('选择「高」回调 high', () => {
    const { onSelect } = renderPicker()
    fireEvent.click(screen.getByRole('button', { name: /默认（中）/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '高' }))
    expect(onSelect).toHaveBeenCalledWith('high')
  })

  it('模型不支持 Thinking 时控件禁用并提示（§5.2 能力联动；评审 B2：disabled 控件原生 title 不可达，须用 Tooltip）', async () => {
    renderPicker({ disabled: true, disabledReason: '该模型不支持 Thinking' })
    const button = screen.getByRole('button', { name: /默认（中）/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    // Tooltip 挂在外层 span（disabled 元素不派发鼠标事件）；fireEvent.mouseEnter 不冒泡，须直接对 span 派发
    fireEvent.mouseEnter(button.closest('span')!)
    // antd Tooltip 默认 mouseEnterDelay=0.1s，异步弹出
    await waitFor(() => expect(document.querySelector('.ant-tooltip')).not.toBeNull())
    expect(document.querySelector('.ant-tooltip')?.textContent).toContain('该模型不支持 Thinking')
  })
})
