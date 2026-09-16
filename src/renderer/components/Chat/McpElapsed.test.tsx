import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { McpElapsed } from './McpElapsed'

describe('McpElapsed', () => {
  it('updates an executing duration from startedAt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    render(<McpElapsed startedAt={7_000} />)
    expect(screen.getByTestId('mcp-elapsed').textContent).toBe('3s')
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByTestId('mcp-elapsed').textContent).toBe('5s')
    vi.useRealTimers()
  })
})
