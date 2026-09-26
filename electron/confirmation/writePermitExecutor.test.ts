import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeWritePathFact } from './extractors/writePathFacts'
import { resolvePermittedWriteTarget } from './writePermitExecutor'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))) })

async function roots() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'write-permit-')))
  dirs.push(root)
  const workDir = path.join(root, 'work')
  const outside = path.join(root, 'outside')
  await fs.mkdir(workDir)
  await fs.mkdir(outside)
  return { root, workDir, outside }
}

describe('resolvePermittedWriteTarget', () => {
  it('仅解析许可事实绑定的目录外缺失目标', async () => {
    const { root, workDir, outside } = await roots()
    const fact = await probeWritePathFact({ rawPath: path.join(outside, 'new.txt'), workDir, userDataDir: path.join(root, 'userdata'), homeDir: root, customSensitivePrefixes: [] })
    expect(fact.zone).toBe('outside-workdir')
    await expect(resolvePermittedWriteTarget(fact)).resolves.toMatchObject({ targetPath: fact.normalizedPath, parentReal: fact.parentReal, existed: false })
  })

  it('gate 后目标被替换时拒绝旧事实', async () => {
    const { root, workDir, outside } = await roots()
    const target = path.join(outside, 'file.txt')
    await fs.writeFile(target, 'before')
    const fact = await probeWritePathFact({ rawPath: target, workDir, userDataDir: path.join(root, 'userdata'), homeDir: root, customSensitivePrefixes: [] })
    await fs.rename(target, `${target}.old`)
    await fs.writeFile(target, 'after!')
    await expect(resolvePermittedWriteTarget(fact)).rejects.toThrow(/write-(?:parent|target)-identity-mismatch/)
  })
})
