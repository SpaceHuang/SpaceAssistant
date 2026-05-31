import { describe, expect, it, vi } from 'vitest'
import type { BrowserDetectContext } from './browserDependencyDetect'

const ctx: BrowserDetectContext = {
  isPackaged: false,
  appPath: '/app',
  devRoot: 'E:\\Develop\\SpaceAssistant'
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(() => ({ unref: vi.fn() }))
  }
})

import { openTerminalAtCwd } from './openTerminalAtCwd'

describe('openTerminalAtCwd', () => {
  it('rejects cwd outside whitelist', () => {
    const r = openTerminalAtCwd('C:\\evil', ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/不允许/)
  })

  it('accepts recommended cwd (devRoot in development)', () => {
    const r = openTerminalAtCwd(ctx.devRoot, ctx)
    expect(r.ok).toBe(true)
  })

  it('accepts session workDir when allowedWorkDir matches', () => {
    const workDir = 'D:\\Projects\\my-app'
    const r = openTerminalAtCwd(workDir, ctx, { allowedWorkDir: workDir })
    expect(r.ok).toBe(true)
  })

  it('rejects workDir mismatch', () => {
    const r = openTerminalAtCwd('D:\\other', ctx, { allowedWorkDir: ctx.devRoot })
    expect(r.ok).toBe(false)
  })
})
