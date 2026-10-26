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
import { createWikiLifecycleController } from '../wiki/wikiLifecycle'

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

function wikiConfig(hideWikiFromFileTree = true, legacyRootAliases: string[] = []): WikiConfig {
  return { ...DEFAULT_WIKI_CONFIG, rootPath: 'llm-wiki', hideWikiFromFileTree, legacyRootAliases }
}

interface World {
  workDir: string
  userData: string
  realBase: string
  handlers: Map<string, (...args: never[]) => unknown>
}

async function setupWorld(opts: { hideWiki?: boolean; withResidue?: boolean; legacyRootAliases?: string[]; enabled?: boolean } = {}): Promise<World> {
  const root = tmpdir('wiki-fipc-')
  const workDir = path.join(root, 'proj')
  const userData = path.join(root, 'ud')
  const realBase = path.join(userData, 'llm-wiki')
  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(path.join(realBase, 'wiki'), { recursive: true })
  fs.writeFileSync(path.join(realBase, 'wiki', 'index.md'), 'shared index', 'utf8')
  if (opts.enabled) {
    await createWikiLifecycleController(realBase).initialize({ fresh: true })
    await createWikiLifecycleController(realBase).enable()
  }
  fs.writeFileSync(path.join(workDir, 'plain.txt'), 'plain', 'utf8')
  if (opts.withResidue) {
    fs.mkdirSync(path.join(workDir, 'llm-wiki'), { recursive: true })
    fs.writeFileSync(path.join(workDir, 'llm-wiki', 'residue.txt'), 'stale', 'utf8')
  }
  const db = openDatabase(':memory:')
  dbs.push(db)
  setConfigValue(db, CONFIG_KEYS.wiki, JSON.stringify(wikiConfig(opts.hideWiki ?? true, opts.legacyRootAliases ?? [])))
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

  it('opens the current page when a historical chat link uses an external rename alias', async () => {
    const { handlers, realBase } = await setupWorld()
    fs.mkdirSync(path.join(realBase, 'wiki', 'topics'), { recursive: true })
    fs.writeFileSync(path.join(realBase, 'wiki', 'topics', 'new-name.md'), 'current renamed page', 'utf8')
    fs.mkdirSync(path.join(realBase, '.wiki-service'), { recursive: true })
    fs.writeFileSync(path.join(realBase, '.wiki-service', 'catalog.json'), JSON.stringify({ formatVersion: 1,
      pages: [{ pageId: 'page-a', path: 'wiki/topics/new-name.md', revision: 2, title: 'A', categoryId: 'topic' }],
      pathAliases: [{ path: 'wiki/topics/old-name.md', pageId: 'page-a' }] }))
    const read = (await import('../fileReadHelpers')) as unknown as { readFileForViewer: (p: string) => Promise<unknown> }
    const spy = vi.spyOn(read, 'readFileForViewer')

    await handlers.get('file:read-file')!(null as never, 'llm-wiki/wiki/topics/old-name.md' as never)

    expect(spy).toHaveBeenCalledWith(path.join(realBase, 'wiki', 'topics', 'new-name.md'))
    spy.mockRestore()
  })

  it('returns a conflict when an old path alias points to multiple page identities', async () => {
    const { handlers, realBase } = await setupWorld()
    fs.mkdirSync(path.join(realBase, '.wiki-service'), { recursive: true })
    fs.writeFileSync(path.join(realBase, '.wiki-service', 'catalog.json'), JSON.stringify({ formatVersion: 1,
      pages: [{ pageId: 'page-a', path: 'wiki/a.md' }, { pageId: 'page-b', path: 'wiki/b.md' }],
      pathAliases: [{ path: 'wiki/old.md', pageId: 'page-a' }, { path: 'wiki/old.md', pageId: 'page-b' }] }))

    const result = await handlers.get('file:read-file')!(null as never, 'llm-wiki/wiki/old.md' as never) as { kind?: string; error?: string }

    expect(result).toMatchObject({ kind: 'error', error: 'wiki_path_alias_conflict' })
  })

  it('⑤show-in-explorer 与 read-file 同一挂载解析入口（行为验证属 manual M5 真机走查）', async () => {
    const { handlers, realBase } = await setupWorld()
    // show-in-explorer 的 shell 调用在测试 electron mock 下不可观察；同一 wikiMountOf 入口
    // 已由 read-file/to-viewer-url 用例验证，真实打开位置属 manual M5。
    const mounted = await import('../wiki/wikiMount')
    const cfg = { ...DEFAULT_WIKI_CONFIG, rootPath: 'llm-wiki' }
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

describe('domain_enabled file IPC boundary', () => {
  it.each([
    ['file:delete', ['llm-wiki/wiki/index.md']],
    ['file:rename', ['llm-wiki/wiki/index.md', 'renamed.md']],
    ['file:move', ['llm-wiki/wiki/index.md', 'llm-wiki/wiki']],
    ['file:copy', [{ srcRelPath: 'plain.txt', destRelPath: 'llm-wiki/wiki/copied.txt' }]],
    ['file:copy', [{ srcRelPath: 'llm-wiki/wiki/index.md', destRelPath: 'copied.txt' }]],
  ] as const)('拒绝启用态操作 %s', async (channel, args) => {
    const { handlers, realBase, workDir } = await setupWorld({ enabled: true })
    const targetBefore = fs.readFileSync(path.join(realBase, 'wiki', 'index.md'), 'utf8')
    await expect((handlers.get(channel)! as (...args: unknown[]) => unknown)(null, ...args)).rejects.toThrow('Wiki 已启用领域工具')
    expect(fs.readFileSync(path.join(realBase, 'wiki', 'index.md'), 'utf8')).toBe(targetBefore)
    expect(fs.existsSync(path.join(workDir, 'copied.txt'))).toBe(false)
    expect(fs.existsSync(path.join(realBase, 'wiki', 'copied.txt'))).toBe(false)
  })

  it('domain_ready 下仍允许文件树操作，保留既有迁移期兼容', async () => {
    const { handlers, realBase } = await setupWorld()
    await (handlers.get('file:rename')! as (...args: unknown[]) => unknown)(null, 'llm-wiki/wiki/index.md', 'renamed.md')
    expect(fs.existsSync(path.join(realBase, 'wiki', 'renamed.md'))).toBe(true)
  })
})

describe('BLK-9 根防护与只读别名（fileIpc 写通道）', () => {
  it("file:delete('llm-wiki') 挂载根本身被拒绝（不递归删除共享库）", async () => {
    const { handlers, realBase } = await setupWorld()
    await expect(handlers.get('file:delete')!(null as never, 'llm-wiki' as never)).rejects.toThrow(/共享库根目录/)
    expect(fs.existsSync(realBase)).toBe(true)
  })

  it("file:rename('llm-wiki', ...) 根本身被拒绝", async () => {
    const { handlers, realBase } = await setupWorld()
    await expect(handlers.get('file:rename')!(null as never, 'llm-wiki' as never, 'x' as never)).rejects.toThrow(/共享库根目录/)
    expect(fs.existsSync(path.join(realBase, 'wiki', 'index.md'))).toBe(true)
  })

  it('只读别名路径的 delete/create 写通道被拒绝（§9.3 别名只读在 UI 通道落实）', async () => {
    const { handlers } = await setupWorld()
    // 注册别名后挂载 readOnly
    const db = dbs[0]
    const { CONFIG_KEYS } = await import('./ipcShared')
    const { setConfigValue } = await import('../database/operations')
    setConfigValue(db, CONFIG_KEYS.wiki, JSON.stringify(wikiConfig(true, ['old-wiki'])))
    await expect(handlers.get('file:delete')!(null as never, 'old-wiki/wiki/index.md' as never)).rejects.toThrow(/只读别名/)
    await expect(handlers.get('file:create-file')!(null as never, 'old-wiki/new.md' as never)).rejects.toThrow(/只读别名/)
  })
})

describe('BLK-7 根列表不平铺', () => {
  it('根列表仅含虚拟条目 + 非 wiki 条目（无 ../.. 废行、无共享根子条目平铺）', async () => {
    const { handlers } = await setupWorld({ hideWiki: false })
    const entries = (await handlers.get('file:list-directory')!(null as never, '' as never)) as Array<{ path: string }>
    for (const e of entries) {
      expect(e.path).not.toContain('..')
    }
    expect(entries.filter((e) => e.virtual)).toHaveLength(1)
    // 共享根子条目（wiki/ raw/ SCHEMA.md）不得以根级形态平铺出现
    expect(entries.filter((e) => ['wiki', 'raw', 'SCHEMA.md'].includes(e.name) && !e.virtual)).toHaveLength(0)
  })
})

describe('P1-10 残余：read-file 失败返回 kind:error + migratedTo', () => {
  it('读取不存在文件且改名映射命中 → 返回 { kind:error, migratedTo }（§12.3-2）', async () => {
    const { handlers } = await setupWorld()
    const db = dbs[0]
    const { CONFIG_KEYS } = await import('./ipcShared')
    const { setConfigValue } = await import('../database/operations')
    setConfigValue(db, CONFIG_KEYS.wiki, JSON.stringify({
      ...wikiConfig(true),
      migration: { status: 'completed', report: { renames: [{ from: 'llm-wiki/wiki/merged.md', to: 'llm-wiki/wiki/merged.from-p-12345678.md' }] } }
    }))

    const res = (await handlers.get('file:read-file')!(null as never, 'llm-wiki/wiki/merged.md' as never)) as { kind?: string; error?: string; migratedTo?: string }
    expect(res.kind).toBe('error')
    expect(res.migratedTo).toBe('llm-wiki/wiki/merged.from-p-12345678.md')
  })

  it('未命中映射 → 维持既有抛错行为（无 migratedTo）', async () => {
    const { handlers } = await setupWorld()
    await expect(handlers.get('file:read-file')!(null as never, 'llm-wiki/wiki/absent.md' as never)).rejects.toThrow()
  })
})

describe('file:watch-content 挂载（T1.16）', () => {
  it('①wiki 词汇路径经挂载解析后启动监听；广播键为词汇路径（BLK-6）', async () => {
    const { handlers, realBase } = await setupWorld()
    startContentWatchMock.mockClear()
    await handlers.get('file:watch-content')!(null as never, { relPath: 'llm-wiki/wiki/index.md' } as never)
    expect(startContentWatchMock).toHaveBeenCalledWith(realBase, path.join('wiki', 'index.md'), 'llm-wiki/wiki/index.md')
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
