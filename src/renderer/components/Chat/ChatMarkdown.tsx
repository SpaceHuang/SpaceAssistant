import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
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
import { buildFragmentId, type SearchSource } from '../../../shared/chatSearchFragments'
import { ShikiCodeBlock } from './ShikiCodeBlock'
import { MarkdownLinkOrStatusDot } from '../shared/MarkdownLinkOrStatusDot'
import { markdownRemarkPlugins, markdownRehypePlugins } from '../../utils/markdownPlugins'
import { projectMarkdownForSearch } from '../../services/markdownSearchProjection'
import type { ChatSearchActiveTarget } from '../../services/chatSearchActiveTarget'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { writeClipboardText } from '../../utils/selectionCopy'
import { tableToMarkdown } from '../../utils/tableMarkdownCopy'
import { sanitizeMcpResourceUri } from '../../../shared/mcpResourceUri'
import { findSensitiveTextRanges } from '../../../shared/mcpSensitiveText'

type Props = {
  content: string
  wikiRootPath?: string
  baseRelPath?: string | null
  onOpenFile?: (relPath: string, fragment?: string) => void
  messageId?: string
  segmentIndex?: number
  activeSearchTarget?: ChatSearchActiveTarget | null
  fragmentKindPrefix?: 'assistant' | 'tool-result'
  toolUseId?: string
  allowLocalFileLinks?: boolean
  enableMath?: boolean
  sanitizeText?: (text: string) => string
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
  , fragmentKindPrefix = 'assistant'
  , toolUseId
  , allowLocalFileLinks = true
  , enableMath = true
  , sanitizeText
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
          kind: fragmentKindPrefix === 'tool-result' ? 'tool-result-markdown-text' : 'assistant-markdown-text',
          ...(fragmentKindPrefix === 'tool-result' ? { toolUseId: toolUseId ?? 'mcp-result' } : {}),
          segmentIndex,
          fragmentIndex: 0
        } as SearchSource)
      : undefined

  const components = useMemo(
    () => ({
      a(props: ComponentPropsWithoutRef<'a'> & { node?: unknown; children?: ReactNode }) {
        const { children, href, title, node: _node, ...rest } = props
        return (
          <MarkdownLinkOrStatusDot
            {...rest}
            href={sanitizeText && href ? sanitizeMcpResourceUri(href) : href}
            title={sanitizeText ? sanitizeText(title ?? '') : title}
            wikiRootPath={wikiRootPath}
            baseRelPath={baseRelPath}
            onOpenFile={allowLocalFileLinks ? onOpenFile : undefined}
          >
            {children}
          </MarkdownLinkOrStatusDot>
        )
      },
      pre({ children }: { children?: ReactNode }) {
        return <>{children}</>
      },
      text({ children }: { children?: ReactNode }) {
        const value = String(children ?? '')
        return <>{sanitizeText ? sanitizeText(value) : value}</>
      },
      img(props: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
        const { node: _node, src, title, alt, ...rest } = props
        return <img {...rest} src={sanitizeText && src ? sanitizeMcpResourceUri(src) : src} title={sanitizeText ? sanitizeText(title ?? '') : title} alt={sanitizeText ? sanitizeText(alt ?? '') : alt} />
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
        const text = (sanitizeText ? sanitizeText(String(children)) : String(children)).replace(/\n$/, '')
        const isBlock = Boolean(match) || text.includes('\n')
        const codeText = text
        const codeIndex = codeOrder.findIndex((fragment, index) => index >= codeIndexRef.current && fragment.searchableText === codeText && fragment.inline === !isBlock)
        codeIndexRef.current = Math.max(codeIndexRef.current + 1, codeIndex + 1)
        const fragmentId =
          messageId != null
            ? buildFragmentId(messageId, {
                kind: fragmentKindPrefix === 'tool-result' ? 'tool-result-code' : 'assistant-code',
                ...(fragmentKindPrefix === 'tool-result' ? { toolUseId: toolUseId ?? 'mcp-result' } : {}),
                segmentIndex,
                codeIndex,
                inline: !isBlock
              } as SearchSource)
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
    [wikiRootPath, baseRelPath, onOpenFile, allowLocalFileLinks, messageId, segmentIndex, activeSearchTarget, codeOrder, t, fragmentKindPrefix, toolUseId, sanitizeText]
  )

  // KaTeX 会替换 math 节点；按投影顺序（display 先、再 inline）标注 fragment 身份
  useEffect(() => {
    const root = rootRef.current
    if (!root || !sanitizeText) return
    const sanitizeDom = () => {
      const blockNodes = Array.from(root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,td,th,code,a'))
      for (const block of blockNodes) {
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        let node: Node | null
        while ((node = walker.nextNode())) nodes.push(node as Text)
        if (nodes.length < 2) continue
        const original = nodes.map((textNode) => textNode.nodeValue ?? '').join('')
        const ranges = findSensitiveTextRanges(original)
        if (ranges.length > 0) {
          let offset = 0
          for (const textNode of nodes) {
            const value = textNode.nodeValue ?? ''
            const start = offset
            const end = offset + value.length
            const replacements = ranges.filter((range) => range.start < end && range.end > start)
            if (replacements.length > 0) {
              let next = value
              for (const range of replacements.reverse()) {
                const from = Math.max(range.start, start) - start
                const to = Math.min(range.end, end) - start
                const replacement = range.start >= start ? '<secret:redacted>' : ''
                next = next.slice(0, from) + replacement + next.slice(to)
              }
              textNode.nodeValue = next
            }
            offset = end
          }
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      let node: Node | null
      while ((node = walker.nextNode())) nodes.push(node as Text)
      for (const textNode of nodes) {
        const safe = sanitizeText(textNode.nodeValue ?? '')
        if (safe !== textNode.nodeValue) textNode.nodeValue = safe
      }
    }
    sanitizeDom()
    const observer = new MutationObserver(sanitizeDom)
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [rendered, sanitizeText])

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
        kind: fragmentKindPrefix === 'tool-result' ? 'tool-result-math' : 'assistant-math',
        ...(fragmentKindPrefix === 'tool-result' ? { toolUseId: toolUseId ?? 'mcp-result' } : {}),
        segmentIndex,
        mathIndex,
        display: true
      } as SearchSource)
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
        kind: fragmentKindPrefix === 'tool-result' ? 'tool-result-math' : 'assistant-math',
        ...(fragmentKindPrefix === 'tool-result' ? { toolUseId: toolUseId ?? 'mcp-result' } : {}),
        segmentIndex,
        mathIndex,
        display: false
      } as SearchSource)
      el.setAttribute('data-search-fragment-id', fragmentId)
      const active = activeSearchTarget?.fragmentId === fragmentId
      el.classList.toggle('sa-search-highlight', active)
      el.classList.toggle('sa-search-highlight-current', active)
      if (active) el.setAttribute('aria-current', 'true')
      else el.removeAttribute('aria-current')
      mathIndex += 1
    }
  }, [rendered, messageId, segmentIndex, activeSearchTarget, fragmentKindPrefix, toolUseId])

  return (
    <div ref={rootRef} className="sa-prose chat-md-assistant" data-search-fragment-id={plainFragmentId}>
      <ReactMarkdown
        remarkPlugins={enableMath ? markdownRemarkPlugins : markdownRemarkPlugins.filter((plugin) => plugin !== remarkMath)}
        rehypePlugins={enableMath ? markdownRehypePlugins : markdownRehypePlugins.filter((plugin) => plugin !== rehypeKatex)}
        components={components}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  )
})
