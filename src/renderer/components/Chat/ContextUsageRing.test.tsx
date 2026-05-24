import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ContextUsageRing } from './ContextUsageRing'

describe('ContextUsageRing', () => {
  it('renders nothing when usage is null', () => {
    const { container } = render(<ContextUsageRing usage={null} maxContext={200000} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders usage when provided', () => {
    render(<ContextUsageRing usage={{ input_tokens: 1000, output_tokens: 500 }} maxContext={200000} />)
    expect(screen.getByText('1,500')).toBeDefined()
  })

  it('renders with low usage', () => {
    const { container } = render(<ContextUsageRing usage={{ input_tokens: 1000 }} maxContext={200000} />)
    const circles = container.querySelectorAll('circle')
    expect(circles.length).toBe(2)
  })

  it('renders with medium usage', () => {
    const { container } = render(<ContextUsageRing usage={{ input_tokens: 150000 }} maxContext={200000} />)
    const circles = container.querySelectorAll('circle')
    expect(circles.length).toBe(2)
  })

  it('renders with high usage', () => {
    const { container } = render(<ContextUsageRing usage={{ input_tokens: 190000 }} maxContext={200000} />)
    const circles = container.querySelectorAll('circle')
    expect(circles.length).toBe(2)
  })

  it('caps ratio at 100%', () => {
    const { container } = render(<ContextUsageRing usage={{ input_tokens: 300000 }} maxContext={200000} />)
    const circles = container.querySelectorAll('circle')
    expect(circles.length).toBe(2)
  })

  it('renders cache breakdown in tooltip', async () => {
    render(
      <ContextUsageRing
        usage={{ input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 300, output_tokens: 200 }}
        maxContext={200000}
      />
    )
    expect(screen.getByText('2,000')).toBeDefined()
  })

  it('formats numbers with comma separators', () => {
    render(<ContextUsageRing usage={{ input_tokens: 1234567, output_tokens: 7654321 }} maxContext={10000000} />)
    expect(screen.getByText('8,888,888')).toBeDefined()
  })

  it('handles zero usage', () => {
    render(<ContextUsageRing usage={{ input_tokens: 0, output_tokens: 0 }} maxContext={200000} />)
    expect(screen.getByText('0')).toBeDefined()
  })

  it('handles undefined output_tokens', () => {
    render(<ContextUsageRing usage={{ input_tokens: 1000 }} maxContext={200000} />)
    expect(screen.getByText('1,000')).toBeDefined()
  })
})
