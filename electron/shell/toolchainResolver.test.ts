import { describe, expect, it } from 'vitest'
import { resolveNodeToolchainPath } from './toolchainResolver'

describe('resolveNodeToolchainPath', () => {
  it('统一合并 nvm、fnm、Volta 和已有 PATH，且保持优先顺序', () => {
    const result = resolveNodeToolchainPath({
      NVM_BIN: '/Users/test/.nvm/versions/node/v22/bin',
      FNM_MULTISHELL_PATH: '/Users/test/.fnm_multishells/123',
      VOLTA_HOME: '/Users/test/.volta',
      PATH: '/usr/bin:/bin'
    }, 'darwin')
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
    }, 'win32')
    expect(result.sources).toEqual(['windows-node', 'windows-npm'])
    expect(result.pathEntries.slice(0, 2)).toEqual([
      'C:\\Program Files/nodejs',
      'C:\\Users\\test\\AppData\\Roaming/npm'
    ])
    expect(result.pathEntries.slice(2)).toEqual(['C:\\Windows\\System32', 'C:\\Other'])
  })

  it('Windows 合并 PATH/Path/path 且去重', () => {
    const result = resolveNodeToolchainPath({ PATH: 'C:\\A;C:\\B', Path: 'C:\\B;C:\\C', path: 'C:\\D' }, 'win32')
    expect(result.pathEntries).toEqual(['C:\\A', 'C:\\B', 'C:\\C', 'C:\\D'])
  })
})
