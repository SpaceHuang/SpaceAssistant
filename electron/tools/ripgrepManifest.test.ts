import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateManifest } from '../../scripts/ripgrep-manifest.mjs'

const target = { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/rg.tar.gz', archiveSha256: 'a'.repeat(64), binarySha256: 'b'.repeat(64), archiveType: 'tar.gz', binaryPath: 'ripgrep-15.2.0/rg' }
const valid = { version: '15.2.0', license: 'MIT OR Unlicense', source: 'https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0', targets: { 'darwin-x64': target } }

describe('ripgrep manifest validation', () => {
  it('接受固定版本、官方 HTTPS release 和安全相对路径', () => expect(() => validateManifest(valid)).not.toThrow())
  it.each([
    ['latest', { ...valid, version: 'latest' }],
    ['非 HTTPS', { ...valid, targets: { 'darwin-x64': { ...target, url: 'http://github.com/x' } } }],
    ['错误摘要', { ...valid, targets: { 'darwin-x64': { ...target, binarySha256: 'B'.repeat(64) } } }],
    ['路径穿越', { ...valid, targets: { 'darwin-x64': { ...target, binaryPath: '../rg' } } }],
  ])('%s 时拒绝', (_, manifest) => expect(() => validateManifest(manifest)).toThrow())

  it('正式 manifest 固定且完整覆盖三个支持目标', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../scripts/ripgrep-manifest.json'), 'utf8'))
    expect(() => validateManifest(manifest)).not.toThrow()
    expect(Object.keys(manifest.targets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64'])
    for (const target of Object.values(manifest.targets) as Array<{ archiveSha256: string; binarySha256: string }>) {
      expect(target.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(target.binarySha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
