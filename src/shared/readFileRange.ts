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

export type ReadFileTailResult = {
  content: string
  linesReturned: number
  hasMoreBefore: boolean
  totalLines: number
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

/** 从完整文本取末尾至多 N 行（文件内正序）；忽略末尾换行产生的空行 */
export function sliceFileTailLines(text: string, tail: number): ReadFileTailResult {
  const eol = detectTextEol(text)
  let lines = splitLines(text)
  // 文件以换行结尾时 split 会多出一个空串，不计入 tail 窗口
  if (lines.length > 0 && lines[lines.length - 1] === '' && /(?:\r\n|\n|\r)$/.test(text)) {
    lines = lines.slice(0, -1)
  }
  const totalLines = lines.length
  const n = Math.max(0, Math.floor(tail))
  if (n <= 0 || totalLines === 0) {
    return { content: '', linesReturned: 0, hasMoreBefore: totalLines > 0, totalLines }
  }
  const startIdx = Math.max(0, totalLines - n)
  const slice = lines.slice(startIdx)
  return {
    content: slice.join(eol),
    linesReturned: slice.length,
    hasMoreBefore: startIdx > 0,
    totalLines
  }
}

export function hasReadFileRange(input: ReadFileRangeInput & { tail?: number }): boolean {
  return input.offset !== undefined || input.limit !== undefined || input.tail !== undefined
}
