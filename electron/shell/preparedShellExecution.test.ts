import { describe, expect, it } from 'vitest'
import { assertPreparedShellExecutionCurrent, captureShellPathSnapshot, prepareShellExecution, PreparedShellStaleError, validatePreparedShellExecution } from './preparedShellExecution'

const makeInput = () => ({
  command: 'echo ok',
  profile: { id: 'bash', dialect: 'posix-bash' as const, executable: '/bin/bash', encoding: 'utf8' },
  spawnSpec: { executable: '/bin/bash', args: ['-c', 'echo ok'], shellId: 'bash' },
  cwd: '/tmp/project', timeoutMs: 30000, ioMaxBytes: 102400, environment: { PATH: '/usr/bin', LANG: 'C.UTF-8' },
  facts: { operations: [{ verb: 'echo' }], analysisCompleteness: 'complete' as const },
  configRevision: 'config-1', policyRevision: 'policy-1'
})

describe('PreparedShellExecution', () => {
  it('确认后原始输入变化不会改变 argv/env/profile/cwd/timeout/facts 快照', () => {
    const input = makeInput()
    const prepared = prepareShellExecution(input)
    input.command = 'rm -rf /'
    input.cwd = '/tmp/changed'
    input.timeoutMs = 1
    input.profile.executable = '/tmp/changed-shell'
    input.spawnSpec.args[1] = 'changed'
    input.environment.PATH = '/tmp'
    ;(input.facts as { operations: Array<{ verb: string }> }).operations[0]!.verb = 'changed'
    expect(prepared.command).toBe('echo ok')
    expect(prepared.cwd).toBe('/tmp/project')
    expect(prepared.timeoutMs).toBe(30000)
    expect(prepared.ioMaxBytes).toBe(102400)
    expect(prepared.profile.executable).toBe('/bin/bash')
    expect(prepared.spawnSpec.args).toEqual(['-c', 'echo ok'])
    expect(prepared.environment.PATH).toBe('/usr/bin')
    expect(prepared.facts).toEqual({ operations: [{ verb: 'echo' }], analysisCompleteness: 'complete' })
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.profile)).toBe(true)
    expect(Object.isFrozen(prepared.spawnSpec)).toBe(true)
    expect(Object.isFrozen(prepared.facts)).toBe(true)
    expect(prepared.planDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('配置、环境或 cwd 变化时返回 stale reasons', () => {
    const input = makeInput()
    const prepared = prepareShellExecution(input)
    const result = validatePreparedShellExecution(prepared, { ...input, cwd: '/tmp/other', policyRevision: 'policy-2' })
    expect(result).toEqual({ stale: true, reasons: ['cwd', 'policyRevision'] })
    expect(() => assertPreparedShellExecutionCurrent(prepared, { ...input, cwd: '/tmp/other', policyRevision: 'policy-2' }))
      .toThrowError(PreparedShellStaleError)
    try {
      assertPreparedShellExecutionCurrent(prepared, { ...input, cwd: '/tmp/other', policyRevision: 'policy-2' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'PLAN_STALE', reasons: ['cwd', 'policyRevision'] })
    }
  })

  it('path realpath snapshot 变化时返回 PLAN_STALE', () => {
    const input = makeInput()
    const prepared = prepareShellExecution({ ...input, pathSnapshot: { '/tmp/project/tool': '/tmp/project/tool-v1' } })
    const result = validatePreparedShellExecution(prepared, {
      ...input,
      pathSnapshot: { '/tmp/project/tool': '/tmp/project/tool-v2' }
    })
    expect(result).toEqual({ stale: true, reasons: ['pathSnapshot'] })
  })

  it('依赖快照变化时返回 PLAN_STALE', () => {
    const input = makeInput()
    const prepared = prepareShellExecution({
      ...input,
      dependencySnapshot: { platform: 'darwin', executable: '/bin/bash', environmentFingerprint: 'env-1' }
    })
    const result = validatePreparedShellExecution(prepared, {
      ...input,
      dependencySnapshot: { platform: 'darwin', executable: '/bin/bash', environmentFingerprint: 'env-2' }
    })
    expect(result).toEqual({ stale: true, reasons: ['dependencySnapshot'] })
  })

  it('captures realpath and falls back for missing paths', async () => {
    const snapshot = await captureShellPathSnapshot(['/tmp', '/definitely/missing-shell-target'])
    expect(snapshot['/tmp']).toMatch(/(?:^|\/)tmp$/)
    expect(snapshot['/definitely/missing-shell-target']).toBe('/definitely/missing-shell-target')
  })
})
