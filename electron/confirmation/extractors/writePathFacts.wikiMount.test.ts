/**
 * T1.1：探测函数 mountAnchors 可选入参。
 * 硬门槛②「未传参行为与现状逐字节一致」由既有 writePathFacts.test.ts 零改动通过保证；
 * 本文件覆盖 ①挂载入参 fact 换锚 ③missing 回退路径。
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeWritePathFact, type MountAnchor } from './writePathFacts'

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

function anchorFor(realBase: string): MountAnchor {
  return { base: realBase, vocabularyPrefix: 'llm-wiki' }
}

describe('probeWritePathFact mountAnchors（T1.1）', () => {
  it('①挂载入参：normalizedPath=真实路径、vocabularyPath=词汇、scopeBase=realBase', async () => {
    const workDir = await tmpdir('wiki-wf-proj-')
    const realBase = await tmpdir('wiki-wf-base-')
    await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })
    const target = path.join(realBase, 'wiki', 'index.md')
    await fs.writeFile(target, 'content')

    const fact = await probeWritePathFact({
      rawPath: 'llm-wiki/wiki/index.md',
      workDir,
      userDataDir: path.dirname(realBase),
      homeDir: workDir,
      customSensitivePrefixes: [],
      mountAnchors: [anchorFor(realBase)]
    })

    expect(fact.normalizedPath).toBe(target)
    expect(fact.vocabularyPath).toBe('llm-wiki/wiki/index.md')
    expect(fact.scopeBase).toBe(realBase)
    expect(fact.parentReal).toBe(path.join(realBase, 'wiki'))
    expect(fact.targetKind).toBe('file')
  })

  it("②未传 anchors：同入参按现状解析（workDir 内 missing，无 vocabularyPath/scopeBase 字段）", async () => {
    const workDir = await tmpdir('wiki-wf-proj2-')
    const realBase = await tmpdir('wiki-wf-base2-')
    await fs.mkdir(path.join(workDir, 'llm-wiki', 'wiki'), { recursive: true })

    const fact = await probeWritePathFact({
      rawPath: 'llm-wiki/wiki/index.md',
      workDir,
      userDataDir: path.dirname(realBase),
      homeDir: workDir,
      customSensitivePrefixes: []
    })

    expect(fact.vocabularyPath).toBeUndefined()
    expect(fact.scopeBase).toBeUndefined()
    expect(fact.normalizedPath).toBe(path.join(workDir, 'llm-wiki', 'wiki', 'index.md'))
    expect(fact.targetKind).toBe('missing')
  })

  it("③missing 回退：共享库内新文件不抛 PARENT_DIRECTORY_MISSING，normalizedPath 落 realBase", async () => {
    const workDir = await tmpdir('wiki-wf-proj3-')
    const realBase = await tmpdir('wiki-wf-base3-')
    await fs.mkdir(path.join(realBase, 'wiki'), { recursive: true })

    const fact = await probeWritePathFact({
      rawPath: 'llm-wiki/wiki/new-page.md',
      workDir,
      userDataDir: path.dirname(realBase),
      homeDir: workDir,
      customSensitivePrefixes: [],
      mountAnchors: [anchorFor(realBase)]
    })

    expect(fact.targetKind).toBe('missing')
    expect(fact.normalizedPath).toBe(path.join(realBase, 'wiki', 'new-page.md'))
    expect(fact.parentReal).toBe(path.join(realBase, 'wiki'))
    expect(fact.vocabularyPath).toBe('llm-wiki/wiki/new-page.md')
    expect(fact.scopeBase).toBe(realBase)
  })
})
