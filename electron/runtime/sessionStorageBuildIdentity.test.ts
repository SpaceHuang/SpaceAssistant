import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { writeSessionStorageBuildIdentity } = require('../../scripts/after-pack.cjs') as {
  writeSessionStorageBuildIdentity: (context: unknown, runGit?: (...args: unknown[]) => string) => void
}

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('packaged session storage build identity', () => {
  it('records HEAD and marks a clean source tree as eligible for later release pinning', () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-storage-build-identity-'))
    tempDirectories.push(appOutDir)
    const runGit = vi.fn((_command: unknown, args: unknown[]) => args[0] === 'status' ? '' : 'c'.repeat(40))
    const context = {
      electronPlatformName: 'darwin',
      arch: 'x64',
      appOutDir,
      packager: {
        info: { projectDir: process.cwd() },
        appInfo: { productFilename: 'SpaceAssistant' },
      },
    }

    writeSessionStorageBuildIdentity(context, runGit)

    const identityPath = path.join(appOutDir, 'SpaceAssistant.app', 'Contents', 'Resources', 'session-storage-build-identity.json')
    expect(JSON.parse(fs.readFileSync(identityPath, 'utf8'))).toMatchObject({
      formatVersion: 2,
      version: '0.2.4',
      commitSha: 'c'.repeat(40),
      sourceTreeClean: true,
      buildId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      target: { platform: 'mac', arch: 'x64' },
    })
  })

  it('marks a dirty source tree as non-authorizing', () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-storage-build-identity-dirty-'))
    tempDirectories.push(appOutDir)
    const runGit = vi.fn((_command: unknown, args: unknown[]) => args[0] === 'status' ? ' M electron/main.ts\n' : 'd'.repeat(40))
    const context = {
      electronPlatformName: 'linux',
      arch: 'x64',
      appOutDir,
      packager: { info: { projectDir: process.cwd() }, appInfo: { productFilename: 'SpaceAssistant' } },
    }

    writeSessionStorageBuildIdentity(context, runGit)

    const identityPath = path.join(appOutDir, 'resources', 'session-storage-build-identity.json')
    expect(JSON.parse(fs.readFileSync(identityPath, 'utf8'))).toMatchObject({
      formatVersion: 2,
      commitSha: 'd'.repeat(40),
      sourceTreeClean: false,
      buildId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      target: { platform: 'linux', arch: 'x64' },
    })
  })
})
