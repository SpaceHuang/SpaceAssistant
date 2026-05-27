import { describe, expect, it } from 'vitest'
import { buildPythonScriptEnv, createStreamTextDecoder } from './processOutputEncoding'

describe('processOutputEncoding', () => {
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
})
