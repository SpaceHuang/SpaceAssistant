import { describe, expect, it } from 'vitest'
import { killProcessTree, spawnCommandSafe } from './spawnUtil'

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

  it('killProcessTree terminates a child process', async () => {
    const spawned = spawnCommandSafe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    expect('error' in spawned).toBe(false)
    if ('error' in spawned) return

    await expect(killProcessTree(spawned.proc)).resolves.toBeUndefined()
  }, 10_000)
})
