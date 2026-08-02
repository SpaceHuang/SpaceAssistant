import ReactMarkdown from 'react-markdown'
import { Button } from 'antd'
import { Check, Copy } from 'lucide-react'
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { writeClipboardText } from '../../utils/selectionCopy'
import { tableToMarkdown } from '../../utils/tableMarkdownCopy'

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
  const { t } = useTypedTranslation('chat')
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
      table({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
        const tableRef = useRef<HTMLTableElement>(null)
        const [copied, setCopied] = useState(false)
        const [mouseInside, setMouseInside] = useState(false)

        const copyTable = async () => {
          const markdown = tableRef.current ? tableToMarkdown(tableRef.current) : null
          if (!markdown) return
          await writeClipboardText(markdown)
          setCopied(true)
        }

        return (
          <div
            className={`chat-md-table-shell${mouseInside ? '' : ' chat-md-table-shell--mouse-left'}`}
            onMouseEnter={() => setMouseInside(true)}
            onMouseLeave={() => {
              setMouseInside(false)
              setCopied(false)
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCopied(false)
            }}
          >
            <Button
              type="text"
              size="small"
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              className="chat-md-table-copy"
              aria-label={copied ? t('table.copied') : t('table.copyMarkdown')}
              title={copied ? t('table.copied') : t('table.copyMarkdown')}
              onClick={() => void copyTable()}
            >
              {copied ? t('table.copied') : t('table.copyMarkdown')}
            </Button>
            <div className="chat-md-table-wrap">
              <table ref={tableRef} {...rest}>{children}</table>
            </div>
          </div>
        )
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
    [wikiRootPath, baseRelPath, onOpenFile, messageId, segmentIndex, activeSearchTarget, codeOrder, t]
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
