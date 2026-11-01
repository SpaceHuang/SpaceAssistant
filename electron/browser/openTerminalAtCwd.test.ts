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
import { spawn } from 'node:child_process'

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

  it('encodes a macOS cwd as literal shell data before embedding it in AppleScript', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const cwd = '/tmp/a $(touch injected) `touch injected2` \'quoted\' \\folder'
      expect(openTerminalAtCwd(cwd, ctx, { allowedWorkDir: cwd })).toEqual({ ok: true })
      const script = vi.mocked(spawn).mock.calls.at(-1)?.[1]?.[1] as string
      expect(script).toContain('$(touch injected)')
      expect(script).toContain('`touch injected2`')
      expect(script).toContain("'\\\\''quoted'\\\\''")
      expect(script).toContain('\\\\folder')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
})
