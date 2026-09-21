import path from 'node:path'

export type MarkdownExportFormat = 'docx' | 'pdf'

export type MarkdownExportRequest = {
  format: MarkdownExportFormat
  markdown: string
  sourcePath: string
}

export type MarkdownExportResult =
  | { ok: true; path: string; warnings?: string[] }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; error: string }

export function isMarkdownExportFormat(value: unknown): value is MarkdownExportFormat {
  return value === 'docx' || value === 'pdf'
}

export function isMarkdownExportablePath(sourcePath: string): boolean {
  return path.extname(sourcePath).toLowerCase() === '.md'
}

export function markdownExportExtension(format: MarkdownExportFormat): string {
  return `.${format}`
}

export function defaultMarkdownExportPath(sourcePath: string, format: MarkdownExportFormat): string {
  const parsed = path.parse(sourcePath)
  return path.join(parsed.dir, `${parsed.name}${markdownExportExtension(format)}`)
}

/** 将用户在保存框中选择的候选路径规范化为实际格式扩展名。 */
export function normalizeMarkdownExportPath(candidatePath: string, format: MarkdownExportFormat): string {
  const parsed = path.parse(candidatePath)
  const extension = markdownExportExtension(format)
  return path.join(parsed.dir, `${parsed.name}${extension}`)
}
