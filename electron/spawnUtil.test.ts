import { describe, expect, it } from 'vitest'
import { killProcessTree, runCommandWithTimeout, spawnCommandSafe } from './spawnUtil'

describe('spawnUtil', () => {
  it('spawns npm on Windows without EINVAL', async () => {
    const spawned = spawnCommandSafe('npm', ['--version'])
    expect('error' in spawned).toBe(false)
    if ('error' in spawned) return

    const version = await new Promise<string>((resolve, reject) => {
      let out = ''
      spawned.proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      spawned.proc.on('close', (code) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`exit ${code}`))
      })
      spawned.proc.on('error', reject)
    })

    expect(version.length).toBeGreaterThan(0)
  })

  it('MINOR：超时被 kill 时仍交付已收集的 stdout/stderr（不再整体丢弃留档）', async () => {
    const run = await runCommandWithTimeout(
      process.execPath,
      ['-e', 'process.stdout.write("partial-out");process.stderr.write("partial-err");setInterval(()=>{},1000)'],
      1500
    )
    expect(run.completed).toBe(false)
    expect(run.stdout).toContain('partial-out')
    expect(run.stderr).toContain('partial-err')
    expect(run.meta.stderrRawBytes).toBeGreaterThan(0)
  }, 15_000)

  it('killProcessTree terminates a child process', async () => {
    const spawned = spawnCommandSafe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    expect('error' in spawned).toBe(false)
    if ('error' in spawned) return

    await expect(killProcessTree(spawned.proc)).resolves.toBeUndefined()
  }, 10_000)
})
