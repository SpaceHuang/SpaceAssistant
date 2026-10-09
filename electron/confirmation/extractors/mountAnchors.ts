import path from 'path'

/**
 * 探测层挂载锚点（T1.1，wiki-shared-centralized-storage §7.2）。
 *
 * 锚点由 gate 以 `resolveWikiMount` 结果构造（`{ base: realBase, vocabularyPrefix }`），
 * 探测层只负责「应用锚点」——是否挂载/别名/disabled 的决策仍单点在 resolveWikiMount，
 * 探测层不做挂载决策、不产生前缀判断语义（仅精确应用本次调用的锚点映射）。
 */
export type MountAnchor = { base: string; vocabularyPrefix: string }

export interface MountAnchorHit {
  anchor: MountAnchor
  /** 词汇路径（与 Agent 入参同形、正斜杠化；大小写保留原样） */
  vocabularyPath: string
  /** 挂载内相对路径（正斜杠段，供拼 base） */
  relInBase: string
}

/** 解析 `.`/`..` 词法段；`..` 逃出根时返回 undefined（越界 ⇒ 不命中锚点，走现状逻辑）。 */
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

/**
 * 命中则返回锚点映射；未命中 / 越界 / anchors 缺省返回 undefined（探测层行为与现状逐字节一致）。
 * 匹配大小写不敏感（对齐 wikiMount 的 win32 语义），vocabularyPath 保留入参大小写。
 */
export function matchMountAnchor(
  rawPath: string,
  workDir: string,
  anchors?: readonly MountAnchor[]
): MountAnchorHit | undefined {
  if (!anchors || anchors.length === 0) return undefined
  const trimmed = rawPath.trim()
  if (!trimmed) return undefined

  let lexical: string | undefined
  if (path.isAbsolute(trimmed)) {
    const rel = path.relative(workDir, trimmed)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
    lexical = rel.replace(/\\/g, '/')
  } else {
    lexical = trimmed.replace(/\\/g, '/').replace(/^\/+/, '')
  }
  const segments = resolveDotSegments(lexical.split('/'))
  if (!segments || segments.length === 0) return undefined
  const normalized = segments.join('/')

  for (const anchor of anchors) {
    const prefix = anchor.vocabularyPrefix.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
    if (!prefix) continue
    const p = prefix.toLowerCase()
    if (normalized === p || normalized.startsWith(`${p}/`)) {
      const relInBase = normalized.slice(prefix.length).replace(/^\/+/, '')
      return { anchor, vocabularyPath: normalized, relInBase }
    }
  }
  return undefined
}
