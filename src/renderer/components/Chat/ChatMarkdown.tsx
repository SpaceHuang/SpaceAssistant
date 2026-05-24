import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeExternalLinks from 'rehype-external-links'
import { ShikiCodeBlock } from './ShikiCodeBlock'
import { isWikiPathLink } from '../../services/wikiCommandService'

type Props = {
  content: string
  wikiRootPath?: string
  onOpenFile?: (relPath: string) => void
}

export function ChatMarkdown({ content, wikiRootPath = 'llm-wiki', onOpenFile }: Props) {
  return (
    <div className="sa-prose chat-md-assistant">
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
          },
          pre({ children }) {
            return <>{children}</>
          },
          code(props) {
            const { children, className, ...rest } = props
            const match = /language-(\w+)/.exec(className || '')
            const text = String(children).replace(/\n$/, '')
            const isBlock = Boolean(match) || text.includes('\n')
            if (!isBlock) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              )
            }
            const lang = match?.[1] ?? 'text'
            return <ShikiCodeBlock code={text} language={lang} />
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
