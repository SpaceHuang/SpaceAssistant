import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeExternalLinks from 'rehype-external-links'
import { expandWikilinks } from '../../../shared/wikiMarkdown'
import { isWikiPathLink } from '../../services/wikiCommandService'

type Props = {
  content: string
  wikiRootPath?: string
  onOpenFile?: (relPath: string) => void
}

export function MarkdownRenderView({ content, wikiRootPath = 'llm-wiki', onOpenFile }: Props) {
  const rendered = expandWikilinks(content, wikiRootPath)

  return (
    <div className="detail-md-render">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]]}
        components={{
          a(props) {
            const { children, href, ...rest } = props
            const wikiPath = href ? isWikiPathLink(href, wikiRootPath) : null
            if (wikiPath && onOpenFile) {
              return (
                <a
                  {...rest}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    onOpenFile(wikiPath)
                  }}
                >
                  {children}
                </a>
              )
            }
            return (
              <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          }
        }}
      >
        {rendered}
      </ReactMarkdown>
    </div>
  )
}
