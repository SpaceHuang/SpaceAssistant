import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { describe, expect, it } from 'vitest'
import {
  classifyRipgrepSpawnError,
  inspectRipgrepBinary,
  resolveRipgrepBinary
} from './ripgrepBinary'

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

  it('开发态 staging 缺失时在启动前明确报告 not_found', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-missing-'))
    const resolved = resolveRipgrepBinary({ packaged: false, resourcesPath: '/unused', developmentRoot: root, platform: 'darwin', arch: 'arm64' })
    await expect(inspectRipgrepBinary(resolved)).resolves.toEqual({ available: false, reason: 'not_found' })
    await fs.rm(root, { recursive: true, force: true })
  })

  it('开发态 staging 存在且可执行时通过启动前检查', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-ready-'))
    const binary = path.join(root, 'resources', 'ripgrep', 'darwin-arm64', 'rg')
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const resolved = resolveRipgrepBinary({ packaged: false, resourcesPath: '/unused', developmentRoot: root, platform: 'darwin', arch: 'arm64' })
    await expect(inspectRipgrepBinary(resolved)).resolves.toEqual({ available: true })
    await fs.rm(root, { recursive: true, force: true })
  })

  it.each([
    ['ENOENT', 'not_found'],
    ['EACCES', 'permission_denied'],
    ['ENOEXEC', 'exec_format'],
    ['EMFILE', 'resource_exhausted'],
    ['EIO', 'spawn_failed']
  ] as const)('保留 spawn errno 的稳定分类：%s', (code, expected) => {
    expect(classifyRipgrepSpawnError({ code } as NodeJS.ErrnoException)).toBe(expected)
  })
})
