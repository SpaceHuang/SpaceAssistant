import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { getBuiltinSensitivePrefixes, isSensitivePath } from './shellSensitivePaths'

describe('shellSensitivePaths', () => {
  it('includes ssh and userData prefixes', () => {
    const userData = path.join(os.tmpdir(), 'sa-userdata')
    const prefixes = getBuiltinSensitivePrefixes(userData)
    expect(prefixes.some((p) => p.includes('.ssh'))).toBe(true)
    expect(prefixes.some((p) => p.includes(path.normalize(userData).toLowerCase()))).toBe(true)
  })

  it('matches custom sensitive prefixes', () => {
    const custom = [path.join(os.tmpdir(), 'my-secrets')]
    const target = path.join(os.tmpdir(), 'my-secrets', 'key.pem')
    expect(isSensitivePath(target, undefined, custom)).toBe(true)
  })

  it('detects .env files', () => {
    const envFile = path.join(os.tmpdir(), 'project', '.env')
    expect(isSensitivePath(envFile)).toBe(true)
  })
})
