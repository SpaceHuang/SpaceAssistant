import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeExternalLinks from 'rehype-external-links'

type Props = {
  content: string
}

export function MarkdownRenderView({ content }: Props) {
  return (
    <div className="detail-md-render">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
