import type { ReactNode } from 'react'
import { isValidElement } from 'react'

/** 从 react-markdown 标题 children 提取纯文本，用于生成锚点 id */
export function markdownHeadingText(children: ReactNode): string {
  if (children == null || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(markdownHeadingText).join('')
  if (isValidElement(children)) return markdownHeadingText(children.props.children)
  return ''
}
