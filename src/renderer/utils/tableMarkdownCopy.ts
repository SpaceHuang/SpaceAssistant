function normalizeCellText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

/** 将渲染后的 HTML 表格转换为可直接粘贴的 GFM Markdown 表格。 */
export function tableToMarkdown(table: HTMLTableElement): string | null {
  const rows = Array.from(table.rows)
    .map((row) => Array.from(row.cells).map((cell) => normalizeCellText(cell.textContent ?? '')))
    .filter((cells) => cells.length > 0)

  if (rows.length === 0) return null

  const columnCount = Math.max(...rows.map((cells) => cells.length))
  const paddedRows = rows.map((cells) => [...cells, ...Array(columnCount - cells.length).fill('')])
  const formatRow = (cells: string[]) => `| ${cells.join(' | ')} |`
  const divider = formatRow(Array(columnCount).fill('---'))

  return [formatRow(paddedRows[0]), divider, ...paddedRows.slice(1).map(formatRow)].join('\n')
}
