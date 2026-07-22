import ReactMarkdown from 'react-markdown'
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode
} from 'react'
import { normalizeMarkdownMath } from '../../../shared/markdownMathNormalize'
import { buildFragmentId } from '../../../shared/chatSearchFragments'
import { ShikiCodeBlock } from './ShikiCodeBlock'
import { MarkdownLinkOrStatusDot } from '../shared/MarkdownLinkOrStatusDot'
import { markdownRemarkPlugins, markdownRehypePlugins } from '../../utils/markdownPlugins'
import { projectMarkdownForSearch } from '../../services/markdownSearchProjection'
import type { ChatSearchActiveTarget } from '../../services/chatSearchActiveTarget'

type Props = {
  content: string
  wikiRootPath?: string
  baseRelPath?: string | null
  onOpenFile?: (relPath: string, fragment?: string) => void
  messageId?: string
  segmentIndex?: number
  activeSearchTarget?: ChatSearchActiveTarget | null
}

function splitHighlightedText(text: string, start: number, end: number): ReactNode {
  if (end <= start || start >= text.length) return text
  const safeStart = Math.max(0, start)
  const safeEnd = Math.min(text.length, end)
  return (
    <>
      {text.slice(0, safeStart)}
      <mark className="sa-search-highlight sa-search-highlight-current" aria-current="true">
        {text.slice(safeStart, safeEnd)}
      </mark>
      {text.slice(safeEnd)}
    </>
  )
}

export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  wikiRootPath = 'llm-wiki',
  baseRelPath,
  onOpenFile,
  messageId,
  segmentIndex = 0,
  activeSearchTarget = null
}: Props) {
  const rendered = useMemo(() => normalizeMarkdownMath(content), [content])
  const rootRef = useRef<HTMLDivElement>(null)
  const codeIndexRef = useRef(0)
  const codeOrder = useMemo(() => projectMarkdownForSearch(content, segmentIndex).codeFragments, [content, segmentIndex])
  codeIndexRef.current = 0

  const plainFragmentId =
    messageId != null
      ? buildFragmentId(messageId, {
          kind: 'assistant-markdown-text',
          segmentIndex,
          fragmentIndex: 0
        })
      : undefined

  const components = useMemo(
    () => ({
      a(props: ComponentPropsWithoutRef<'a'> & { node?: unknown; children?: ReactNode }) {
        const { children, href, node: _node, ...rest } = props
        return (
          <MarkdownLinkOrStatusDot
            {...rest}
            href={href}
            wikiRootPath={wikiRootPath}
            baseRelPath={baseRelPath}
            onOpenFile={onOpenFile}
          >
            {children}
          </MarkdownLinkOrStatusDot>
        )
      },
      pre({ children }: { children?: ReactNode }) {
        return <>{children}</>
      },
      code(props: ComponentPropsWithoutRef<'code'> & { node?: unknown; children?: ReactNode }) {
        const { children, className, node: _node, ...rest } = props
        if (className?.includes('language-math')) {
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          )
        }
        const match = /language-(\w+)/.exec(className || '')
        const text = String(children).replace(/\n$/, '')
        const isBlock = Boolean(match) || text.includes('\n')
        const codeText = text
        const codeIndex = codeOrder.findIndex((fragment, index) => index >= codeIndexRef.current && fragment.searchableText === codeText && fragment.inline === !isBlock)
        codeIndexRef.current = Math.max(codeIndexRef.current + 1, codeIndex + 1)
        const fragmentId =
          messageId != null
            ? buildFragmentId(messageId, {
                kind: 'assistant-code',
                segmentIndex,
                codeIndex,
                inline: !isBlock
              })
            : undefined
        const isActive = activeSearchTarget?.fragmentId === fragmentId
        if (!isBlock) {
          return (
            <code className={className} data-search-fragment-id={fragmentId} {...rest}>
              {isActive
                ? splitHighlightedText(text, activeSearchTarget!.start, activeSearchTarget!.end)
                : children}
            </code>
          )
        }
        const lang = match?.[1] ?? 'text'
        return (
          <div data-search-fragment-id={fragmentId}>
            {isActive ? (
              <pre className="sa-chat-inset-code">
                <code>
                  {splitHighlightedText(text, activeSearchTarget!.start, activeSearchTarget!.end)}
                </code>
              </pre>
            ) : (
              <ShikiCodeBlock code={text} language={lang} />
            )}
          </div>
        )
      }
    }),
    [wikiRootPath, baseRelPath, onOpenFile, messageId, segmentIndex, activeSearchTarget, codeOrder]
  )

  // KaTeX 会替换 math 节点；按投影顺序（display 先、再 inline）标注 fragment 身份
  useEffect(() => {
    const root = rootRef.current
    if (!root || !messageId) return

    const displays = Array.from(root.querySelectorAll('.katex-display'))
    const inlines = Array.from(root.querySelectorAll('.katex')).filter(
      (el) => !el.closest('.katex-display')
    )

    let mathIndex = 0
    for (const el of displays) {
      const fragmentId = buildFragmentId(messageId, {
        kind: 'assistant-math',
        segmentIndex,
        mathIndex,
        display: true
      })
      el.setAttribute('data-search-fragment-id', fragmentId)
      const active = activeSearchTarget?.fragmentId === fragmentId
      el.classList.toggle('sa-search-highlight', active)
      el.classList.toggle('sa-search-highlight-current', active)
      if (active) el.setAttribute('aria-current', 'true')
      else el.removeAttribute('aria-current')
      mathIndex += 1
    }
    for (const el of inlines) {
      const fragmentId = buildFragmentId(messageId, {
        kind: 'assistant-math',
        segmentIndex,
        mathIndex,
        display: false
      })
      el.setAttribute('data-search-fragment-id', fragmentId)
      const active = activeSearchTarget?.fragmentId === fragmentId
      el.classList.toggle('sa-search-highlight', active)
      el.classList.toggle('sa-search-highlight-current', active)
      if (active) el.setAttribute('aria-current', 'true')
      else el.removeAttribute('aria-current')
      mathIndex += 1
    }
  }, [rendered, messageId, segmentIndex, activeSearchTarget])

  return (
    <div ref={rootRef} className="sa-prose chat-md-assistant" data-search-fragment-id={plainFragmentId}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  )
})
