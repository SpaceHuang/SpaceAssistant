import { useEffect, useMemo, useState } from 'react'
import { Button } from 'antd'
import type { McpResultDisplay } from '../../../shared/mcpToolResultDisplay'
import { buildMcpCopyText } from '../../../shared/mcpResultCopy'
import { maskSensitiveText } from '../../../shared/mcpSensitiveText'
import { writeClipboardText } from '../../utils/selectionCopy'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ChatMarkdown } from './ChatMarkdown'
import type { ChatSearchActiveTarget } from '../../services/chatSearchActiveTarget'
import type { ReactNode } from 'react'

type Props = { display: McpResultDisplay; fragmentId?: string; messageId?: string; toolUseId?: string; activeSearchTarget?: ChatSearchActiveTarget | null }

function isMarkdownLike(text: string): boolean {
  return /(^|\n)(#{1,6}\s|[-*+]\s|>\s|```)|\|.+\|/.test(text)
}


function parseJsonResult(text: string): string | undefined {
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object') return undefined
    return maskSensitiveText(JSON.stringify(value, null, 2))
  } catch {
    return undefined
  }
}


function highlight(text: string, target: ChatSearchActiveTarget | null, fragmentId?: string): ReactNode {
  if (!target || target.fragmentId !== fragmentId || target.end <= target.start) return text
  return <>{text.slice(0, target.start)}<mark className="sa-search-highlight sa-search-highlight-current" aria-current="true">{text.slice(target.start, target.end)}</mark>{text.slice(target.end)}</>
}

export function McpToolResultView({ display, fragmentId, messageId, toolUseId, activeSearchTarget = null }: Props) {
  const { t } = useTypedTranslation('chat')
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(Boolean(activeSearchTarget))
  const [openFailed, setOpenFailed] = useState(false)
  const copy = async () => {
    setCopying(true)
    try { const result = buildMcpCopyText(display, 1024 * 1024); await writeClipboardText(maskSensitiveText(result.text)); setCopied(true) } finally { setCopying(false) }
  }
  const openArtifact = async () => {
    if (!display.artifactId || !display.artifactOwner) return
    const result = await window.api.mcpOpenResultArtifact({ artifactId: display.artifactId, owner: display.artifactOwner })
    setOpenFailed(!result.ok)
  }
  useEffect(() => {
    if (activeSearchTarget) setExpanded(true)
  }, [activeSearchTarget])
  const huge = display.displayMode === 'huge'
  const lines = useMemo(() => display.text.split(/\r?\n/), [display.text])
  const needsExpand = display.displayMode === 'medium' || display.displayMode === 'long'
  const visibleText = needsExpand && !expanded ? lines.slice(0, 20).join('\n') : display.text
  const searchableText = [display.text, display.structuredText].filter(Boolean).join('\n\n')
  const jsonText = !needsExpand || expanded ? parseJsonResult(visibleText) : undefined
  if (display.isEmpty) return <span className="tool-row-detail__message">{t('mcp.resultEmpty')}</span>
  return (
    <div className="mcp-tool-result">
      <Button size="small" type="text" loading={copying} onClick={() => void copy()}>{copied ? t('table.copied') : t('mcp.copyResult')}</Button>
      {display.artifactId && display.artifactOwner ? <Button size="small" type="text" onClick={() => void openArtifact()}>{t('mcp.openArtifact')}</Button> : null}
      {openFailed ? <span className="tool-row-detail__message">{t('mcp.openFailed')}</span> : null}
      {huge ? <span className="tool-row-detail__message">{t('mcp.resultTooLarge')}</span> : null}
      {!huge && (activeSearchTarget ? searchableText : display.text) ? (activeSearchTarget ? <pre className="sa-chat-inset-code sa-command-inset" data-search-fragment-id={fragmentId}>{highlight(searchableText, activeSearchTarget, fragmentId)}</pre> : display.displayMode === 'long' ? <pre className="sa-chat-inset-code sa-command-inset" data-search-fragment-id={fragmentId}>{visibleText}</pre> : jsonText ? <ChatMarkdown content={`\`\`\`json\n${jsonText}\n\`\`\``} messageId={messageId} toolUseId={toolUseId} fragmentKindPrefix="tool-result" allowLocalFileLinks={false} enableMath={false} sanitizeText={maskSensitiveText} /> : isMarkdownLike(visibleText) ? <ChatMarkdown content={visibleText} messageId={messageId} toolUseId={toolUseId} fragmentKindPrefix="tool-result" allowLocalFileLinks={false} enableMath={false} sanitizeText={maskSensitiveText} /> : <pre className="sa-chat-inset-code sa-command-inset" data-search-fragment-id={fragmentId}>{visibleText}</pre>) : null}
      {!huge && needsExpand && !expanded ? <Button size="small" type="text" onClick={() => setExpanded(true)}>{t('mcp.expandAll', { count: lines.length })}</Button> : null}
      {display.blocks.filter((block) => block.kind !== 'text').map((block, index) => (
        <div key={index} className="tool-row-detail__message">
          {block.kind === 'image' ? <>
            {block.previewable && block.data ? <img src={`data:${block.mimeType};base64,${block.data}`} alt={`图片结果 · ${block.mimeType}`} /> : null}
            <span>{t('mcp.imageResult', { mimeType: block.mimeType, size: block.byteLength })}</span>
          </> : null}
          {block.kind === 'resource' ? t('mcp.resourceResult', { name: block.name ?? block.uri, uri: block.uri }) : null}
          {block.kind === 'unknown' ? block.raw : null}
        </div>
      ))}
      {!huge && (display.structuredText ?? display.structured !== undefined) ? <pre className="sa-chat-inset-code sa-command-inset">{display.structuredText ?? maskSensitiveText(JSON.stringify(display.structured, null, 2))}</pre> : null}
    </div>
  )
}
