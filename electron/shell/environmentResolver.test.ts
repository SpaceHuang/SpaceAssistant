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

// ===== P0-0(a) 根因修复：白名单大小写归一化（仅 win32）=====
// 背景：docs/develop/run-shell-windows-host-init-failure-diagnosis-and-improvement-plan.md §7.1 #0/#0b2
// Explorer 下发的源 env 是混合大小写 'SystemRoot'/'ComSpec'，旧实现按大写键精确匹配将其剔除，
// 导致子进程 SystemRoot='' → powershell 托管宿主初始化失败（0x8009001D / 0xFFFF0000，11/11 失败）。
describe('resolveShellEnvironment 白名单键名大小写（P0-0a 根因回归）', () => {
  it('win32：混合大小写 SystemRoot/ComSpec 存活、值正确、不进 removedKeys', () => {
    const result = resolveShellEnvironment(
      { SystemRoot: 'C:\\WINDOWS', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe', windir: 'C:\\WINDOWS' },
      [],
      'win32'
    )
    expect(result.env.SystemRoot).toBe('C:\\WINDOWS')
    expect(result.env.ComSpec).toBe('C:\\WINDOWS\\system32\\cmd.exe')
    expect(result.removedKeys).toEqual(['windir'])
  })

  it('win32：全大写 SYSTEMROOT/COMSPEC（MSYS/Git Bash 启动源）同样存活', () => {
    const result = resolveShellEnvironment({ SYSTEMROOT: 'C:\\WINDOWS', COMSPEC: 'cmd.exe' }, [], 'win32')
    expect(result.env.SYSTEMROOT).toBe('C:\\WINDOWS')
    expect(result.env.COMSPEC).toBe('cmd.exe')
    expect(result.removedKeys).toEqual([])
  })

  it('win32：混合大小写 Path 与 PATHEXT 存活（GUI 启动源）', () => {
    const result = resolveShellEnvironment({ Path: 'C:\\Windows\\system32', PATHEXT: '.COM;.EXE' }, [], 'win32')
    expect(result.env.Path).toBe('C:\\Windows\\system32')
    expect(result.env.PATHEXT).toBe('.COM;.EXE')
  })

  it('win32：命中白名单名字的敏感键仍被移除（归一化不放宽 SECRET_NAME 过滤）', () => {
    const result = resolveShellEnvironment(
      { SystemRoot: 'C:\\WINDOWS', MY_SECRET: 'x', Path: 'C:\\Windows' },
      [],
      'win32'
    )
    expect(result.env.MY_SECRET).toBeUndefined()
    expect(result.removedKeys).toEqual(['MY_SECRET'])
  })

  it('POSIX 回归：小写 path/home 不被放行（键名大小写敏感语义不变）', () => {
    const result = resolveShellEnvironment({ path: '/usr/bin', home: '/home/u', PATH: '/bin', HOME: '/root' }, [], 'linux')
    expect(result.env).toEqual({ PATH: '/bin', HOME: '/root' })
    expect(result.removedKeys).toEqual(['home', 'path'])
  })

  it('POSIX 回归：Windows 专有键 SystemRoot 在 POSIX 下仍被剔除', () => {
    const result = resolveShellEnvironment({ SystemRoot: 'C:\\WINDOWS' }, [], 'linux')
    expect(result.env.SystemRoot).toBeUndefined()
    expect(result.removedKeys).toEqual(['SystemRoot'])
  })
})
