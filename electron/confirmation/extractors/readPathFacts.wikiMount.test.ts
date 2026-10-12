/**
 * T1.1：读探测 mountAnchors 可选入参（与写侧对称）。
 * 未传参零行为差异由既有 readPathFacts.test.ts 零改动通过保证。
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeReadPathFact, type MountAnchor } from './readPathFacts'

const dirs: string[] = []

async function tmpdir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpath(dir)
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('probeReadPathFact mountAnchors（T1.1）', () => {
  it('①挂载入参：normalizedPath=真实路径、vocabularyPath=词汇、scopeBase=realBase', async () => {
    const workDir = await tmpdir('wiki-rf-proj-')
    const realBase = await tmpdir('wiki-rf-base-')
    await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })
    const target = path.join(realBase, 'wiki', 'index.md')
    await fs.writeFile(target, 'content')

    const fact = await probeReadPathFact({
      rawPath: 'llm-wiki/wiki/index.md',
      workDir,
      userDataDir: path.dirname(realBase),
      homeDir: workDir,
      customSensitivePrefixes: [],
      mountAnchors: [{ base: realBase, vocabularyPrefix: 'llm-wiki' }]
    })

    expect(fact.normalizedPath).toBe(target)
    expect(fact.vocabularyPath).toBe('llm-wiki/wiki/index.md')
    expect(fact.scopeBase).toBe(realBase)
    expect(fact.targetKind).toBe('file')
    expect(fact.scope).toBe('single-target')
  })

  it('②未传 anchors：行为与现状一致（workDir 内 missing、无 vocabularyPath 字段）', async () => {
    const workDir = await tmpdir('wiki-rf-proj2-')
    const realBase = await tmpdir('wiki-rf-base2-')

    const fact = await probeReadPathFact({
      rawPath: 'llm-wiki/wiki/index.md',
      workDir,
      userDataDir: path.dirname(realBase),
      homeDir: workDir,
      customSensitivePrefixes: []
    })

    expect(fact.vocabularyPath).toBeUndefined()
    expect(fact.normalizedPath).toBe(path.join(workDir, 'llm-wiki', 'wiki', 'index.md'))
    expect(fact.targetKind).toBe('missing')
  })

  it('③missing 回退：共享库缺失目标保留词汇归一，最近存在父目录 realpath 注入', async () => {
    const workDir = await tmpdir('wiki-rf-proj3-')
    const realBase = await tmpdir('wiki-rf-base3-')
    await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })

    const fact = await probeReadPathFact({
      rawPath: 'llm-wiki/wiki/absent.md',
      workDir,
      userDataDir: path.dirname(realBase),
      homeDir: workDir,
      customSensitivePrefixes: [],
      mountAnchors: [{ base: realBase, vocabularyPrefix: 'llm-wiki' }]
    })

    expect(fact.targetKind).toBe('missing')
    expect(fact.normalizedPath).toBe(path.join(realBase, 'wiki', 'absent.md'))
    expect(fact.vocabularyPath).toBe('llm-wiki/wiki/absent.md')
  })
})
