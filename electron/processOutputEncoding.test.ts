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

  // ===== P0-0(b) 纵深防御：取到有效值才写，不再主动注入空串（§5.0(b)）=====
  // 缺键与空串同样导致宿主初始化失败（§2.3.3 E2/E4），主动写入空串只会制造"看起来有值"的假象。
  it('P0-0b：win32 SystemRoot/USERPROFILE/LOCALAPPDATA 取到有效值才写，ComSpec 缺省回退 cmd.exe', () => {
    if (process.platform !== 'win32') return
    const env = buildShellEnv({
      SystemRoot: 'C:\\WINDOWS',
      USERPROFILE: 'C:\\Users\\x',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe'
    })
    expect(env.SystemRoot).toBe('C:\\WINDOWS')
    expect(env.USERPROFILE).toBe('C:\\Users\\x')
    expect(env.LOCALAPPDATA).toBe('C:\\Users\\x\\AppData\\Local')
    expect(env.ComSpec).toBe('C:\\WINDOWS\\system32\\cmd.exe')
  })

  it('P0-0b：上游与 process.env 均无 SystemRoot 时，输出不得包含值为空串的 SystemRoot 键', () => {
    if (process.platform !== 'win32') return
    const savedRoot = process.env.SystemRoot
    const savedProfile = process.env.USERPROFILE
    const savedLocal = process.env.LOCALAPPDATA
    delete process.env.SystemRoot
    delete process.env.USERPROFILE
    delete process.env.LOCALAPPDATA
    try {
      const env = buildShellEnv({})
      for (const [key, value] of Object.entries(env)) {
        if (/^systemroot$/i.test(key) || /^userprofile$/i.test(key) || /^localappdata$/i.test(key)) {
          expect(value).not.toBe('')
        }
      }
    } finally {
      if (savedRoot !== undefined) process.env.SystemRoot = savedRoot
      if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile
      if (savedLocal !== undefined) process.env.LOCALAPPDATA = savedLocal
    }
  })

  it('P0-0b：上游缺失时从 process.env 兜底回填有效 SystemRoot', () => {
    if (process.platform !== 'win32') return
    const savedRoot = process.env.SystemRoot
    try {
      const fallback = savedRoot ?? 'C:\\WINDOWS'
      process.env.SystemRoot = fallback
      const env = buildShellEnv({})
      expect(env.SystemRoot).toBe(fallback)
    } finally {
      if (savedRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = savedRoot
    }
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
