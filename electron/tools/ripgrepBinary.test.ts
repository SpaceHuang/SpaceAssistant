import path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveRipgrepBinary } from './ripgrepBinary'

describe('resolveRipgrepBinary', () => {
  it('正式包 Windows x64 使用 resources/bin/rg.exe 的绝对路径', () => {
    expect(resolveRipgrepBinary({ packaged: true, resourcesPath: '/opt/SpaceAssistant/resources', platform: 'win32', arch: 'x64' }))
      .toEqual({ path: path.join('/opt/SpaceAssistant/resources', 'bin', 'rg.exe'), source: 'bundled', platform: 'win32', arch: 'x64' })
  })

  it.each(['x64', 'arm64'] as const)('正式包 macOS %s 使用 Resources/bin/rg 的绝对路径', (arch) => {
    expect(resolveRipgrepBinary({ packaged: true, resourcesPath: '/Applications/SpaceAssistant.app/Contents/Resources', platform: 'darwin', arch }))
      .toEqual({ path: '/Applications/SpaceAssistant.app/Contents/Resources/bin/rg', source: 'bundled', platform: 'darwin', arch })
  })

  it('开发环境按 platform-arch 选择 staging，不搜索 PATH', () => {
    expect(resolveRipgrepBinary({ packaged: false, resourcesPath: '/unused', developmentRoot: '/repo', platform: 'darwin', arch: 'arm64' }))
      .toEqual({ path: '/repo/resources/ripgrep/darwin-arm64/rg', source: 'development', platform: 'darwin', arch: 'arm64' })
  })

  it('编译后的 dist-electron/electron/tools 目录回溯三级到仓库根目录', () => {
    const compiledToolsDir = '/repo/dist-electron/electron/tools'
    expect(path.resolve(compiledToolsDir, '../../..')).toBe('/repo')
  })

  it('未支持架构返回 unavailable 且不产生裸 rg 命令', () => {
    expect(resolveRipgrepBinary({ packaged: false, resourcesPath: '/unused', developmentRoot: '/repo', platform: 'darwin', arch: 'ia32' }))
      .toEqual({ path: null, source: 'unavailable', platform: 'darwin', arch: 'ia32', reason: 'unsupported' })
  })
})
