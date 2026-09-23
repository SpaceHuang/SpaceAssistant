import { describe, expect, it } from 'vitest'
import { resolveNodeToolchainPath } from './toolchainResolver'

describe('resolveNodeToolchainPath', () => {
  it('统一合并 nvm、fnm、Volta 和已有 PATH，且保持优先顺序', () => {
    const result = resolveNodeToolchainPath({
      NVM_BIN: '/Users/test/.nvm/versions/node/v22/bin',
      FNM_MULTISHELL_PATH: '/Users/test/.fnm_multishells/123',
      VOLTA_HOME: '/Users/test/.volta',
      PATH: '/usr/bin:/bin'
    }, 'darwin', { exists: () => true })
    expect(result.sources).toEqual(['nvm', 'fnm', 'volta'])
    expect(result.pathEntries).toEqual([
      '/Users/test/.nvm/versions/node/v22/bin',
      '/Users/test/.fnm_multishells/123',
      '/Users/test/.volta/bin',
      '/usr/bin',
      '/bin'
    ])
  })

  it('Windows 使用 Path 分隔符并加入 node/npm 目录', () => {
    const result = resolveNodeToolchainPath({
      ProgramFiles: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      Path: 'C:\\Windows\\System32;C:\\Other'
    }, 'win32', { exists: () => true })
    expect(result.sources).toEqual(['windows-node', 'windows-npm'])
    expect(result.pathEntries.slice(0, 2)).toEqual([
      'C:\\Program Files\\nodejs',
      'C:\\Users\\test\\AppData\\Roaming\\npm'
    ])
    expect(result.pathEntries.slice(2)).toEqual(['C:\\Windows\\System32', 'C:\\Other'])
  })

  it('Windows 合并 PATH/Path/path 且去重', () => {
    const result = resolveNodeToolchainPath({ PATH: 'C:\\A;C:\\B', Path: 'C:\\B;C:\\C', path: 'C:\\D' }, 'win32', { exists: () => true })
    expect(result.pathEntries).toEqual(['C:\\A', 'C:\\B', 'C:\\C', 'C:\\D'])
  })

  // ===== P2-G(a)：注入的候选目录必须真实存在（回归 D8，§7.1 #12）=====
  // 候选根目录用保证不存在的哨兵路径：CI runner 与多数开发机真实存在 C:\Program Files\nodejs，
  // 不能作为「不存在的目录」的样例（生产默认走真实 fs.existsSync）。
  it('不存在的 nodejs 目录不进入 pathEntries（生产默认做存在性检查）', () => {
    const result = resolveNodeToolchainPath({
      ProgramFiles: 'C:\\__sa_missing_pf__',
      'ProgramFiles(x86)': 'C:\\__sa_missing_pf86__',
      LOCALAPPDATA: 'C:\\__sa_missing_local__',
      APPDATA: 'C:\\__sa_missing_appdata__',
      Path: 'C:\\Windows\\System32'
    }, 'win32')
    expect(result.pathEntries).toEqual(['C:\\Windows\\System32'])
    expect(result.sources).toEqual([])
  })

  it('存在性检查按候选粒度生效：存在者进入，不存在者跳过且不影响顺序', () => {
    const result = resolveNodeToolchainPath({
      ProgramFiles: 'C:\\Program Files',
      APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
      Path: 'C:\\Windows\\System32'
    }, 'win32', {
      exists: (dir) => dir.endsWith('npm') || dir.endsWith('System32')
    })
    expect(result.sources).toEqual(['windows-npm'])
    expect(result.pathEntries).toEqual(['C:\\Users\\test\\AppData\\Roaming\\npm', 'C:\\Windows\\System32'])
  })

  it('已有 PATH 条目不做存在性过滤（用户自己的 PATH 原样保留）', () => {
    const result = resolveNodeToolchainPath({ Path: 'C:\\Ghost;C:\\Real' }, 'win32', { exists: () => false })
    expect(result.pathEntries).toEqual(['C:\\Ghost', 'C:\\Real'])
  })
})
