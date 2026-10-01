import { describe, expect, it } from 'vitest'
import { grepRipgrepUnavailableUserMessage } from './builtinExecutors'

// Phase 4(方案 §3.6.4 E1 / 评审 P1-2 修订):
// - Agent 侧文本按 source × reason 分层,含动作指引;不拼原始诊断枚举;
// - 环境拦截类原因(permission_denied / exec_format / resource_exhausted / spawn_failed)
//   不得出现「重新安装应用」指引(重装与拦截无关);
// - E2:所有分层文案给出替代路径(list_directory+read_file、run_shell 系统搜索);
// - 不引入主进程 i18n:文案由主进程直接产出(渲染端经 data.errorClass 走 R8)。

const RAW_ENUMS = /not_found|not_file|permission_denied|exec_format|resource_exhausted|spawn_failed|unsupported/

const resolved = (source: 'development' | 'bundled', platform: NodeJS.Platform = 'darwin', arch = 'arm64') => ({ source, platform, arch })

describe('E1:rg 不可用文案分层(source × reason 表驱动)', () => {
  it('开发态 not_found:给 prepare:rg 指引与替代路径,不出现原始枚举或重装指引', () => {
    const msg = grepRipgrepUnavailableUserMessage(resolved('development', 'darwin', 'arm64'), 'not_found')
    expect(msg).toContain('npm run prepare:rg')
    expect(msg).toContain('--target=darwin-arm64')
    expect(msg).toContain('list_directory')
    expect(msg).toContain('run_shell')
    expect(msg).not.toMatch(RAW_ENUMS)
    expect(msg).not.toContain('重新安装')
  })

  it.each(['permission_denied', 'spawn_failed', 'exec_format'] as const)('打包态 %s:给拦截处置指引,不得出现「重新安装」或原始枚举', (reason) => {
    const msg = grepRipgrepUnavailableUserMessage(resolved('bundled'), reason)
    expect(msg).toContain('安全软件')
    expect(msg).toContain('list_directory')
    expect(msg).toContain('run_shell')
    expect(msg).not.toContain('重新安装')
    expect(msg).not.toMatch(RAW_ENUMS)
  })

  it('打包态 darwin exec_format:按平台给 xattr 去隔离处置', () => {
    const msg = grepRipgrepUnavailableUserMessage(resolved('bundled', 'darwin', 'arm64'), 'exec_format')
    expect(msg).toContain('xattr')
  })

  it('打包态 win32 spawn_failed:按平台给安全软件白名单处置', () => {
    const msg = grepRipgrepUnavailableUserMessage(resolved('bundled', 'win32', 'x64'), 'spawn_failed')
    expect(msg).toContain('白名单')
  })

  it('打包态 not_file / permission_denied:指向安全软件隔离区恢复', () => {
    const msg = grepRipgrepUnavailableUserMessage(resolved('bundled'), 'not_file')
    expect(msg).toContain('隔离')
    expect(msg).not.toContain('重新安装')
    expect(msg).not.toMatch(RAW_ENUMS)
  })

  it('resource_exhausted:瞬时故障只提示稍后重试,不给永久性指引(D1)', () => {
    const msg = grepRipgrepUnavailableUserMessage(resolved('bundled'), 'resource_exhausted')
    expect(msg).toContain('稍后重试')
    expect(msg).not.toContain('重新安装')
    expect(msg).not.toContain('prepare:rg')
    expect(msg).not.toMatch(RAW_ENUMS)
    expect(msg).toContain('list_directory')
  })

  it('unsupported:如实告知平台不在支持面(D4),给替代路径', () => {
    const msg = grepRipgrepUnavailableUserMessage(resolved('development', 'linux', 'x64'), 'unsupported')
    expect(msg).toContain('支持面')
    expect(msg).not.toContain('重新安装')
    expect(msg).not.toMatch(RAW_ENUMS)
    expect(msg).toContain('run_shell')
  })
})
