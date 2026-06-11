import { memo, useEffect, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeExternalLinks from 'rehype-external-links'
import { expandWikilinks } from '../../../shared/wikiMarkdown'
import { remarkSemanticStatusEmoji } from '../../../shared/markdownSemanticStatusEmoji'
import { slugifyMarkdownHeading } from '../../../shared/markdownLinkResolve'
import { MarkdownLinkOrStatusDot } from '../shared/MarkdownLinkOrStatusDot'
import { markdownHeadingText } from '../../utils/markdownHeadingText'
import { scrollToMarkdownFragment } from '../../utils/markdownFragmentScroll'
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

function markdownHeading(
  Tag: (typeof HEADING_TAGS)[number]
): (props: ComponentProps<(typeof HEADING_TAGS)[number]>) => JSX.Element {
  return function MarkdownHeading({ children, ...rest }) {
    const text = markdownHeadingText(children)
    const id = slugifyMarkdownHeading(text)
    return (
      <Tag {...rest} id={id || undefined}>
        {children}
      </Tag>
    )
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
  const rendered = expandWikilinks(content, wikiRootPath)
  const containerRef = useRef<HTMLDivElement>(null)

  const headingComponents = useMemo(
    () =>
      Object.fromEntries(HEADING_TAGS.map((tag) => [tag, markdownHeading(tag)])) as Record<
        (typeof HEADING_TAGS)[number],
        ReturnType<typeof markdownHeading>
      >,
    []
  )

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
        remarkPlugins={[remarkGfm, remarkSemanticStatusEmoji]}
        rehypePlugins={[[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]]}
        components={{
          ...headingComponents,
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
