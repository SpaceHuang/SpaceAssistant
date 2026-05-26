import { describe, expect, it } from 'vitest'
import { spawnCommandSafe } from './spawnUtil'

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
})
