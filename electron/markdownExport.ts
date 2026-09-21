import fs from 'node:fs/promises'
import path from 'node:path'
import { Document, HeadingLevel, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ImageRun, ExternalHyperlink } from 'docx'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'
import { normalizeAsciiTables } from '../src/shared/markdownAsciiTableNormalize'
import { normalizeMarkdownMath } from '../src/shared/markdownMathNormalize'
import { expandWikilinks } from '../src/shared/wikiMarkdown'
import { remarkSemanticStatusEmoji } from '../src/shared/markdownSemanticStatusEmoji'
import type { MarkdownExportFormat } from '../src/shared/markdownExport'

export const MAX_MARKDOWN_EXPORT_IMAGES = 64
export const MAX_MARKDOWN_EXPORT_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_MARKDOWN_EXPORT_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024
const safeDecode = (url: string) => { try { return decodeURIComponent(url) } catch { return url } }
const decodeHtmlAttribute = (value: string) => value.replace(/&amp;|&#x26;|&#38;/gi, '&')

function imageTransformation(data: Buffer): { width: number; height: number } {
  let width = 500
  let height = 300
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = data.readUInt32BE(16)
    height = data.readUInt32BE(20)
  } else if (data.length >= 10 && data.subarray(0, 3).toString() === 'GIF') {
    width = data.readUInt16LE(6)
    height = data.readUInt16LE(8)
  } else if (data.length >= 26 && data.subarray(0, 2).toString() === 'BM') {
    width = Math.abs(data.readInt32LE(18))
    height = Math.abs(data.readInt32LE(22))
  } else if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue }
      const marker = data[offset + 1]
      const length = data.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xc3) {
        height = data.readUInt16BE(offset + 5)
        width = data.readUInt16BE(offset + 7)
        break
      }
      offset += 2 + length
    }
  }
  const scale = Math.min(500 / width, 300 / height, 1)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export async function markdownToPrintHtml(markdown: string, images: Map<string, { data: Buffer; mime: string }> = new Map()): Promise<string> {
  const source = expandWikilinks(normalizeMarkdownMath(normalizeAsciiTables(markdown)), 'llm-wiki')
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkSemanticStatusEmoji).use(remarkMath).use(remarkRehype).use(rehypeKatex).use(rehypeStringify)
  let html = String(await processor.process(source))
  html = html.replace(/<a href="sa-md-status-dot:(success|warning|error|neutral)">\u200b<\/a>/g, (_match, tone) => ({ success: '✅', warning: '⚠️', error: '❌', neutral: '•' } as Record<string, string>)[tone])
  html = html.replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/gi, (_match, prefix, url, suffix) => {
    const decodedUrl = decodeHtmlAttribute(url)
    const image = images.get(url) ?? images.get(decodedUrl) ?? images.get(safeDecode(decodedUrl))
    return `${prefix}${image ? `data:${image.mime};base64,${image.data.toString('base64')}` : ''}${suffix}`
  })
  return html
}

export async function buildMarkdownDocx(markdown: string, images: Map<string, { data: Buffer; type: 'png' | 'jpg' | 'gif' | 'bmp' }> = new Map()): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as any
  const definitions = new Map<string, any>((tree.children ?? []).filter((node: any) => node.type === 'definition').map((node: any) => [node.identifier, node]))
  const text = (node: any): string => node.value ?? node.alt ?? (node.children ? node.children.map(text).join('') : '')
  const resolveUrl = (node: any) => node.type.endsWith('Reference') ? definitions.get(node.identifier)?.url : node.url
  const findImage = (url: string) => images.get(url) ?? images.get(safeDecode(url)) ?? images.get(encodeURI(url))
  const runs = (node: any, style: { bold?: boolean; italics?: boolean; strike?: boolean } = {}): any[] => (node.children ?? []).flatMap((child: any) => {
    if (child.type === 'break') return [new TextRun({ break: 1 })]
    const image = (child.type === 'image' || child.type === 'imageReference') ? findImage(resolveUrl(child) ?? '') : undefined
    if (image) return [new ImageRun({ data: image.data, type: image.type, transformation: imageTransformation(image.data) })]
    const nextStyle = { bold: style.bold || child.type === 'strong', italics: style.italics || child.type === 'emphasis', strike: style.strike || child.type === 'delete' }
    if (child.type === 'link' || child.type === 'linkReference') return [new ExternalHyperlink({ link: resolveUrl(child), children: runs({ ...child, children: child.children ?? [{ type: 'text', value: child.label ?? '' }] }, nextStyle) })]
    if (child.children) return runs(child, nextStyle)
    return [new TextRun({ text: child.value ?? child.alt ?? '', bold: nextStyle.bold, italics: nextStyle.italics, strike: nextStyle.strike })]
  })
  const numberingConfigs: any[] = []
  let listIndex = 0
  const codeParagraphs = (node: any) => [new Paragraph({ children: node.value.split('\n').flatMap((line: string, index: number) => index ? [new TextRun({ break: 1 }), new TextRun({ text: line, font: 'Courier New' })] : [new TextRun({ text: line, font: 'Courier New' })]) })]
  const tableBlock = (node: any) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: node.children.map((row: any) => new TableRow({ children: row.children.map((cell: any) => new TableCell({ children: [new Paragraph({ children: runs(cell) })] })) })) })
  const listBlockParagraphs = (block: any, prefix: string, list: any, level: number, numbered: { reference: string; level: number } | undefined, marker = false) => {
    if (block.type === 'blockquote') return block.children.flatMap((child: any, index: number) => child.type === 'list' ? renderList(child, level + 1) : listBlockParagraphs(child, index === 0 ? prefix : '', list, level, numbered && index === 0 ? numbered : undefined, marker && index === 0))
    if (block.type === 'code') return [new Paragraph({ children: [new TextRun({ text: prefix, bold: true })], bullet: !list.ordered && marker ? { level } : undefined, numbering: numbered ? { reference: numbered.reference, level: numbered.level } : undefined }), ...codeParagraphs(block)]
    if (block.type === 'table') return [new Paragraph({ children: [new TextRun({ text: prefix, bold: true })], bullet: !list.ordered && marker ? { level } : undefined, numbering: numbered ? { reference: numbered.reference, level } : undefined }), tableBlock(block)]
    return [new Paragraph({ children: runs({ ...block, children: [{ type: 'text', value: prefix }, ...(block.children ?? [])] }), bullet: !list.ordered && marker ? { level } : undefined, numbering: numbered ? { reference: numbered.reference, level: numbered.level } : undefined })]
  }
  const renderList = (list: any, level: number): any[] => {
    const reference = list.ordered ? `markdown-numbered-${listIndex++}` : undefined
    if (reference) numberingConfigs.push({ reference, levels: Array.from({ length: 9 }, (_, index) => ({ level: index, format: 'decimal', text: `%${index + 1}.`, alignment: 'left', start: list.start ?? 1 })) })
    return list.children.flatMap((item: any) => {
      const prefix = `${item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : ''}`
      let firstBlock = true
      const output = (item.children ?? []).flatMap((block: any) => {
        if (block.type === 'list') {
          const parentMarker = firstBlock
            ? [new Paragraph({ children: [new TextRun('')], bullet: !list.ordered ? { level } : undefined, numbering: reference ? { reference, level } : undefined })]
            : []
          firstBlock = false
          return [...parentMarker, ...renderList(block, level + 1)]
        }
        const result = listBlockParagraphs(block, firstBlock ? prefix : '', list, level, reference && firstBlock ? { reference, level } : undefined, firstBlock)
        firstBlock = false
        return result
      })
      return output.length ? output : [new Paragraph({ children: [new TextRun(prefix)], bullet: !list.ordered ? { level } : undefined, numbering: reference ? { reference, level } : undefined })]
    })
  }
  const renderQuote = (quote: any): any[] => quote.children.flatMap((block: any) => {
    if (block.type === 'blockquote') return renderQuote(block)
    if (block.type === 'list') return renderList(block, 0)
    if (block.type === 'code') return codeParagraphs(block)
    if (block.type === 'table') return [tableBlock(block)]
    return [new Paragraph({ children: runs(block) })]
  })
  const children = tree.children.flatMap((node: any) => {
    if (node.type === 'heading') return [new Paragraph({ heading: ([HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6] as const)[node.depth - 1], children: runs(node) })]
    if (node.type === 'code') return codeParagraphs(node)
    if (node.type === 'list') {
      return renderList(node, 0)
    }
    if (node.type === 'table') return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: node.children.map((row: any) => new TableRow({ children: row.children.map((cell: any) => new TableCell({ children: [new Paragraph({ children: runs(cell) })] })) })) })]
    if (node.type === 'thematicBreak') return [new Paragraph({ children: [new TextRun('────────────────')] })]
    if (node.type === 'blockquote') return renderQuote(node)
    return [new Paragraph({ children: runs(node).length ? runs(node) : [new TextRun(text(node))] })]
  })
  return Packer.toBuffer(new Document({
    numbering: { config: numberingConfigs },
    sections: [{ children }],
    title: markdown.match(/^#\s+(.+)$/m)?.[1] ?? 'Markdown document'
  }))
}

export async function atomicWrite(target: string, data: Buffer): Promise<void> {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try { await fs.writeFile(tmp, data, { flag: 'wx' }); await fs.rename(tmp, target) } catch (error) { await fs.rm(tmp, { force: true }); throw error }
}

export function sameFileIdentity(a: { dev?: number; ino?: number }, b: { dev?: number; ino?: number }): boolean {
  return typeof a.dev === 'number' && typeof a.ino === 'number' && a.dev === b.dev && a.ino === b.ino
}

export function isSupportedMarkdownExport(value: unknown): value is MarkdownExportFormat { return value === 'docx' || value === 'pdf' }

export function markdownResourceUrls(markdown: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as any
  const definitions = new Map<string, any>((tree.children ?? []).filter((node: any) => node.type === 'definition').map((node: any) => [node.identifier, node]))
  const urls: string[] = []
  const visit = (node: any) => {
    if (node.type === 'image' && typeof node.url === 'string') urls.push(node.url)
    if (node.type === 'imageReference') { const definition = definitions.get(node.identifier); if (definition?.url) urls.push(definition.url) }
    node.children?.forEach(visit)
  }
  tree.children.forEach(visit)
  return [...new Set(urls)]
}
