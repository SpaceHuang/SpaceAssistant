import { describe, expect, it } from 'vitest'
import { defaultMarkdownExportPath, isMarkdownExportFormat, normalizeMarkdownExportPath } from './markdownExport'

describe('markdown export contract', () => {
  it('derives defaults from the source filename, including multi-dot and unicode names', () => {
    expect(defaultMarkdownExportPath('/docs/方案.v2.md', 'docx')).toBe('/docs/方案.v2.docx')
    expect(defaultMarkdownExportPath('/docs/readme', 'pdf')).toBe('/docs/readme.pdf')
  })

  it('normalizes the final destination after the save dialog', () => {
    expect(normalizeMarkdownExportPath('/out/result.txt', 'pdf')).toBe('/out/result.pdf')
    expect(normalizeMarkdownExportPath('/out/result.PDF', 'pdf')).toBe('/out/result.pdf')
  })

  it('narrows format values', () => {
    expect(isMarkdownExportFormat('docx')).toBe(true)
    expect(isMarkdownExportFormat('html')).toBe(false)
  })
})
