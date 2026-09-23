import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { defaultMarkdownExportPath, isMarkdownExportFormat, normalizeMarkdownExportPath } from './markdownExport'

describe('markdown export contract', () => {
  it('derives defaults from the source filename, including multi-dot and unicode names', () => {
    expect(defaultMarkdownExportPath(path.join('/docs', '方案.v2.md'), 'docx')).toBe(path.join('/docs', '方案.v2.docx'))
    expect(defaultMarkdownExportPath(path.join('/docs', 'readme'), 'pdf')).toBe(path.join('/docs', 'readme.pdf'))
  })

  it('normalizes the final destination after the save dialog', () => {
    expect(normalizeMarkdownExportPath(path.join('/out', 'result.txt'), 'pdf')).toBe(path.join('/out', 'result.pdf'))
    expect(normalizeMarkdownExportPath(path.join('/out', 'result.PDF'), 'pdf')).toBe(path.join('/out', 'result.pdf'))
  })

  it('narrows format values', () => {
    expect(isMarkdownExportFormat('docx')).toBe(true)
    expect(isMarkdownExportFormat('html')).toBe(false)
  })
})
