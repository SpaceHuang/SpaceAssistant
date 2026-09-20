import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  applyPlaywrightInstallShellEnv,
  augmentShellPathEnv,
  pickSafeNodeOptions,
  resolveShellPathEnv
} from './shellSpawnEnv'

describe('shellSpawnEnv', () => {
  it('resolveShellPathEnv prefers PATH then Path', () => {
    expect(resolveShellPathEnv({ PATH: '/a', Path: '/b' })).toBe('/a')
    expect(resolveShellPathEnv({ Path: '/b' })).toBe('/b')
  })

  it('augmentShellPathEnv 只注入真实存在的 npm/nodejs 目录（P2-G/D8）', () => {
    if (process.platform !== 'win32') return
    const existingNpm = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-probe-'))
    fs.mkdirSync(path.join(existingNpm, 'npm'))
    const merged = augmentShellPathEnv({
      Path: 'C:\\Windows\\system32',
      APPDATA: existingNpm,
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local'
    })
    // 存在的候选目录（%APPDATA%\npm 需真实存在）被注入
    expect(merged).toContain(path.join(existingNpm, 'npm'))
    // 不存在的候选目录不再被注入
    expect(merged).not.toContain('C:\\Program Files\\nodejs')
    expect(merged).toContain('C:\\Windows\\system32')
    fs.rmSync(existingNpm, { recursive: true, force: true })
  })

  it('pickSafeNodeOptions keeps only --use-system-ca', () => {
    expect(
      pickSafeNodeOptions({ NODE_OPTIONS: '--use-system-ca --inspect=9229' })
    ).toBe('--use-system-ca')
    expect(pickSafeNodeOptions({ NODE_OPTIONS: '--inspect=9229' })).toBeUndefined()
  })

  it('applyPlaywrightInstallShellEnv sets non-tty and pw:install debug', () => {
    const env: NodeJS.ProcessEnv = {}
    applyPlaywrightInstallShellEnv(env, 'npx playwright install chromium')
    expect(env.PLAYWRIGHT_FORCE_TTY).toBe('0')
    expect(env.DEBUG).toBe('pw:install')
    applyPlaywrightInstallShellEnv(env, 'echo hi')
    expect(env.DEBUG).toBe('pw:install')
  })
})
