import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryTierSelect } from './MemoryTierSelect'

describe('MemoryTierSelect（确认卡片记忆范围选择器）', () => {
  it('无可用档位时不渲染（保持旧交互）', () => {
    const { container } = render(<MemoryTierSelect options={[]} value={null} onChange={() => undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('展示档位（默认仅此一次）并回传 tier / null', () => {
    const onChange = vi.fn()
    const options = [{ label: '记住 ping baidu.com', tier: 1 }]
    render(<MemoryTierSelect options={options} value={null} onChange={onChange} />)
    const select = screen.getByRole('combobox')
    expect(select).toBeTruthy()
    fireEvent.change(select, { target: { value: '1' } })
    expect(onChange).toHaveBeenCalledWith(1)
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith(null)
  })
})
