import type { SearchTextAnchor } from '../../shared/chatSearchFragments'

export type MarkdownPlainTextFragment = {
  segmentIndex: number
  fragmentIndex: number
  searchableText: string
  /** MVP：暂不在 remark 树上映射 nodeKey，高亮阶段可回退整段文本。 */
  anchors: SearchTextAnchor[]
}

export type MarkdownCodeFragment = {
  segmentIndex: number
  codeIndex: number
  inline: boolean
  searchableText: string
}

export type MarkdownMathFragment = {
  segmentIndex: number
  mathIndex: number
  display: boolean
  searchableText: string
}

export type MarkdownSearchProjection = {
  plainTextFragments: MarkdownPlainTextFragment[]
  codeFragments: MarkdownCodeFragment[]
  mathFragments: MarkdownMathFragment[]
}

const FENCED_CODE_RE = /```[^\n]*\n([\s\S]*?)```/g
const INLINE_CODE_RE = /`([^`\n]+)`/g
const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g
const INLINE_MATH_RE = /(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g

type Span = { start: number; end: number }

function collectSpans(text: string, re: RegExp): Span[] {
  const spans: Span[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length })
  }
  return spans
}

function overlaps(span: Span, spans: Span[]): boolean {
  return spans.some((s) => span.start < s.end && span.end > s.start)
}

function stripMarkdownSyntax(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildPlainText(markdown: string, excluded: Span[]): string {
  let plain = ''
  let cursor = 0
  const sorted = [...excluded].sort((a, b) => a.start - b.start)
  for (const span of sorted) {
    if (span.start > cursor) {
      plain += markdown.slice(cursor, span.start)
    }
    cursor = Math.max(cursor, span.end)
  }
  if (cursor < markdown.length) {
    plain += markdown.slice(cursor)
  }
  return stripMarkdownSyntax(plain)
}

/** 从 Markdown 源文本生成可搜索片段（MVP：正则提取，不依赖 remark 插件）。 */
export function projectMarkdownForSearch(markdown: string, segmentIndex: number): MarkdownSearchProjection {
  const fencedSpans = collectSpans(markdown, FENCED_CODE_RE)
  const inlineCodeSpans = collectSpans(markdown, INLINE_CODE_RE).filter((s) => !overlaps(s, fencedSpans))
  const displayMathSpans = collectSpans(markdown, DISPLAY_MATH_RE)
  const inlineMathSpans = collectSpans(markdown, INLINE_MATH_RE).filter(
    (s) => !overlaps(s, [...fencedSpans, ...displayMathSpans])
  )

  const codeTokens: Array<{ start: number; inline: boolean; searchableText: string }> = []
  INLINE_CODE_RE.lastIndex = 0
  let inlineMatch: RegExpExecArray | null
  while ((inlineMatch = INLINE_CODE_RE.exec(markdown)) !== null) {
    const span = { start: inlineMatch.index, end: inlineMatch.index + inlineMatch[0].length }
    if (!overlaps(span, fencedSpans)) codeTokens.push({ start: span.start, inline: true, searchableText: inlineMatch[1] ?? '' })
  }
  FENCED_CODE_RE.lastIndex = 0
  let fencedMatch: RegExpExecArray | null
  while ((fencedMatch = FENCED_CODE_RE.exec(markdown)) !== null) {
    codeTokens.push({ start: fencedMatch.index, inline: false, searchableText: (fencedMatch[1] ?? '').replace(/\n$/, '') })
  }
  const codeFragments: MarkdownCodeFragment[] = codeTokens
    .sort((a, b) => a.start - b.start)
    .map((token, codeIndex) => ({ segmentIndex, codeIndex, inline: token.inline, searchableText: token.searchableText }))

  const mathFragments: MarkdownMathFragment[] = []
  let mathIndex = 0

  DISPLAY_MATH_RE.lastIndex = 0
  let displayMatch: RegExpExecArray | null
  while ((displayMatch = DISPLAY_MATH_RE.exec(markdown)) !== null) {
    mathFragments.push({
      segmentIndex,
      mathIndex: mathIndex++,
      display: true,
      searchableText: (displayMatch[1] ?? '').trim()
    })
  }

  INLINE_MATH_RE.lastIndex = 0
  let inlineMathMatch: RegExpExecArray | null
  while ((inlineMathMatch = INLINE_MATH_RE.exec(markdown)) !== null) {
    const span = { start: inlineMathMatch.index, end: inlineMathMatch.index + inlineMathMatch[0].length }
    if (overlaps(span, displayMathSpans)) continue
    mathFragments.push({
      segmentIndex,
      mathIndex: mathIndex++,
      display: false,
      searchableText: (inlineMathMatch[1] ?? '').trim()
    })
  }

  const excluded = [...fencedSpans, ...inlineCodeSpans, ...displayMathSpans, ...inlineMathSpans]
  const plainText = buildPlainText(markdown, excluded)

  const plainTextFragments: MarkdownPlainTextFragment[] = plainText
    ? [
        {
          segmentIndex,
          fragmentIndex: 0,
          searchableText: plainText,
          anchors: []
        }
      ]
    : []

  return { plainTextFragments, codeFragments, mathFragments }
}
