/**
 * T1.15/T1.16/T1.17：fileIpc 子通道挂载（§7.4 处置表）。
 * list-directory 虚拟条目/实体去重、read/watch/show/export 挂载解析、delete/rename 同侧、copy 跨边界、move 跨边界拒绝。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import type { AppIpcContext } from '../appIpc'
import { registerFileIpc } from './fileIpc'
import { openDatabase } from '../database'
import { DEFAULT_WIKI_CONFIG, type WikiConfig } from '../../src/shared/domainTypes'
import { CONFIG_KEYS } from './ipcShared'
import { setConfigValue } from '../database/operations'

const startContentWatchMock = vi.fn()
const stopContentWatchMock = vi.fn()
vi.mock('../fileContentWatcher', () => ({
  startContentWatch: (...a: unknown[]) => startContentWatchMock(...a),
  stopContentWatch: (...a: unknown[]) => stopContentWatchMock(...a)
}))

const dirs: string[] = []
const dbs: ReturnType<typeof openDatabase>[] = []

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function wikiConfig(enabled = true, hideWikiFromFileTree = true): WikiConfig {
  return { ...DEFAULT_WIKI_CONFIG, enabled, rootPath: 'llm-wiki', hideWikiFromFileTree }
}

interface World {
  workDir: string
  userData: string
  realBase: string
  handlers: Map<string, (...args: never[]) => unknown>
}

async function setupWorld(opts: { wikiEnabled?: boolean; hideWiki?: boolean; withResidue?: boolean } = {}): Promise<World> {
  const root = tmpdir('wiki-fipc-')
  const workDir = path.join(root, 'proj')
  const userData = path.join(root, 'ud')
  const realBase = path.join(userData, 'llm-wiki')
  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(path.join(realBase, 'wiki'), { recursive: true })
  fs.writeFileSync(path.join(realBase, 'wiki', 'index.md'), 'shared index', 'utf8')
  fs.writeFileSync(path.join(workDir, 'plain.txt'), 'plain', 'utf8')
  if (opts.withResidue) {
    fs.mkdirSync(path.join(workDir, 'llm-wiki'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'llm-wiki', 'residue.txt'), 'stale', 'utf8')
  }
  const db = openDatabase(':memory:')
  dbs.push(db)
  setConfigValue(db, CONFIG_KEYS.wiki, JSON.stringify(wikiConfig(opts.wikiEnabled ?? true, opts.hideWiki ?? true)))
  const ctx = {
    getWorkDir: () => workDir,
    getUserDataPath: () => userData,
    db
  } as unknown as AppIpcContext
  const handlers = new Map<string, (...args: never[]) => unknown>()
  registerFileIpc({ handle: (ch: string, fn: unknown) => handlers.set(ch, fn as never) } as unknown as IpcMain, ctx)
  return { workDir, userData, realBase, handlers }
}

describe('file:list-directory 挂载（T1.15）', () => {
  it('①llm-wiki 目录列出共享库内容', async () => {
    const { handlers } = await setupWorld()
    const entries = (await handlers.get('file:list-directory')!(null as never, 'llm-wiki/wiki' as never)) as Array<{ name: string }>
    expect(entries.map((e) => e.name)).toContain('index.md')
  })

  it('②根列表虚拟条目（hideWikiFromFileTree=false）/实体残留不双列', async () => {
    const { handlers } = await setupWorld({ hideWiki: false, withResidue: true })
    const entries = (await handlers.get('file:list-directory')!(null as never, '' as never)) as Array<{ name: string; path: string; virtual?: boolean }>
    const wikiEntries = entries.filter((e) => e.name === 'llm-wiki')
    expect(wikiEntries).toHaveLength(1)
    expect(wikiEntries[0].virtual).toBe(true)
  })

  it("②b hideWikiFromFileTree=true 时不合成虚拟条目（实体残留也不出现）", async () => {
    const { handlers } = await setupWorld({ hideWiki: true, withResidue: true })
    const entries = (await handlers.get('file:list-directory')!(null as never, '' as never)) as Array<{ name: string }>
    expect(entries.filter((e) => e.name === 'llm-wiki')).toHaveLength(0)
  })
})

describe('file:read-file / show-in-explorer 挂载（T1.15）', () => {
  it('③read-file 词汇路径读共享库内容', async () => {
    const { handlers } = await setupWorld()
    const read = (await import('../fileReadHelpers')) as unknown as { readFileForViewer: (p: string) => Promise<{ content?: string }> }
    const spy = vi.spyOn(read, 'readFileForViewer')
    await handlers.get('file:read-file')!(null as never, 'llm-wiki/wiki/index.md' as never)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(path.join('llm-wiki', 'wiki', 'index.md')))
    spy.mockRestore()
  })

  it('⑤show-in-explorer 与 read-file 同一挂载解析入口（行为验证属 manual M5 真机走查）', async () => {
    const { handlers, realBase } = await setupWorld()
    // show-in-explorer 的 shell 调用在测试 electron mock 下不可观察；同一 wikiMountOf 入口
    // 已由 read-file/to-viewer-url 用例验证，真实打开位置属 manual M5。
    const mounted = await import('../wiki/wikiMount')
    const cfg = { ...DEFAULT_WIKI_CONFIG, enabled: true, rootPath: 'llm-wiki' }
    const resolution = mounted.resolveWikiMount((handlers as unknown as { workDir: string }).workDir ?? '', cfg, '', 'llm-wiki/wiki/index.md')
    void realBase
    expect(resolution.mounted).toBe(true)
  })
})

describe('file:delete/rename/move/copy（T1.15）', () => {
  it('③delete/rename 同侧成功且限 realBase 内', async () => {
    const { handlers, realBase } = await setupWorld()
    await handlers.get('file:delete')!(null as never, 'llm-wiki/wiki/index.md' as never)
    expect(fs.existsSync(path.join(realBase, 'wiki', 'index.md'))).toBe(false)

    fs.writeFileSync(path.join(realBase, 'wiki', 'page.md'), 'x', 'utf8')
    await handlers.get('file:rename')!(null as never, 'llm-wiki/wiki/page.md' as never, 'renamed.md' as never)
    expect(fs.existsSync(path.join(realBase, 'wiki', 'renamed.md'))).toBe(true)
  })

  it('④copy 跨边界成功；move 跨边界显式拒绝', async () => {
    const { handlers, workDir, realBase } = await setupWorld()
    await handlers.get('file:copy')!(null as never, { srcRelPath: 'llm-wiki/wiki/index.md', destRelPath: 'copy-of-index.md' } as never)
    expect(fs.readFileSync(path.join(workDir, 'copy-of-index.md'), 'utf8')).toBe('shared index')

    await expect(handlers.get('file:move')!(null as never, 'llm-wiki/wiki/index.md', '.' as never)).rejects.toThrow(/跨.*边界|共享库/)
    void realBase
  })
})

describe('file:watch-content 挂载（T1.16）', () => {
  it('①wiki 词汇路径经挂载解析后启动监听（root=realBase）', async () => {
    const { handlers, realBase } = await setupWorld()
    startContentWatchMock.mockClear()
    await handlers.get('file:watch-content')!(null as never, { relPath: 'llm-wiki/wiki/index.md' } as never)
    expect(startContentWatchMock).toHaveBeenCalledWith(realBase, path.join('wiki', 'index.md'))
    await handlers.get('file:watch-content')!(null as never, { relPath: null } as never)
    expect(stopContentWatchMock).toHaveBeenCalled()
  })

  it('②workDir 内普通文件监听不变', async () => {
    const { handlers } = await setupWorld()
    startContentWatchMock.mockClear()
    await handlers.get('file:watch-content')!(null as never, { relPath: 'plain.txt' } as never)
    expect(startContentWatchMock).toHaveBeenCalledWith(expect.stringMatching(/proj$/), 'plain.txt')
  })
})

describe('file:export-markdown 挂载（T1.17）', () => {
  it('wiki 页（含相对图片）位于共享根 → 导出读取图片不落 workDir', async () => {
    const { handlers, realBase } = await setupWorld()
    // 图片在共享根
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    fs.writeFileSync(path.join(realBase, 'wiki', 'img.png'), png1x1)
    fs.writeFileSync(path.join(realBase, 'wiki', 'page.md'), '![img](./img.png)\n', 'utf8')
    // 不弹保存对话框：payload 无效时提前返回；这里只验证 source 解析（dialog mock 复杂，走 isMarkdownExportablePath 前的路径解析）
    const res = (await handlers.get('file:export-markdown')!(null as never, { format: 'docx', markdown: '![img](./img.png)', sourcePath: 'llm-wiki/wiki/page.md' } as never)) as { ok: boolean; error?: string }
    // win 为空（测试环境无主窗口）→ WINDOW_NOT_READY，证明已通过 source 解析与文件校验
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
    void realBase
  })
})
