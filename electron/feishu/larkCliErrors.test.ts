import { describe, expect, it } from 'vitest'
import { parseLarkCliError } from './larkCliErrors'

describe('larkCliErrors', () => {
  it('maps not configured', () => {
    const r = parseLarkCliError('Error: not configured, run config init')
    expect(r.message).toContain('应用配置')
  })

  it('maps scope errors', () => {
    const r = parseLarkCliError('permission scope im:message missing')
    expect(r.hint).toBeTruthy()
  })
})
