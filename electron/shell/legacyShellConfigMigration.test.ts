import { describe, expect, it } from 'vitest'
import { migrateLegacyShellConfig } from './legacyShellConfigMigration'

const base = { enabled: true, shellDefaultTimeoutSec: 300 }

describe('migrateLegacyShellConfig', () => {
  it('leaves default profile config unchanged', () => {
    expect(migrateLegacyShellConfig(base, 'darwin')).toEqual({ status: 'unchanged', config: base })
  })

  it('normalizes Windows PowerShell 5.1 and removes legacy argsPrefix', () => {
    const result = migrateLegacyShellConfig({ ...base, executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', argsPrefix: ['-lc'] }, 'win32')
    expect(result).toMatchObject({ status: 'migrated', profileId: 'builtin-windows-powershell' })
    if (result.status === 'migrated') {
      expect(result.config.executable).toBe('powershell.exe')
      expect(result.config.argsPrefix).toBeUndefined()
    }
  })

  it.each([
    [{ ...base, executable: 'cmd.exe' }, 'cmd-profile'],
    [{ ...base, executable: '/opt/custom-shell', argsPrefix: ['-lc'] }, 'custom-args'],
    [{ ...base, executable: '/opt/custom-shell' }, 'custom-executable']
  ] as const)('marks unsupported legacy configuration: %s', (config, reason) => {
    expect(migrateLegacyShellConfig(config, 'win32')).toMatchObject({ status: 'unsupported', reason })
  })
})
