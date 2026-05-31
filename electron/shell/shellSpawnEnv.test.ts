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

  it('augmentShellPathEnv adds npm and nodejs on Windows', () => {
    if (process.platform !== 'win32') return
    const merged = augmentShellPathEnv({
      Path: 'C:\\Windows\\system32',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local'
    })
    expect(merged).toContain('C:\\Users\\x\\AppData\\Roaming\\npm')
    expect(merged).toContain('C:\\Program Files\\nodejs')
    expect(merged).toContain('C:\\Windows\\system32')
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
