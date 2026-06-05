import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast'

export const MD_STATUS_DOT_HREF_PREFIX = 'sa-md-status-dot:'

export type MarkdownStatusTone = 'success' | 'warning' | 'error' | 'neutral'

const STATUS_EMOJI: Readonly<Record<string, MarkdownStatusTone>> = {
  '🟢': 'success',
  '🟩': 'success',
  '✅': 'success',
  '✔': 'success',
  '✔️': 'success',
  '☑': 'success',
  '☑️': 'success',
  '🟡': 'warning',
  '🟠': 'warning',
  '🟨': 'warning',
  '⚠': 'warning',
  '⚠️': 'warning',
  '🔴': 'error',
  '🟥': 'error',
  '❌': 'error',
  '⛔': 'error'
}

const STATUS_EMOJI_PATTERN = new RegExp(
  Object.keys(STATUS_EMOJI)
    .sort((a, b) => b.length - a.length)
    .map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gu'
)

export function toneForStatusEmoji(emoji: string): MarkdownStatusTone {
  return STATUS_EMOJI[emoji] ?? 'neutral'
}

function statusDotLink(tone: MarkdownStatusTone): Link {
  return {
    type: 'link',
    url: `${MD_STATUS_DOT_HREF_PREFIX}${tone}`,
    title: null,
    children: [{ type: 'text', value: '\u200b' }]
  }
}

export function splitTextWithStatusDots(text: Text): PhrasingContent[] {
  const value = text.value
  if (!STATUS_EMOJI_PATTERN.test(value)) {
    STATUS_EMOJI_PATTERN.lastIndex = 0
    return [text]
  }
  STATUS_EMOJI_PATTERN.lastIndex = 0

  const parts: PhrasingContent[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  const pattern = new RegExp(STATUS_EMOJI_PATTERN.source, 'gu')

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: value.slice(lastIndex, match.index) })
    }
    parts.push(statusDotLink(toneForStatusEmoji(match[0])))
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < value.length) {
    parts.push({ type: 'text', value: value.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [text]
}

function transformStatusEmojiInParent(parent: Parent) {
  const { children } = parent
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child.type === 'text') {
      const next = splitTextWithStatusDots(child)
      if (next.length > 1) {
        children.splice(index, 1, ...next)
        index += next.length - 1
      }
      continue
    }
    if ('children' in child && Array.isArray(child.children)) {
      transformStatusEmojiInParent(child as Parent)
    }
  }
}

/** 将 LLM 常用的彩色状态 emoji 替换为可主题化的语义圆点链接节点 */
export function remarkSemanticStatusEmoji() {
  return (tree: Root) => {
    transformStatusEmojiInParent(tree)
  }
}

export function isMarkdownStatusDotHref(href: string | undefined): href is string {
  return typeof href === 'string' && href.startsWith(MD_STATUS_DOT_HREF_PREFIX)
}

export function toneFromMarkdownStatusDotHref(href: string): MarkdownStatusTone {
  const tone = href.slice(MD_STATUS_DOT_HREF_PREFIX.length)
  if (tone === 'success' || tone === 'warning' || tone === 'error' || tone === 'neutral') {
    return tone
  }
  return 'neutral'
}
