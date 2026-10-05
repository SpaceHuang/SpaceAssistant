import { useEffect, useMemo, useState } from 'react'
import { Button } from 'antd'
import type { McpResultDisplay } from '../../../shared/mcpToolResultDisplay'
import { buildMcpCopyText } from '../../../shared/mcpResultCopy'
import { maskSensitiveText } from '../../../shared/mcpSensitiveText'
import { writeClipboardText } from '../../utils/selectionCopy'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { runtimeText } from '../../i18n/runtimeText'
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

function parseJsonValue(text: string): unknown | undefined {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function formatJsonCell(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return maskSensitiveText(JSON.stringify(value, null, 2))
}

function JsonValueRows({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const canExpand = depth < 1
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="mcp-json-table__empty">[]</span>
    if (canExpand && value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      return <div className="mcp-json-table__array">{value.map((item, index) => <section className="mcp-json-table__item" key={index}><div className="mcp-json-table__item-label">[{index}]</div><JsonValueRows value={item} depth={depth + 1} /></section>)}</div>
    }
    if (canExpand && value.every((item) => item === null || typeof item !== 'object')) {
      return <span>{value.map(formatJsonCell).join(', ')}</span>
    }
    return <pre className="mcp-json-table__compact">{formatJsonCell(value)}</pre>
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span className="mcp-json-table__empty">{'{}'}</span>
    return <table className="mcp-json-table"><tbody>{entries.map(([key, child]) => (
      <tr key={key}>
        <th scope="row">{maskSensitiveText(key)}</th>
        <td>{canExpand && child && typeof child === 'object' ? <JsonValueRows value={child} depth={depth + 1} /> : formatJsonCell(child)}</td>
      </tr>
    ))}</tbody></table>
  }
  return <span>{formatJsonCell(value)}</span>
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
  const parsedTextJson = !needsExpand || expanded ? parseJsonValue(visibleText) : undefined
  const structuredJson = display.structured ?? parsedTextJson
  if (display.isEmpty) return <span className="tool-row-detail__message">{t('mcp.resultEmpty')}</span>
  return (
    <div className="mcp-tool-result">
      <Button size="small" type="text" loading={copying} onClick={() => void copy()}>{copied ? t('table.copied') : t('mcp.copyResult')}</Button>
      {display.artifactId && display.artifactOwner ? <Button size="small" type="text" onClick={() => void openArtifact()}>{t('mcp.openArtifact')}</Button> : null}
      {openFailed ? <span className="tool-row-detail__message">{t('mcp.openFailed')}</span> : null}
      {huge ? <span className="tool-row-detail__message">{t('mcp.resultTooLarge')}</span> : null}
      {!huge && structuredJson !== undefined && !activeSearchTarget ? <div data-search-fragment-id={fragmentId}><JsonValueRows value={structuredJson} /></div> : null}
      {!huge && structuredJson === undefined && (activeSearchTarget ? searchableText : display.text) ? (activeSearchTarget ? <pre className="sa-chat-inset-code sa-command-inset" data-search-fragment-id={fragmentId}>{highlight(searchableText, activeSearchTarget, fragmentId)}</pre> : display.displayMode === 'long' ? <pre className="sa-chat-inset-code sa-command-inset" data-search-fragment-id={fragmentId}>{visibleText}</pre> : jsonText ? <ChatMarkdown content={`\`\`\`json\n${jsonText}\n\`\`\``} messageId={messageId} toolUseId={toolUseId} fragmentKindPrefix="tool-result" allowLocalFileLinks={false} enableMath={false} sanitizeText={maskSensitiveText} /> : isMarkdownLike(visibleText) ? <ChatMarkdown content={visibleText} messageId={messageId} toolUseId={toolUseId} fragmentKindPrefix="tool-result" allowLocalFileLinks={false} enableMath={false} sanitizeText={maskSensitiveText} /> : <pre className="sa-chat-inset-code sa-command-inset" data-search-fragment-id={fragmentId}>{visibleText}</pre>) : null}
      {!huge && needsExpand && !expanded ? <Button size="small" type="text" onClick={() => setExpanded(true)}>{t('mcp.expandAll', { count: lines.length })}</Button> : null}
      {display.blocks.filter((block) => block.kind !== 'text').map((block, index) => (
        <div key={index} className="tool-row-detail__message">
          {block.kind === 'image' ? <>
            {block.previewable && block.data ? <img src={`data:${block.mimeType};base64,${block.data}`} alt={runtimeText('chat.mcpImageAlt', { mimeType: block.mimeType })} /> : null}
            <span>{t('mcp.imageResult', { mimeType: block.mimeType, size: block.byteLength })}</span>
          </> : null}
          {block.kind === 'resource' ? t('mcp.resourceResult', { name: block.name ?? block.uri, uri: block.uri }) : null}
          {block.kind === 'unknown' ? block.raw : null}
        </div>
      ))}
      {!huge && display.structuredText && !display.structured && !parsedTextJson ? <pre className="sa-chat-inset-code sa-command-inset">{display.structuredText}</pre> : null}
    </div>
  )
}
