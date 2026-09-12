/**
 * PowerShell 非交互宿主会把 progress / 错误序列化成 CLIXML 写进 stderr（§5 S5、§10.2）。
 * 本模块只做最小剥壳：把 `#< CLIXML` 包装里的错误/警告文本取出，不做完整 XML 解析。
 */
const CLIXML_HEADER = '#< CLIXML'
const CLIXML_STREAM_RE = /<S\s+S="(?:Error|Warning|Verbose|Debug)"[^>]*>([\s\S]*?)<\/S>/g
const CLIXML_ESCAPE_RE = /_x([0-9A-Fa-f]{4})_/g

function decodeClixmlEscapes(value: string): string {
  return value.replace(CLIXML_ESCAPE_RE, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

export function isClixmlPayload(text: string): boolean {
  return text.startsWith(CLIXML_HEADER)
}

export function stripClixmlWrapper(text: string): string {
  if (!isClixmlPayload(text)) return text
  const matches = [...text.matchAll(CLIXML_STREAM_RE)]
  if (matches.length === 0) return text
  return matches.map((match) => decodeClixmlEscapes(match[1])).join('')
}
