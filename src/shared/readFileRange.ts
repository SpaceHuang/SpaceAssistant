export type ReadFileRangeInput = {
  offset?: number
  limit?: number
}

export type ReadFileRangeResult = {
  content: string
  totalLines: number
  startLine: number
  endLine: number
  hasMore: boolean
}

/** 检测文本主换行符，用于分段读取时保持与源文件一致 */
export function detectTextEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function splitLines(text: string): string[] {
  if (detectTextEol(text) === '\r\n') return text.split('\r\n')
  return text.split(/\n|\r/)
}

/** 按 1-based 行号 offset 与 limit 截取文件文本 */
export function sliceFileLines(text: string, input: ReadFileRangeInput): ReadFileRangeResult {
  const eol = detectTextEol(text)
  const lines = splitLines(text)
  const totalLines = lines.length
  const offset = input.offset ?? 1
  const startIdx = Math.max(0, Math.floor(offset) - 1)

  if (startIdx >= totalLines) {
    return {
      content: '',
      totalLines,
      startLine: offset,
      endLine: Math.max(offset - 1, 0),
      hasMore: false
    }
  }

  const limit = input.limit
  const endIdx =
    limit !== undefined ? Math.min(startIdx + Math.floor(limit), totalLines) : totalLines
  const slice = lines.slice(startIdx, endIdx)

  return {
    content: slice.join(eol),
    totalLines,
    startLine: startIdx + 1,
    endLine: startIdx + slice.length,
    hasMore: endIdx < totalLines
  }
}

export function hasReadFileRange(input: ReadFileRangeInput): boolean {
  return input.offset !== undefined || input.limit !== undefined
}
