import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { atomicWrite, buildMarkdownDocx, markdownResourceUrls, markdownToPrintHtml, sameFileIdentity } from './markdownExport'

const execFileAsync = promisify(execFile)

describe('markdown export generators', () => {
  it('creates safe print HTML without executing raw markup', async () => {
    const html = await markdownToPrintHtml('# **重要**说明\n\n<script>alert(1)</script>\n\n- [链接](https://example.com)')
    expect(html).toContain('<h1><strong>重要</strong>说明</h1>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<strong>重要</strong>')
    expect(html).toContain('href="https://example.com"')
  })

  it('creates a readable OOXML docx containing markdown text', async () => {
    const buffer = await buildMarkdownDocx('# 标题\n\n**中文正文**\n\n- 第一项\n- [x] 已完成\n\n[链接](https://example.com)')
    expect(buffer.subarray(0, 2).toString()).toBe('PK')
    expect(buffer.length).toBeGreaterThan(500)
    const dir = await mkdtemp(path.join(tmpdir(), 'markdown-docx-'))
    const file = path.join(dir, 'result.docx')
    await writeFile(file, buffer)
    const { stdout } = await execFileAsync('unzip', ['-p', file, 'word/document.xml'])
    expect(stdout).toContain('中文正文')
    expect(stdout).toContain('第一项')
    expect(stdout).toContain('已完成')
    expect(stdout).toContain('链接')
    const { stdout: rels } = await execFileAsync('unzip', ['-p', file, 'word/_rels/document.xml.rels'])
    expect(rels).toContain('https://example.com')
    await rm(dir, { recursive: true, force: true })
  })

  it('preserves markdown hard breaks as OOXML line breaks', async () => {
    const buffer = await buildMarkdownDocx('第一行  \n第二行')
    const dir = await mkdtemp(path.join(tmpdir(), 'markdown-hard-break-'))
    const file = path.join(dir, 'result.docx')
    await writeFile(file, buffer)
    const { stdout } = await execFileAsync('unzip', ['-p', file, 'word/document.xml'])
    expect(stdout).toContain('第一行')
    expect(stdout).toContain('<w:br/>')
    expect(stdout).toContain('第二行')
    await rm(dir, { recursive: true, force: true })
  })

  it('extracts image resources without fetching them', () => {
    expect(markdownResourceUrls('![a](images/a.png) ![b](https://example.com/b.png)')).toEqual(['images/a.png', 'https://example.com/b.png'])
    expect(markdownResourceUrls('![space](<images/my image.png>) ![encoded](images/my%20image.png)')).toEqual(['images/my image.png', 'images/my%20image.png'])
    expect(markdownResourceUrls('![logo][logo]\n\n[logo]: images/logo.png')).toEqual(['images/logo.png'])
  })

  it('preserves reference link targets and tolerates malformed image URLs', async () => {
    const buffer = await buildMarkdownDocx('[文档][doc]\n\n![图][img]\n\n[doc]: https://example.com/doc\n[img]: bad%ZZ.png')
    expect(buffer.subarray(0, 2).toString()).toBe('PK')
  })

  it('preserves block structures inside list items', async () => {
    const buffer = await buildMarkdownDocx('- 项目\n\n  ```ts\n  const value = 1\n  ```\n\n  | A | B |\n  |---|---|\n  | 1 | 2 |')
    const dir = await mkdtemp(path.join(tmpdir(), 'markdown-list-blocks-'))
    const file = path.join(dir, 'result.docx')
    await writeFile(file, buffer)
    const { stdout } = await execFileAsync('unzip', ['-p', file, 'word/document.xml'])
    expect(stdout).toContain('const value = 1')
    expect(stdout).toContain('<w:tbl>')
    await rm(dir, { recursive: true, force: true })
  })

  it('embeds validated image bytes in print HTML', async () => {
    const html = await markdownToPrintHtml('![logo](logo.png)', new Map([['logo.png', { data: Buffer.from('png'), mime: 'image/png' }]]))
    expect(html).toContain('src="data:image/png;base64,cG5n"')
  })

  it('preserves GFM task state as readable text', async () => {
    const html = await markdownToPrintHtml('- [x] 已完成\n- [ ] 待办')
    expect(html).toContain('checked disabled')
    expect(html).toContain('> 待办</li>')
  })

  it('keeps semantic status emoji visible in print HTML', async () => {
    const html = await markdownToPrintHtml('✅ 已完成 ⚠️ 注意 ❌ 失败')
    expect(html).toContain('✅')
    expect(html).toContain('⚠️')
    expect(html).toContain('❌')
    expect(html).not.toContain('sa-md-status-dot:')
  })

  it('detects hard-link identity and atomically replaces a target', async () => {
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 })).toBe(true)
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 })).toBe(false)
    const dir = await mkdtemp(path.join(tmpdir(), 'markdown-atomic-'))
    const file = path.join(dir, 'out.pdf')
    await writeFile(file, 'old')
    await atomicWrite(file, Buffer.from('new'))
    expect(await (await import('node:fs/promises')).readFile(file, 'utf8')).toBe('new')
    expect((await (await import('node:fs/promises')).readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
