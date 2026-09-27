import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { getBuiltinSensitivePrefixes, getEffectiveSensitivePrefixes, isProtectedShellPath, isSensitivePath, matchSensitive } from './shellSensitivePaths'
import { classifyPath } from '../confirmation/extractors/pathClassifier'

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

  it('策略有效清单同时包含内置和自定义前缀，并按注入 home/platform 归一化', () => {
    const prefixes = getEffectiveSensitivePrefixes('C:\\Users\\Agent\\AppData\\Roaming\\SpaceAssistant', ['%USERPROFILE%\\CorpSecrets'], 'win32', 'C:\\Users\\Agent')
    expect(prefixes).toContain('c:\\users\\agent\\corpsecrets')
    expect(prefixes).toContain('c:\\windows')
    expect(prefixes).toContain('c:\\users\\agent\\appdata\\roaming\\spaceassistant')
    expect(matchSensitive({ resolvedPath: 'C:\\Users\\Agent\\CorpSecrets\\key.txt', homeDir: 'C:\\Users\\Agent', platform: 'win32', customPrefixes: ['%USERPROFILE%\\CorpSecrets'] })).toMatchObject({ sensitive: true, matchedBy: 'custom' })
  })

  it('POSIX 系统目录不进入敏感文件前缀，保留 system-dir 分类', () => {
    const prefixes = getBuiltinSensitivePrefixes(undefined, 'posix', '/home/agent')
    expect(prefixes).not.toContain('/etc')
    expect(prefixes).toContain('/home/agent/.ssh')
    const env = { os: 'linux', workDir: '/workspace', sensitivePaths: prefixes }
    expect(classifyPath('/etc/passwd', env)).toBe('system-dir')
    expect(classifyPath('/home/agent/.ssh/id_ed25519', env)).toBe('sensitive-file')
    expect(isProtectedShellPath('/etc/passwd', undefined, [], 'posix')).toBe(true)
    expect(isProtectedShellPath('/home/agent/.ssh/id_ed25519', undefined, [], 'posix', '/home/agent')).toBe(true)
  })

  it('Posix ~ 展开只使用显式注入的 home', () => {
    expect(matchSensitive({ resolvedPath: '/custom-home/.ssh/id_ed25519', homeDir: '/custom-home', platform: 'posix', builtinPrefixes: [], customPrefixes: ['~/.ssh'] })).toMatchObject({ sensitive: true, matchedBy: 'custom' })
  })
})
