import { memo, useEffect, useMemo, useRef, createElement } from 'react'
import ReactMarkdown from 'react-markdown'
import type { ExtraProps } from 'react-markdown'
import { expandWikilinks } from '../../../shared/wikiMarkdown'
import { normalizeAsciiTables } from '../../../shared/markdownAsciiTableNormalize'
import { normalizeMarkdownMath } from '../../../shared/markdownMathNormalize'
import { markdownRemarkPlugins, markdownRehypePlugins } from '../../utils/markdownPlugins'
import { slugifyMarkdownHeading } from '../../../shared/markdownLinkResolve'
import { MarkdownLinkOrStatusDot } from '../shared/MarkdownLinkOrStatusDot'
import { markdownHeadingText } from '../../utils/markdownHeadingText'
import { scrollToMarkdownFragment } from '../../utils/markdownFragmentScroll'
import { attachMarkdownRenderCopy, mdSourceAttrs, type MdSourceNode } from '../../utils/markdownRenderCopy'
import type { ComponentProps } from 'react'

type Props = {
  content: string
  wikiRootPath?: string
  baseRelPath?: string | null
  onOpenFile?: (relPath: string, fragment?: string) => void
  pendingScrollFragment?: string | null
  onPendingScrollFragmentHandled?: () => void
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
const BLOCK_TAGS = ['p', 'ul', 'ol', 'blockquote', 'pre', 'hr'] as const

type BlockTag = (typeof BLOCK_TAGS)[number]
type HeadingTag = (typeof HEADING_TAGS)[number]

function markdownHeading(
  Tag: HeadingTag
): (props: ComponentProps<HeadingTag> & ExtraProps) => JSX.Element {
  return function MarkdownHeading({ node, children, ...rest }) {
    const text = markdownHeadingText(children)
    const id = slugifyMarkdownHeading(text)
    return (
      <Tag {...rest} {...mdSourceAttrs(node as MdSourceNode)} id={id || undefined}>
        {children}
      </Tag>
    )
  }
}

function mdBlock(Tag: BlockTag): (props: ComponentProps<BlockTag> & ExtraProps) => JSX.Element {
  return function MarkdownBlock({ node, children, ...rest }) {
    return createElement(Tag, { ...rest, ...mdSourceAttrs(node as MdSourceNode) }, children)
  }
}

export const MarkdownRenderView = memo(function MarkdownRenderView({
  content,
  wikiRootPath = 'llm-wiki',
  baseRelPath,
  onOpenFile,
  pendingScrollFragment,
  onPendingScrollFragmentHandled
}: Props) {
  const rendered = useMemo(
    () => expandWikilinks(normalizeMarkdownMath(normalizeAsciiTables(content)), wikiRootPath),
    [content, wikiRootPath]
  )
  const renderedRef = useRef(rendered)
  renderedRef.current = rendered
  const containerRef = useRef<HTMLDivElement>(null)

  const headingComponents = useMemo(
    () =>
      Object.fromEntries(HEADING_TAGS.map((tag) => [tag, markdownHeading(tag)])) as Record<
        HeadingTag,
        ReturnType<typeof markdownHeading>
      >,
    []
  )

  const blockComponents = useMemo(
    () =>
      Object.fromEntries(BLOCK_TAGS.map((tag) => [tag, mdBlock(tag)])) as Record<
        BlockTag,
        ReturnType<typeof mdBlock>
      >,
    []
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    return attachMarkdownRenderCopy(el, () => renderedRef.current).dispose
  }, [])

  useEffect(() => {
    if (!pendingScrollFragment || !containerRef.current) return
    const frame = requestAnimationFrame(() => {
      if (
        containerRef.current &&
        scrollToMarkdownFragment(pendingScrollFragment, containerRef.current)
      ) {
        onPendingScrollFragmentHandled?.()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingScrollFragment, content, onPendingScrollFragmentHandled])

  return (
    <div className="detail-md-render" ref={containerRef}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={[...markdownRehypePlugins]}
        components={{
          ...headingComponents,
          ...blockComponents,
          table({ node, children, ...props }) {
            return (
              <div className="detail-md-table-wrap" {...mdSourceAttrs(node as MdSourceNode)}>
                <table {...props}>{children}</table>
              </div>
            )
          },
          a(props) {
            const { children, href, ...rest } = props
            return (
              <MarkdownLinkOrStatusDot
                {...rest}
                href={href}
                wikiRootPath={wikiRootPath}
                baseRelPath={baseRelPath}
                scrollContainerRef={containerRef}
                onOpenFile={onOpenFile}
              >
                {children}
              </MarkdownLinkOrStatusDot>
            )
          }
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  )
})
