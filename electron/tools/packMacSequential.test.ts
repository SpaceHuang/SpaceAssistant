import { describe, expect, it, vi } from 'vitest'

const { packMacSequential } = require('../../scripts/pack-mac-sequential.cjs') as {
  packMacSequential: (deps: {
    runBuilder: (args: string[]) => { status: number | null; error?: Error }
    removeX64App: () => void
  }) => void
}

describe('sequential macOS packaging', () => {
  it('builds x64 first, removes its temporary app, then builds arm64', () => {
    const calls: string[] = []
    const runBuilder = vi.fn((args: string[]) => {
      calls.push(args.join(' '))
      return { status: 0 }
    })
    const removeX64App = vi.fn(() => calls.push('remove release/mac'))

    packMacSequential({ runBuilder, removeX64App })

    expect(calls).toEqual([
      '--mac dmg --x64',
      'remove release/mac',
      '--mac dmg --arm64'
    ])
  })

  it('stops before cleanup and arm64 if x64 packaging fails', () => {
    const runBuilder = vi.fn(() => ({ status: 1 }))
    const removeX64App = vi.fn()

    expect(() => packMacSequential({ runBuilder, removeX64App })).toThrow(/x64/)
    expect(runBuilder).toHaveBeenCalledTimes(1)
    expect(removeX64App).not.toHaveBeenCalled()
  })
})
