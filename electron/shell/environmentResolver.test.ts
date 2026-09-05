import { describe, expect, it } from 'vitest'
import { resolveShellEnvironment } from './environmentResolver'

describe('resolveShellEnvironment', () => {
  it('只保留基础 allowlist 和显式授权变量，并过滤敏感名称', () => {
    const result = resolveShellEnvironment({ PATH: '/bin', HOME: '/tmp/home', API_KEY: 'secret', AWS_TOKEN: 'x', CUSTOM: 'no', CI: 'yes' }, ['CI'])
    expect(result.env).toEqual({ PATH: '/bin', HOME: '/tmp/home', CI: 'yes' })
    expect(result.removedKeys).toEqual(['API_KEY', 'AWS_TOKEN', 'CUSTOM'])
  })

  it('相同环境生成稳定 fingerprint，值变化会改变 fingerprint', () => {
    const a = resolveShellEnvironment({ PATH: '/bin', HOME: '/tmp' })
    const b = resolveShellEnvironment({ HOME: '/tmp', PATH: '/bin' })
    const c = resolveShellEnvironment({ PATH: '/usr/bin', HOME: '/tmp' })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(c.fingerprint).not.toBe(a.fingerprint)
  })
})
