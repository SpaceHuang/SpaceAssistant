import { describe, expect, it } from 'vitest'
import { extractWindowsCdAnd, planShellExec } from './shellExecPlan'
import { resolveShellSpawnSpec } from '../tools/runShellExecutor'

describe('extractWindowsCdAnd', () => {
  it('parses quoted path', () => {
    const r = extractWindowsCdAnd('cd /d "E:\\app\\dir" && npx playwright install chromium')
    expect(r).toEqual({
      cwd: 'E:\\app\\dir',
      rest: 'npx playwright install chromium'
    })
  })

  it('parses unquoted path', () => {
    const r = extractWindowsCdAnd('cd /d E:\\app\\dir && echo ok')
    expect(r?.cwd).toBe('E:\\app\\dir')
    expect(r?.rest).toBe('echo ok')
  })

  it('returns null when no cd prefix', () => {
    expect(extractWindowsCdAnd('npx playwright install chromium')).toBeNull()
  })
})

describe('planShellExec', () => {
  it('uses spawn cwd instead of cd in cmd line on Windows', () => {
    if (process.platform !== 'win32') return
    const spec = resolveShellSpawnSpec(null)
    const plan = planShellExec(
      'cd /d "E:\\app\\dir" && npx --version',
      'E:\\session\\work',
      spec
    )
    expect(plan.cwd).toMatch(/app[\\/]dir$/i)
    expect(plan.command).toBe('npx --version')
    expect(plan.spawnArgs).toEqual(['/d', '/c', 'npx --version'])
    expect(plan.spawnArgs).not.toContain('/s')
  })
})
