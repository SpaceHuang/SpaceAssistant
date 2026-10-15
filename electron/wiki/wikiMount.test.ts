import path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveWikiMount, type WikiMountResolution } from './wikiMount'
import type { WikiConfig } from '../../src/shared/domainTypes'

const workDir = path.resolve(path.sep, 'work', 'proj')
const userData = path.resolve(path.sep, 'users', 'test', 'appdata')

function makeConfig(overrides: Partial<WikiConfig> = {}): WikiConfig {
  return {
    enabled: true,
    rootPath: 'llm-wiki',
    hideWikiFromFileTree: true,
    interactiveIngest: false,
    maxBatchIngest: 10,
    legacyRootAliases: [],
    migration: { status: 'idle' },
    ...overrides
  }
}

function expectMounted(res: WikiMountResolution): Extract<WikiMountResolution, { mounted: true }> {
  expect(res.mounted).toBe(true)
  return res as Extract<WikiMountResolution, { mounted: true }>
}

function expectNotMounted(res: WikiMountResolution): void {
  expect(res).toEqual({ mounted: false })
}

describe('resolveWikiMount 八条规则（T0.5）', () => {
  it('① 词汇相对命中：llm-wiki/wiki/index.md 挂载到共享根', () => {
    const res = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, 'llm-wiki/wiki/index.md'))
    expect(res.vocabularyPath).toBe('llm-wiki/wiki/index.md')
    expect(res.realBase).toBe(path.join(userData, 'llm-wiki'))
    expect(res.realRel).toBe(path.join('wiki', 'index.md'))
    expect(res.realPath).toBe(path.join(userData, 'llm-wiki', 'wiki', 'index.md'))
    expect(res.readOnly).toBe(false)
  })

  it('② 根本身命中：llm-wiki → realRel 为空、realPath === realBase', () => {
    const res = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, 'llm-wiki'))
    expect(res.vocabularyPath).toBe('llm-wiki')
    expect(res.realRel).toBe('')
    expect(res.realPath).toBe(res.realBase)
    expect(res.readOnly).toBe(false)
  })

  it('③ Windows 反斜杠与尾斜杠规范化', () => {
    const winWorkDir = 'C:\\work\\proj'
    const winUserData = 'C:\\users\\test\\appdata'
    const res = expectMounted(resolveWikiMount(winWorkDir, makeConfig(), winUserData, 'llm-wiki\\wiki\\x.md'))
    expect(res.vocabularyPath).toBe('llm-wiki/wiki/x.md')
    expect(res.realPath.toLowerCase()).toBe(path.join(winUserData, 'llm-wiki', 'wiki', 'x.md').toLowerCase())

    const trailing = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, 'llm-wiki/'))
    expect(trailing.vocabularyPath).toBe('llm-wiki')
    expect(trailing.realRel).toBe('')
  })

  it('④ realBase 绝对形态反向命中：与词汇形态完全一致的挂载语义（v4-C2）', () => {
    const absInput = path.join(userData, 'llm-wiki', 'raw', 'x.md')
    const res = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, absInput))
    const lexical = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, 'llm-wiki/raw/x.md'))
    expect(res.vocabularyPath).toBe(lexical.vocabularyPath)
    expect(res.realPath).toBe(lexical.realPath)
    expect(res.readOnly).toBe(lexical.readOnly)
    expect(res.vocabularyPath).toBe('llm-wiki/raw/x.md')
  })

  it("④b realBase 目录前缀按路径段匹配（llm-wiki-evil 不命中）", () => {
    const absInput = path.join(userData, 'llm-wiki-evil', 'x.md')
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, absInput))
  })

  it("⑤ '..' 穿越不挂载", () => {
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, 'llm-wiki/../outside.md'))
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, '../outside.md'))
  })

  it('⑥ 越界绝对路径不挂载', () => {
    const elsewhere = path.resolve(path.sep, 'elsewhere', 'x.md')
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, elsewhere))
  })

  it('⑧ 别名前缀 readOnly：词汇不变、realPath 落共享根', () => {
    const config = makeConfig({ legacyRootAliases: ['old-wiki'] })
    const res = expectMounted(resolveWikiMount(workDir, config, userData, 'old-wiki/wiki/index.md'))
    expect(res.readOnly).toBe(true)
    expect(res.vocabularyPath).toBe('old-wiki/wiki/index.md')
    expect(res.realBase).toBe(path.join(userData, 'llm-wiki'))
    expect(res.realPath).toBe(path.join(userData, 'llm-wiki', 'wiki', 'index.md'))

    // realBase 绝对形态的反向命中同样携带 readOnly
    const abs = expectMounted(resolveWikiMount(workDir, config, userData, path.join(userData, 'llm-wiki', 'raw', 'x.md')))
    expect(abs.readOnly).toBe(false)
  })

  it('⑨ 物理目录名读配置：rootPath=my-lib 时 realBase 跟随，词汇前缀不变', () => {
    const config = makeConfig({ rootPath: 'my-lib' })
    const res = expectMounted(resolveWikiMount(workDir, config, userData, 'llm-wiki/wiki/index.md'))
    expect(res.realBase).toBe(path.join(userData, 'my-lib'))
    expect(res.vocabularyPath).toBe('llm-wiki/wiki/index.md')

    const abs = expectMounted(resolveWikiMount(workDir, config, userData, path.join(userData, 'my-lib', 'raw', 'y.md')))
    expect(abs.vocabularyPath).toBe('llm-wiki/raw/y.md')
  })

  it('⑩ 纯函数性：同入参同输出、重复调用不漂移', () => {
    const config = makeConfig({ legacyRootAliases: ['old-wiki'] })
    const a = resolveWikiMount(workDir, config, userData, 'llm-wiki/wiki/index.md')
    const b = resolveWikiMount(workDir, config, userData, 'llm-wiki/wiki/index.md')
    expect(a).toEqual(b)
    const c = resolveWikiMount(workDir, config, userData, 'old-wiki/log.md')
    const d = resolveWikiMount(workDir, config, userData, 'old-wiki/log.md')
    expect(c).toEqual(d)
  })

  it('BLK-5：大小写变体入参 vocabularyPath 规范化为命中前缀（raw deny 语义保持）', () => {
    const res = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, 'LLM-WIKI/raw/evil.md'))
    expect(res.vocabularyPath).toBe('llm-wiki/raw/evil.md')
    expect(res.matchedPrefix).toBe('llm-wiki')
    const raw2 = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, 'llm-wiki/RAW/x.md'))
    expect(raw2.vocabularyPath).toBe('llm-wiki/RAW/x.md'.toLowerCase().replace('raw', 'RAW')) // 后缀保留原样
    expect(raw2.vocabularyPath.startsWith('llm-wiki/')).toBe(true)

    // 别名前缀规范化：vocabularyPath 用别名原文
    const aliasConfig = makeConfig({ legacyRootAliases: ['Docs-Wiki'] })
    const alias = expectMounted(resolveWikiMount(workDir, aliasConfig, userData, 'DOCS-WIKI/x.md'))
    expect(alias.matchedPrefix).toBe('Docs-Wiki')
    expect(alias.vocabularyPath).toBe('Docs-Wiki/x.md')
  })

  it('补充：非 wiki 的 workDir 内相对路径不挂载；前缀包含不命中（llm-wiki-notes）', () => {
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, 'src/app.ts'))
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, 'llm-wiki-notes/x.md'))
  })

  it('补充：空入参与 workDir 内部绝对路径（非 wiki）不挂载', () => {
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, ''))
    expectNotMounted(resolveWikiMount(workDir, makeConfig(), userData, path.join(workDir, 'src', 'app.ts')))
  })

  it('补充：workDir 下绝对形态的 wiki 词汇（workDir/llm-wiki/...）反向命中', () => {
    const abs = path.join(workDir, 'llm-wiki', 'wiki', 'index.md')
    const res = expectMounted(resolveWikiMount(workDir, makeConfig(), userData, abs))
    expect(res.vocabularyPath).toBe('llm-wiki/wiki/index.md')
    expect(res.realPath).toBe(path.join(userData, 'llm-wiki', 'wiki', 'index.md'))
  })
})
