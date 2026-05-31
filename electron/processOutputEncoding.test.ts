import { describe, expect, it } from 'vitest'
import {
  buildPythonScriptEnv,
  buildShellEnv,
  createProcessOutputStreamDecoder,
  createStreamTextDecoder,
  decodeProcessOutput
} from './processOutputEncoding'

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

  it('buildPythonScriptEnv forces UTF-8 for Python IO', () => {
    const env = buildPythonScriptEnv({ PATH: '/bin' })
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    if (process.platform === 'win32') {
      expect(env.PYTHONUTF8).toBe('1')
    }
  })

  it('decodes UTF-8 across chunk boundaries', () => {
    const text = '目录已存在\n'
    const buf = Buffer.from(text, 'utf8')
    const mid = Math.floor(buf.length / 2)
    const dec = createStreamTextDecoder('utf-8')
    expect(dec.write(buf.subarray(0, mid)) + dec.write(buf.subarray(mid)) + dec.end()).toBe(text)
  })

  it('decodes GBK bytes produced by default Windows Python stdout', () => {
    const gbk = Buffer.from([0xc4, 0xbf, 0xc2, 0xbc, 0xd2, 0xd1, 0xb4, 0xe6, 0xd4, 0xda, 0x0d, 0x0a])
    const dec = createStreamTextDecoder('gbk')
    expect(dec.write(gbk) + dec.end()).toBe('目录已存在\r\n')
  })

  it('falls back to GBK when Windows cmd error was misread as UTF-8', () => {
    const gbk = Buffer.from(
      "'lark-cli.cmd' \xb2\xbb\xca\xc7\xc4\xda\xb2\xbf\xbb\xf2\xcd\xe2\xb2\xbf\xc3\xfc\xc1\xee\r\n",
      'binary'
    )
    const misread = new TextDecoder('utf-8').decode(gbk)
    expect(misread).toContain('\uFFFD')
    expect(decodeProcessOutput(gbk, 'win32')).toBe("'lark-cli.cmd' 不是内部或外部命令\r\n")
  })

  it('falls back to GBK when UTF-8 decode lacks CJK but GBK has Chinese', () => {
    const gbk = Buffer.from([
      0xce, 0xc4, 0xbc, 0xfe, 0xc3, 0xfb, 0xa1, 0xa2, 0xc4, 0xbf, 0xc2, 0xbc, 0xc3, 0xfb, 0xbb, 0xf2,
      0xbe, 0xed, 0xb1, 0xea, 0xd3, 0xef, 0xb7, 0xa8, 0xb2, 0xbb, 0xd5, 0xfd, 0xc8, 0xb7, 0xa1, 0xa3,
      0x0d, 0x0a
    ])
    const misread = new TextDecoder('utf-8').decode(gbk)
    expect(/[\u4e00-\u9fff]/.test(misread)).toBe(false)
    expect(decodeProcessOutput(gbk, 'win32')).toBe('文件名、目录名或卷标语法不正确。\r\n')
  })

  it('createProcessOutputStreamDecoder decodes GBK cmd errors across chunks', () => {
    const gbk = Buffer.from(
      "'lark-cli.cmd' \xb2\xbb\xca\xc7\xc4\xda\xb2\xbf\xbb\xf2\xcd\xe2\xb2\xbf\xc3\xfc\xc1\xee\r\n",
      'binary'
    )
    const dec = createProcessOutputStreamDecoder('win32')
    const mid = Math.floor(gbk.length / 2)
    expect(dec.write(gbk.subarray(0, mid)) + dec.write(gbk.subarray(mid)) + dec.end()).toBe(
      "'lark-cli.cmd' 不是内部或外部命令\r\n"
    )
  })

  it('keeps UTF-8 Node CLI output on Windows', () => {
    const utf8 = Buffer.from('auth status: not logged in\n', 'utf8')
    expect(decodeProcessOutput(utf8, 'win32')).toBe('auth status: not logged in\n')
  })
})
