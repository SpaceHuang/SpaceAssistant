import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeExternalLinks from 'rehype-external-links'
import { remarkSemanticStatusEmoji } from '../../../shared/markdownSemanticStatusEmoji'
import { ShikiCodeBlock } from './ShikiCodeBlock'
import { MarkdownLinkOrStatusDot } from '../shared/MarkdownLinkOrStatusDot'

type Props = {
  content: string
  wikiRootPath?: string
  baseRelPath?: string | null
  onOpenFile?: (relPath: string, fragment?: string) => void
}

export function ChatMarkdown({ content, wikiRootPath = 'llm-wiki', baseRelPath, onOpenFile }: Props) {
  return (
    <div className="sa-prose chat-md-assistant">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSemanticStatusEmoji]}
        rehypePlugins={[[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]]}
        components={{
          a(props) {
            const { children, href, ...rest } = props
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
