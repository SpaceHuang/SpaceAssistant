import path from 'path'
import type { WikiConfig } from '../../src/shared/domainTypes'
import { DEFAULT_WIKI_ROOT_DIRNAME, WIKI_VOCABULARY_PREFIX } from '../../src/shared/wikiConstants'

/**
 * 路径虚拟挂载的唯一决策点（wiki-shared-centralized-storage §7.1）。
 * 纯函数、无 IO：探测层、permit、执行层对同一次工具调用的同一路径入参调用本函数，
 * 各自派生自己需要的视图（词汇路径 / 真实目标）。禁止任何层私有实现「前缀判断」。
 */
export type WikiMountResolution =
  | {
      mounted: true
      /** workDir 相对词汇，如 "llm-wiki/wiki/index.md"（展示、审计、信号判定用）。
       * 前缀段恒为命中的规范前缀（大小写规范化，BLK-5），后缀保留入参形态 */
      vocabularyPath: string
      /** 实际命中的规范前缀（词汇常量或别名原文；多段别名时 gate 锚点直接消费，P1-2） */
      matchedPrefix: string
      /** {userData}/<wikiConfig.rootPath>（目录名读配置，D9；非硬编码） */
      realBase: string
      /** 挂载内相对路径（根本身命中时为空串） */
      realRel: string
      /** realBase + realRel（词法结果，realpath 仍由各层既有机制完成） */
      realPath: string
      /** true = 命中 legacyRootAliases 只读别名 */
      readOnly: boolean
    }
  | { mounted: false }

/** 规范化：反斜杠 → /，去前导分隔符。 */
function normalizeLexical(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '')
}

/** 解析 `.`/`..` 词法段；`..` 逃出根时返回 undefined（越界）。 */
function resolveDotSegments(segments: string[]): string[] | undefined {
  const stack: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return undefined
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return stack
}

function splitSegments(lexical: string): string[] {
  return lexical.split('/')
}

/** 大小写不敏感的路径段前缀匹配：whole === base 或 whole 以 base + '/' 开头。 */
function hasPathPrefix(whole: string, base: string): boolean {
  const w = whole.toLowerCase()
  const b = base.toLowerCase()
  return w === b || w.startsWith(`${b}/`)
}

export function resolveWikiMount(
  workDir: string,
  wikiConfig: WikiConfig,
  userDataPath: string,
  pathInput: string
): WikiMountResolution {
  if (typeof pathInput !== 'string' || pathInput.length === 0) return { mounted: false }

  const rootDirname = wikiConfig.rootPath || DEFAULT_WIKI_ROOT_DIRNAME
  const realBase = path.join(userDataPath, rootDirname)

  // 候选词汇路径：入参 → 规范化 → 相对 workDir 化 → 点段解析。逃逸/越界 ⇒ 不挂载。
  let vocabulary: string | undefined

  if (path.isAbsolute(pathInput)) {
    // 规则 2：realBase 绝对形态反向命中（{userData}/<rootPath>/... → 词汇形态）
    const normalizedAbs = normalizeLexical(pathInput)
    const normalizedBase = normalizeLexical(realBase)
    if (hasPathPrefix(normalizedAbs, normalizedBase)) {
      const suffix = normalizedAbs.slice(normalizedBase.length).replace(/^\/+/, '')
      const resolved = resolveDotSegments(splitSegments(suffix))
      if (resolved === undefined) return { mounted: false }
      vocabulary = [WIKI_VOCABULARY_PREFIX, ...resolved].join('/')
    } else {
      // 规则 3：其余绝对路径先相对 workDir 化，越界不挂载
      const rel = path.relative(workDir, pathInput)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { mounted: false }
      const resolved = resolveDotSegments(splitSegments(normalizeLexical(rel)))
      if (resolved === undefined) return { mounted: false }
      vocabulary = resolved.join('/')
    }
  } else {
    const resolved = resolveDotSegments(splitSegments(normalizeLexical(pathInput)))
    if (resolved === undefined) return { mounted: false }
    vocabulary = resolved.join('/')
  }

  if (!vocabulary) return { mounted: false }

  // 规则 4：词汇前缀（<wikiRoot> 本身或 <wikiRoot>/...）→ 读写均允许
  if (hasPathPrefix(vocabulary, WIKI_VOCABULARY_PREFIX)) {
    return buildMounted(vocabulary, WIKI_VOCABULARY_PREFIX, realBase, false)
  }

  // 规则 5：legacyRootAliases 只读别名前缀 → readOnly
  for (const alias of wikiConfig.legacyRootAliases ?? []) {
    if (!alias) continue
    const aliasLexical = normalizeLexical(alias).replace(/\/+$/, '')
    if (!aliasLexical) continue
    if (hasPathPrefix(vocabulary, aliasLexical)) {
      return buildMounted(vocabulary, aliasLexical, realBase, true)
    }
  }

  // 规则 6：其余不挂载，走原 workDir 逻辑
  return { mounted: false }
}

function buildMounted(rawVocabulary: string, prefix: string, realBase: string, readOnly: boolean): WikiMountResolution {
  // BLK-5：vocabularyPath 前缀段规范化为命中的规范前缀（大小写不敏感命中时，入参可能是
  // 'LLM-WIKI/...' 变体）——下游 classifyWikiPath 等大小写敏感消费者据此保持 raw deny 语义；
  // 后缀段保留入参形态。
  const suffix = rawVocabulary.slice(prefix.length).replace(/^\/+/, '')
  const segments = resolveDotSegments(splitSegments(suffix)) ?? []
  const vocabularyPath = segments.length > 0 ? `${prefix}/${segments.join('/')}` : prefix
  const realRel = segments.length > 0 ? segments.join(path.sep) : ''
  return {
    mounted: true,
    vocabularyPath,
    matchedPrefix: prefix,
    realBase,
    realRel,
    realPath: realRel ? path.join(realBase, realRel) : realBase,
    readOnly
  }
}
