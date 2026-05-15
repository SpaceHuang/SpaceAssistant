import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeExternalLinks from 'rehype-external-links'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Button } from 'antd'
import { Copy } from 'lucide-react'

type Props = {
  content: string
}

export function ChatMarkdown({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]]}
      components={{
        a(props) {
          const { children, ...rest } = props
          return (
            <a {...rest} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          )
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
          return (
            <div style={{ position: 'relative' }}>
              <Button
                type="text"
                size="small"
                icon={<Copy size={14} />}
                style={{ position: 'absolute', right: 8, top: 8, zIndex: 1 }}
                onClick={() => void navigator.clipboard.writeText(text)}
              >
                复制
              </Button>
              <SyntaxHighlighter style={oneDark} language={lang} PreTag="div">
                {text}
              </SyntaxHighlighter>
            </div>
          )
        }
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
