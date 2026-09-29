import { describe, expect, it } from 'vitest'
import { classifyPath } from './pathClassifier'

/**
 * merge-main-28 修复回归锚（修复计划 §5 批次 1.6）：pathClassifier 不在 28 个失败的链路上
 * （失败信号产自 probeWritePathFact/probeReadPathFact），对「POSIX 绝对 + win32 env」行为本就正确——
 * win32 分支对 rooted 路径走 path.win32.normalize（不补盘符、不漂移）→ 命中 posixRoot 正则。
 * 本文件钉住该正确行为，防止未来误以为它也存在漂移而误改；pathClassifier 与 probe* 双实现的
 * 统一另行立项（见修复计划 §5 撤回项）。
 */
describe('pathClassifier 既有正确行为回归锚', () => {
  it('POSIX 绝对路径 + win32 env 按 rooted 语法归 system-dir（不补盘符、不漂移）', () => {
    expect(classifyPath('/etc/hosts', { os: 'win32', workDir: 'C:\\work', sensitivePaths: [] })).toBe('system-dir')
  })

  it('Windows 系统目录 + win32 env 归 system-dir', () => {
    expect(classifyPath('C:\\Windows\\System32\\config\\SAM', { os: 'win32', workDir: 'C:\\work', sensitivePaths: [] })).toBe('system-dir')
  })

  it('相对路径按 env.workDir 语法 resolve 归 workdir-normal', () => {
    expect(classifyPath('src/x.ts', { os: 'win32', workDir: 'C:\\work', sensitivePaths: [] })).toBe('workdir-normal')
    expect(classifyPath('src/x.ts', { os: 'linux', workDir: '/work', sensitivePaths: [] })).toBe('workdir-normal')
  })

  it('POSIX env 下系统目录与工作目录外路径分类保持', () => {
    expect(classifyPath('/etc/hosts', { os: 'linux', workDir: '/work', sensitivePaths: [] })).toBe('system-dir')
    expect(classifyPath('/outside/note.txt', { os: 'linux', workDir: '/work', sensitivePaths: [] })).toBe('outside-workdir')
  })
})
