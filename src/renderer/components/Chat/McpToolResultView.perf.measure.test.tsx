import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { McpToolResultView } from './McpToolResultView'

function measureRender(chars: number) {
  const text = 'a'.repeat(chars)
  const started = performance.now()
  const result = render(<McpToolResultView display={{ isEmpty: false, text, displayMode: chars > 512 * 1024 ? 'huge' : chars > 64 * 1024 ? 'long' : chars > 8 * 1024 ? 'medium' : 'short', blocks: [{ kind: 'text', text }] }} />)
  return { elapsed: performance.now() - started, result }
}

describe('McpToolResultView performance measurements', () => {
  it.each([
    ['8KB', 8 * 1024],
    ['64KB', 64 * 1024],
    ['512KB', 512 * 1024 + 1]
  ])('%s remains responsive and reports the measured render time', (label, chars) => {
    const { elapsed, result } = measureRender(chars)
    console.info(`[mcp-perf] ${label}: ${elapsed.toFixed(2)}ms`)
    expect(elapsed).toBeLessThan(1000)
    if (chars > 512 * 1024) {
      expect(screen.getByText('结果过大，仅显示摘要')).toBeTruthy()
      expect(result.container.querySelector('pre')).toBeNull()
    }
    result.unmount()
  })
})
