/**
 * 将 ASCII / Unicode 框线表格转为 GFM 管道表格，供 remark-gfm 渲染。
 * 不处理围栏代码块内的内容（保留架构图等）。
 */

const BOX_BORDER_LINE = /^[\s|│+┌┐└┘├┤┬┴┼─═\-]*$/
const CELL_SPLIT = /[|│]/

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!/[|│]/.test(trimmed)) return null

  const inner = trimmed.replace(/^[|│]\s*/, '').replace(/\s*[|│]\s*$/, '')
  if (!inner) return null

  const cells = inner.split(CELL_SPLIT).map((c) => c.trim())
  if (cells.length < 2) return null

  const isDashCell = (c: string) => /^:?-{2,}:?$/.test(c) || /^-+$/.test(c.replace(/\s/g, ''))
  if (cells.every(isDashCell)) return null

  const hasContent = cells.some((c) => /[\p{L}\p{N}]/u.test(c))
  if (!hasContent) return null

  return cells
}

function isTableBorderLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (BOX_BORDER_LINE.test(t) && /[|│+┌┐└┘├┤┬┴┼─]/.test(t)) return true
  const row = parseTableRow(line)
  if (row == null && /[|│]/.test(t)) {
    const inner = t.replace(/^[|│]\s*/, '').replace(/\s*[|│]\s*$/, '')
    const cells = inner.split(CELL_SPLIT).map((c) => c.trim())
    return cells.length >= 2 && cells.every((c) => /^[\s\-:]+$/.test(c) && c.includes('-'))
  }
  return false
}

function isTableLine(line: string): boolean {
  return isTableBorderLine(line) || parseTableRow(line) != null
}

function toGfmTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const header = rows[0]
  const body = rows.slice(1)
  const fmt = (cells: string[]) => `| ${cells.join(' | ')} |`
  const sep = `| ${header.map(() => '---').join(' | ')} |`
  return [fmt(header), sep, ...body.map(fmt)].join('\n')
}

function isGfmSeparatorLine(line: string): boolean {
  const t = line.trim()
  if (!/[|│]/.test(t)) return false
  const inner = t.replace(/^[|│]\s*/, '').replace(/\s*[|│]\s*$/, '')
  const cells = inner.split(CELL_SPLIT).map((c) => c.trim())
  return cells.length >= 2 && cells.every((c) => /^:?-{3,}:?$/.test(c) && c.length <= 12)
}

function isAlreadyGfmTable(block: string[]): boolean {
  return block.some(isGfmSeparatorLine)
}

function extractDataRows(block: string[]): string[][] {
  const rows: string[][] = []
  for (const line of block) {
    const parsed = parseTableRow(line)
    if (parsed) rows.push(parsed)
  }
  return rows
}

function convertTableBlock(block: string[]): string[] | null {
  if (isAlreadyGfmTable(block)) return null
  const dataRows = extractDataRows(block)
  if (dataRows.length < 2) return null
  return toGfmTable(dataRows).split('\n')
}

function stripCommonIndent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l.trim())
    .map((l) => l.match(/^(\s*)/)?.[1].length ?? 0)
  const min = indents.length ? Math.min(...indents) : 0
  if (min < 4) return lines
  return lines.map((l) => (l.trim() ? l.slice(min) : l))
}

function processSegment(lines: string[]): string[] {
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!isTableLine(line)) {
      out.push(line)
      i++
      continue
    }

    const block: string[] = []
    while (i < lines.length && (isTableLine(lines[i]) || (lines[i].trim() === '' && i + 1 < lines.length && isTableLine(lines[i + 1])))) {
      if (lines[i].trim() !== '') block.push(lines[i])
      i++
    }

    const normalizedBlock = stripCommonIndent(block)
    const converted = convertTableBlock(normalizedBlock)
    if (converted) {
      out.push(...converted)
    } else {
      out.push(...block)
    }
  }

  return out
}

/** 在 Markdown 渲染前，将 ASCII / 框线表格块转为 GFM 表格 */
export function normalizeAsciiTables(content: string): string {
  const lines = content.split(/\r?\n/)
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const fence = lines[i].match(/^(\s*)(```|~~~)/)
    if (fence) {
      const marker = fence[2]
      result.push(lines[i])
      i++
      while (i < lines.length) {
        result.push(lines[i])
        if (lines[i].match(new RegExp(`^\\s*${marker}\\s*$`))) {
          i++
          break
        }
        i++
      }
      continue
    }

    const segmentEnd = lines.findIndex((_, idx) => idx >= i && /^\s*(```|~~~)/.test(lines[idx]))
    const segment = lines.slice(i, segmentEnd === -1 ? lines.length : segmentEnd)
    result.push(...processSegment(segment))
    i = segmentEnd === -1 ? lines.length : segmentEnd
  }

  return result.join('\n')
}
