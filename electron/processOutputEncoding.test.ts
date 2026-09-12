import { describe, expect, it } from 'vitest'
import { buildPythonScriptEnv, buildShellEnv } from './processOutputEncoding'
describe('processOutputEncoding', () => {
  it('buildShellEnv strips API keys and keeps PATH', () => {
    const env = buildShellEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      HOME: '/home/user'
    })
    expect(env.PATH).toBe('/bin')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('buildShellEnv uses Windows Path when PATH is missing', () => {
    if (process.platform !== 'win32') return
    const env = buildShellEnv({
      Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\x',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'cmd.exe'
    })
    expect(env.Path).toContain('nodejs')
    expect(env.PATH).toBe(env.Path)
    expect(env.Path).not.toBe('')
  })

  it('buildShellEnv preserves safe NODE_OPTIONS', () => {
    const env = buildShellEnv({ PATH: '/bin', NODE_OPTIONS: '--use-system-ca --inspect' })
    expect(env.NODE_OPTIONS).toBe('--use-system-ca')
  })

  it('buildPythonScriptEnv forces UTF-8 and strips API keys like Shell', () => {
    const env = buildPythonScriptEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'secret',
      HOME: '/home/user'
    })
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBeTruthy()
    if (process.platform === 'win32') {
      expect(env.PYTHONUTF8).toBe('1')
    }
  })

})
