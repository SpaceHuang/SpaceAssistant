import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('MCP tool card theme styles', () => {
  it('defines status, duration and reduced-motion styles using theme tokens', () => {
    const css = fs.readFileSync(path.resolve(__dirname, './layout.css'), 'utf8')
    expect(css).toContain('.tool-row__status')
    expect(css).toContain('.tool-row__duration')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('var(--sa-success)')
    expect(css).toContain('var(--sa-danger)')
  })
})
