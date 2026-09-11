/**
 * Agent 边界的自由文本脱敏。
 *
 * 这里不试图把任意自然语言“解析成路径”。先保护 URL 和相对路径的语义，
 * 再只处理有明确宿主绝对路径前缀的片段；未加引号的模糊路径按 token 形态
 * 保守截断，不依赖有限的错误关键词。明确边界保留可识别正文，无法判断时
 * 省略当前不确定片段并返回稳定原因。
 */

export interface SanitizedAgentText {
  text: string
  redacted: boolean
  redactionReason?: 'absolute_path' | 'ambiguous_path' | 'secret'
}

const URL_TOKEN = '\u0000agent-url-'
const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>'"`]+/gi
const PATH_BOUNDARY_RE = /(?:\b(?:path|cwd|file|directory|executable):|^|[\s([{"'=])/g
const ABSOLUTE_PREFIX_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|\/(?!\/))/y
// 兼容 `file.py:37:4` 以及 `file.py:37:4: message` 中的分隔冒号。
const TRACEBACK_LOCATION_RE = /(:\d+(?::\d+)?):?$/
const KEYED_PATH_RE = /\b(?:path|cwd|file|directory|executable):/i
const PATH_FILE_LIKE_RE = /\.[A-Za-z0-9]{1,16}(?::\d+(?::\d+)?)?:?$/

function isPathContinuationToken(token: string): boolean {
  return /[\\/]/.test(token) || PATH_FILE_LIKE_RE.test(token)
}

function hasStrongPathTerminator(pathText: string): boolean {
  return PATH_FILE_LIKE_RE.test(pathText.trim())
}

function isHardPathStop(text: string, index: number): boolean {
  const rest = text.slice(index)
  return rest.startsWith('\n') || /^[,;)}\]>]/.test(rest) || /^\s+-\s+/.test(rest)
}

function findPathEnd(text: string, start: number, closingQuote?: string): { end: number; ambiguous: boolean } {
  if (closingQuote) {
    const end = text.indexOf(closingQuote, start)
    return { end: end >= 0 ? end : text.length, ambiguous: false }
  }
  let index = start
  let sawWhitespace = false
  while (index < text.length) {
    if (isHardPathStop(text, index)) break
    const char = text[index]
    if (char === '\n') break
    if (/\s/.test(char)) {
      const wsStart = index
      while (index < text.length && /\s/.test(text[index]) && text[index] !== '\n') index += 1
      const tokenStart = index
      while (index < text.length && !/\s/.test(text[index]) && !/[,;)}>\]]/.test(text[index])) index += 1
      const token = text.slice(tokenStart, index)
      if (!token) break
      const diagnosticBoundary = token.startsWith(URL_TOKEN)
      const keyedBoundary = KEYED_PATH_RE.test(token)
      if (diagnosticBoundary || keyedBoundary) {
        index = wsStart
        break
      }
      if (!isPathContinuationToken(token)) {
        // 普通自由文本没有可靠的自然语言词表边界；停止在当前空格，
        // 只有已经形成明确文件名/traceback 位置时才保留后续正文；
        // 否则当前空格后的片段无法证明不是路径的一部分。
        return { end: wsStart, ambiguous: !hasStrongPathTerminator(text.slice(start, wsStart)) }
      }
      sawWhitespace = true
      continue
    }
    index += 1
  }
  return { end: index, ambiguous: sawWhitespace && !hasStrongPathTerminator(text.slice(start, index)) }
}

function findAmbiguousPathResume(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\n' || /[,;)}\]>]/.test(text[index] ?? '')) return index
  }
  return text.length
}

function restoreUrls(text: string, urls: string[]): string {
  return urls.reduce((result, url, index) => result.replace(`${URL_TOKEN}${index}`, url), text)
}

/** 对进入 Agent、日志或历史的自由文本执行统一脱敏。 */
export function sanitizeAgentText(input: string): SanitizedAgentText {
  const urls: string[] = []
  let text = input.replace(URL_RE, (url) => {
    const token = `${URL_TOKEN}${urls.length}`
    urls.push(url)
    return token
  })
  let output = ''
  let cursor = 0
  let redacted = false
  let ambiguous = false

  while (cursor < text.length) {
    PATH_BOUNDARY_RE.lastIndex = cursor
    const boundary = PATH_BOUNDARY_RE.exec(text)
    if (!boundary) {
      output += text.slice(cursor)
      break
    }
    const pathStart = boundary.index + boundary[0].length
    ABSOLUTE_PREFIX_RE.lastIndex = pathStart
    if (!ABSOLUTE_PREFIX_RE.exec(text)) {
      if (boundary[0].length === 0) {
        output += text[cursor]
        cursor += 1
        continue
      }
      output += text.slice(cursor, pathStart)
      cursor = pathStart
      continue
    }
    const prefix = text.slice(cursor, pathStart)
    output += prefix
    const openingQuote = text[pathStart - 1]
    const closingQuote = openingQuote === '"' || openingQuote === "'" ? openingQuote : undefined
    const { end, ambiguous: pathAmbiguous } = findPathEnd(text, pathStart, closingQuote)
    let path = text.slice(pathStart, end)
    const location = path.match(TRACEBACK_LOCATION_RE)?.[1] ?? ''
    if (location) path = path.slice(0, -location.length)
    output += '<path:redacted>'
    if (location) output += location
    if (closingQuote && text[end] === closingQuote) output += closingQuote
    if (pathAmbiguous) {
      output += ' [path redacted: ambiguous_path]'
      ambiguous = true
    }
    redacted = true
    cursor = pathAmbiguous
      ? findAmbiguousPathResume(text, end)
      : closingQuote && text[end] === closingQuote ? end + 1 : end
  }

  text = restoreUrls(output, urls)
  const secretSafe = text
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, '<secret:redacted>')
    .replace(/((?:API[_-]?KEY|TOKEN|SECRET|COOKIE|PASSWORD|PASSWD)\s*[=:]\s*)[^\s,;]+/gi, '$1<secret:redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<secret:redacted>')
  if (secretSafe !== text) {
    text = secretSafe
    redacted = true
  }
  return {
    text,
    redacted,
    ...(ambiguous ? { redactionReason: 'ambiguous_path' } : redacted ? { redactionReason: 'absolute_path' } : {})
  }
}

/** 兼容旧调用点；新代码应使用 sanitizeAgentText 以保留脱敏元数据。 */
export function redactAbsolutePathFragments(text: string): string {
  return sanitizeAgentText(text).text
}
