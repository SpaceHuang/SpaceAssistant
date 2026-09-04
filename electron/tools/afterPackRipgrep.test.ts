import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { describe, expect, it } from 'vitest'

const afterPack = require('../../scripts/after-pack.cjs') as { copyBundledRipgrep: (context: any) => void }

describe('afterPack bundled ripgrep', () => {
  async function fixtureContext(out: string, arch: number) {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rg-project-'))
    const sourceDir = path.join(project, 'staging', 'darwin-x64')
    const licenseDir = path.join(project, 'licenses')
    await fs.mkdir(sourceDir, { recursive: true }); await fs.mkdir(licenseDir, { recursive: true })
    const bytes = Buffer.from('portable-rg-fixture')
    await fs.writeFile(path.join(sourceDir, 'rg'), bytes)
    for (const name of ['COPYING', 'UNLICENSE', 'LICENSE-MIT']) await fs.writeFile(path.join(licenseDir, name), name)
    return { electronPlatformName: 'darwin', arch, appOutDir: out, ripgrepSourceDir: path.join(project, 'staging'), ripgrepLicenseDir: licenseDir, ripgrepManifest: { targets: { 'darwin-x64': { binarySha256: crypto.createHash('sha256').update(bytes).digest('hex') } } }, packager: { info: { projectDir: project }, appInfo: { productFilename: 'SpaceAssistant' } } }
  }

  it('复制并校验 macOS x64 staging 到 Resources/bin', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-after-pack-'))
    const app = path.join(out, 'SpaceAssistant.app')
    await fs.mkdir(app, { recursive: true })
    afterPack.copyBundledRipgrep(await fixtureContext(out, 1))
    const stat = await fs.stat(path.join(app, 'Contents/Resources/bin/rg'))
    expect(stat.mode & 0o111).not.toBe(0)
    await fs.rm(out, { recursive: true, force: true })
  })

  it('缺少目标架构 staging 时阻止复制', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-after-pack-arm-'))
    await fs.mkdir(path.join(out, 'SpaceAssistant.app'), { recursive: true })
    const context = await fixtureContext(out, 3)
    await expect(Promise.resolve().then(() => afterPack.copyBundledRipgrep(context))).rejects.toThrow(/unsupported ripgrep target/)
    await fs.rm(out, { recursive: true, force: true })
  })
})
