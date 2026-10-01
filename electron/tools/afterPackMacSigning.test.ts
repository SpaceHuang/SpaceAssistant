import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'

const afterPack = require('../../scripts/after-pack.cjs') as {
  adHocSignMacApp: (
    context: any,
    runCommand?: (command: string, args: string[]) => void,
    wait?: (milliseconds: number) => Promise<void>
  ) => Promise<void>
}

describe('afterPack macOS ad-hoc signing', () => {
  it('clears build provenance attributes before signing and verifying the app', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-after-pack-sign-'))
    const appPath = path.join(out, 'SpaceAssistant.app')
    await fs.mkdir(appPath)
    const runCommand = vi.fn()
    const wait = vi.fn(async () => {})
    const frameworkPath = path.join(appPath, 'Contents/Frameworks/Electron Framework.framework')
    await fs.mkdir(frameworkPath, { recursive: true })

    await afterPack.adHocSignMacApp({
      appOutDir: out,
      packager: { appInfo: { productFilename: 'SpaceAssistant' } }
    }, runCommand, wait)

    expect(runCommand.mock.calls).toEqual([
      ['xattr', ['-cr', appPath]],
      ['codesign', ['--force', '--deep', '--sign', '-', frameworkPath]],
      ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
      ['codesign', ['--verify', '--deep', '--strict', appPath]]
    ])
    expect(wait).toHaveBeenCalledWith(1000)
    await fs.rm(out, { recursive: true, force: true })
  })

  it('retries once when codesign fails while replacing a nested framework signature', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-after-pack-sign-retry-'))
    const appPath = path.join(out, 'SpaceAssistant.app')
    await fs.mkdir(appPath)
    const frameworkPath = path.join(appPath, 'Contents/Frameworks/Electron Framework.framework')
    await fs.mkdir(frameworkPath, { recursive: true })
    let signingAttempts = 0
    const wait = vi.fn(async () => {})
    const runCommand = vi.fn((command: string) => {
      if (command === 'codesign' && signingAttempts++ === 0) {
        throw new Error('internal error in Code Signing subsystem')
      }
    })

    await expect(afterPack.adHocSignMacApp({
      appOutDir: out,
      packager: { appInfo: { productFilename: 'SpaceAssistant' } }
    }, runCommand, wait)).resolves.toBeUndefined()
    expect(runCommand.mock.calls).toEqual([
      ['xattr', ['-cr', appPath]],
      ['codesign', ['--force', '--deep', '--sign', '-', frameworkPath]],
      ['xattr', ['-cr', appPath]],
      ['codesign', ['--force', '--deep', '--sign', '-', frameworkPath]],
      ['codesign', ['--force', '--deep', '--sign', '-', appPath]],
      ['codesign', ['--verify', '--deep', '--strict', appPath]]
    ])
    expect(wait).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenNthCalledWith(1, 1000)
    expect(wait).toHaveBeenNthCalledWith(2, 1000)
    await fs.rm(out, { recursive: true, force: true })
  })
})
