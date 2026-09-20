// P2-b（v3 复验建议）：darwin/posix/win32 平台分支单测。
// 覆盖 getBuiltinSensitivePrefixes 三分支与 isSensitivePath 的平台语义
// （win32：Roaming + C:\Windows；darwin：~/Library；posix：/etc + /System）。
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getBuiltinSensitivePrefixes, isSensitivePath } from './shellSensitivePaths'

const HOME = os.homedir()

describe('shellSensitivePaths 平台分支（P2-b）', () => {
  it('win32：含 Roaming 与 C:\\Windows，win32 语义下 C:\\Windows 命中', () => {
    const prefixes = getBuiltinSensitivePrefixes(undefined, 'win32')
    expect(prefixes).toContain(path.win32.join(HOME, '.ssh').toLowerCase())
    expect(prefixes).toContain(path.win32.join(HOME, 'AppData', 'Roaming').toLowerCase())
    expect(prefixes).toContain(path.win32.join('C:', 'Windows').toLowerCase())
    expect(isSensitivePath('C:\\Windows\\system32\\x.dll', undefined, [], 'win32')).toBe(true)
    expect(isSensitivePath('D:\\work\\out.txt', undefined, [], 'win32')).toBe(false)
  })

  it('darwin：含 ~/Library，Library 下的路径命中；/etc 不属 darwin 集', () => {
    const prefixes = getBuiltinSensitivePrefixes(undefined, 'darwin')
    expect(prefixes).toContain(path.posix.join(HOME, 'Library').toLowerCase())
    expect(isSensitivePath(path.posix.join(HOME, 'Library', 'Cookies', 'x'), undefined, [], 'darwin')).toBe(true)
    expect(isSensitivePath('/etc/passwd', undefined, [], 'darwin')).toBe(false)
  })

  it('posix：含 /etc 与 /System，/etc 下路径命中', () => {
    const prefixes = getBuiltinSensitivePrefixes(undefined, 'posix')
    expect(prefixes).toContain('/etc')
    expect(prefixes).toContain('/system')
    expect(isSensitivePath('/etc/passwd', undefined, [], 'posix')).toBe(true)
    expect(isSensitivePath(path.posix.join(HOME, 'Library', 'x'), undefined, [], 'posix')).toBe(false)
  })

  it('缺省平台 = 宿主平台（生产行为不变），darwin 宿主保留 ~/Library（P1-b 回归锁）', () => {
    const prefixes = getBuiltinSensitivePrefixes()
    if (process.platform === 'darwin') {
      expect(prefixes).toContain(path.posix.join(HOME, 'Library').toLowerCase())
    } else if (process.platform === 'win32') {
      expect(prefixes).toContain(path.win32.join('C:', 'Windows').toLowerCase())
    } else {
      expect(prefixes).toContain('/etc')
    }
    // P1-b 回归锁：darwin 显式请求时必须含 ~/Library（防止再被 posix 归并弱化）
    if (process.platform === 'darwin') {
      expect(getBuiltinSensitivePrefixes(undefined, 'darwin')).toContain(path.posix.join(HOME, 'Library').toLowerCase())
    }
  })
})
