import { createHash } from 'crypto'
import { spawn } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import type { Dirent } from 'fs'
import { resolveSafePath, resolveSafePathReal } from '../pathSecurity'
import { isUnderWikiRaw } from '../wiki/wikiPaths'
import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'
import { sanitizeToolOutputText, toToolUserError } from './toolUserErrors'
import {
  combineUserAbortAndTimeout,
  outcomeFromFileToolSignal,
  throwIfAborted
} from './toolExecutionResource'
import { buildPythonScriptEnv, createStreamTextDecoder } from '../processOutputEncoding'
import { runLarkCliExecutor } from './runLarkCliExecutor'
import { readFeishuAttachmentExecutor } from './readFeishuAttachmentExecutor'
import { wechatReplyExecutor, wechatSendExecutor } from './wechatExecutors'
import { browserExecutor } from './browserExecutor'
import { browserDetectExecutor } from './browserDetectExecutor'
import { runShellExecutor } from './runShellExecutor'
import { listWorkDirsExecutor, switchWorkDirExecutor } from './workDirExecutors'
import { switchSessionExecutor } from './remoteSessionExecutors'
import { READ_FILE_MAX_CHARS } from '../../src/shared/toolResultLimits'
import { sliceFileLines } from '../../src/shared/readFileRange'
import type { FileState } from '../fileStateCache'

function recordReadFileCache(
  cache: ToolExecutionContext['fileStateCache'],
  abs: string,
  mtimeMs: number,
  opts: { content: string; truncated: boolean; rangeRequested: boolean }
): void {
  const prev = cache.get(abs)
  if (opts.rangeRequested) {
    if (prev && !prev.isPartial && !prev.isRangeView) {
      cache.set(abs, { ...prev, mtime: mtimeMs, readAt: Date.now() })
      return
    }
    cache.set(abs, {
      path: abs,
      content: '',
      mtime: mtimeMs,
      readAt: Date.now(),
      isPartial: opts.truncated,
      isRangeView: true
    })
    return
  }
  cache.set(abs, {
    path: abs,
    content: opts.content,
    mtime: mtimeMs,
    readAt: Date.now(),
    isPartial: opts.truncated,
    isRangeView: false
  })
}

async function assertDiskMatchesReadCache(
  abs: string,
  stCache: FileState,
  cur: string,
  op: AbortSignal,
  errorMessage: string
): Promise<ToolExecutorResult | null> {
  if (stCache.isRangeView) {
    throwIfAborted(op)
    let stNow: Awaited<ReturnType<typeof fs.stat>>
    try {
      stNow = await fs.stat(abs)
    } catch {
      return null
    }
    if (stNow.mtimeMs !== stCache.mtime) {
      return { success: false, error: errorMessage }
    }
    return null
  }
  if (cur !== stCache.content) {
    return { success: false, error: errorMessage }
  }
  return null
}

const READ_MAX = READ_FILE_MAX_CHARS
const GREP_FILE_MAX = 1024 * 1024
const SCRIPT_IO_MAX = 100 * 1024
const GREP_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '__pycache__',
  'dist',
  'dist-electron',
  '.cursor'
])

function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function backupIfEnabled(
  ctx: ToolExecutionContext,
  relPath: string,
  content: Buffer,
  op?: AbortSignal
): Promise<void> {
  if (!ctx.toolsConfig.fileCheckpointingEnabled) return
  const sessionDir = path.join(ctx.userDataDir, 'file-history', ctx.sessionId)
  await fs.mkdir(sessionDir, { recursive: true })
  const h = createHash('sha256').update(relPath.replace(/\\/g, '/')).digest('hex').slice(0, 20)
  let maxV = 0
  let entries: string[] = []
  try {
    entries = await fs.readdir(sessionDir)
  } catch {
    entries = []
  }
  const prefix = `${h}@v`
  for (const e of entries) {
    if (e.startsWith(prefix)) {
      const v = parseInt(e.slice(prefix.length), 10)
      if (!Number.isNaN(v)) maxV = Math.max(maxV, v)
    }
  }
  const nextV = maxV + 1
  const snap = path.join(sessionDir, `${prefix}${nextV}`)
  await fs.writeFile(snap, content, op ? { signal: op } : undefined)
  const maxKeep = ctx.toolsConfig.maxFileSnapshots
  const samePrefix = entries.filter((e) => e.startsWith(`${h}@v`)).sort()
  while (samePrefix.length > maxKeep) {
    const rm = samePrefix.shift()
    if (rm) await fs.unlink(path.join(sessionDir, rm)).catch(() => {})
  }
}

async function atomicWriteFile(target: string, body: string | Buffer, op?: AbortSignal): Promise<void> {
  if (op) throwIfAborted(op)
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
  try {
    await fs.writeFile(tmp, body, op ? { signal: op } : undefined)
    if (op) throwIfAborted(op)
    const fh = await fs.open(tmp, 'r+')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
    if (op) throwIfAborted(op)
    await fs.rename(tmp, target)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

function fileToolAbortResult(
  op: AbortSignal,
  timeoutMsg: string,
  started: number
): ToolExecutorResult | null {
  const o = outcomeFromFileToolSignal(op)
  if (o === 'timeout') return { success: false, error: timeoutMsg, duration: Date.now() - started }
  if (o === 'cancel') return { success: false, error: '用户取消执行', duration: Date.now() - started }
  return null
}

export const readFileExecutor: ToolExecutor = {
  name: 'read_file',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = typeof input.path === 'string' ? input.path : ''
    ctx.sendProgress('reading', '正在读取文件...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      let abs: string
      try {
        abs = await resolveSafePathReal(ctx.workDir, rel)
      } catch (e) {
        return { success: false, error: `路径超出工作目录范围: ${rel}`, duration: Date.now() - started }
      }
      if (!(await pathExists(abs))) {
        return { success: true, data: { path: rel, content: '', encoding: 'utf8', note: '文件不存在' }, duration: Date.now() - started }
      }
      let st: Awaited<ReturnType<typeof fs.stat>>
      try {
        st = await fs.stat(abs)
      } catch (e) {
        const ab = fileToolAbortResult(op, '读取超时，请检查文件路径或网络连接', started)
        if (ab) return ab
        throw e
      }
      if (st.isDirectory()) {
        return {
          success: false,
          error: `路径是目录而非文件: ${rel}。请使用 list_directory 查看目录内容，或指定具体文件路径`,
          duration: Date.now() - started
        }
      }
      if (!st.isFile()) {
        return { success: false, error: `无法读取该路径（不是普通文件）: ${rel}`, duration: Date.now() - started }
      }
      let buf: Buffer
      try {
        buf = await fs.readFile(abs, { signal: op })
      } catch (e) {
        const ab = fileToolAbortResult(op, '读取超时，请检查文件路径或网络连接', started)
        if (ab) return ab
        throw e
      }
      if (isBinaryBuffer(buf)) {
        return { success: false, error: '文件为二进制格式，无法读取', duration: Date.now() - started }
      }
      let text = buf.toString('utf8')
      let truncated = false
      if (text.length > READ_MAX) {
        text = text.slice(0, READ_MAX)
        truncated = true
      }

      const offsetRaw = input.offset
      const limitRaw = input.limit
      const rangeRequested =
        (offsetRaw !== undefined && offsetRaw !== null) || (limitRaw !== undefined && limitRaw !== null)
      let rangeMeta: {
        totalLines: number
        startLine: number
        endLine: number
        hasMore: boolean
      } | undefined

      if (rangeRequested) {
        const offset =
          offsetRaw !== undefined && offsetRaw !== null && typeof offsetRaw === 'number' && Number.isFinite(offsetRaw)
            ? Math.max(1, Math.floor(offsetRaw))
            : 1
        const limit =
          limitRaw !== undefined && limitRaw !== null && typeof limitRaw === 'number' && Number.isFinite(limitRaw)
            ? Math.max(1, Math.floor(limitRaw))
            : undefined
        const sliced = sliceFileLines(text, { offset, limit })
        rangeMeta = {
          totalLines: sliced.totalLines,
          startLine: sliced.startLine,
          endLine: sliced.endLine,
          hasMore: sliced.hasMore
        }
        text = sliced.content
      }

      recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
        content: text,
        truncated,
        rangeRequested
      })
      return {
        success: true,
        data: {
          path: rel,
          content: text,
          encoding: 'utf8',
          ...(truncated ? { truncated: true, note: `内容超过 ${READ_MAX} 字符已截断` } : {}),
          ...(rangeMeta
            ? {
                totalLines: rangeMeta.totalLines,
                startLine: rangeMeta.startLine,
                endLine: rangeMeta.endLine,
                hasMore: rangeMeta.hasMore,
                ...(rangeMeta.hasMore
                  ? { note: `仅返回第 ${rangeMeta.startLine}–${rangeMeta.endLine} 行，共 ${rangeMeta.totalLines} 行；可增大 offset 继续读取` }
                  : {})
              }
            : {})
        },
        duration: Date.now() - started
      }
    } finally {
      dispose()
    }
  }
}

export const listDirectoryExecutor: ToolExecutor = {
  name: 'list_directory',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = typeof input.path === 'string' ? input.path : '.'
    ctx.sendProgress('listing', '正在读取目录...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      let target: string
      try {
        target = rel === '' || rel === '.' ? path.resolve(ctx.workDir) : await resolveSafePathReal(ctx.workDir, rel)
      } catch (e) {
        return { success: false, error: `路径超出工作目录范围: ${rel}`, duration: Date.now() - started }
      }
      let st: Awaited<ReturnType<typeof fs.stat>>
      try {
        st = await fs.stat(target)
      } catch (e) {
        const ab = fileToolAbortResult(op, '目录读取超时', started)
        if (ab) return ab
        return { success: false, error: `不是目录或无法访问: ${rel}`, duration: Date.now() - started }
      }
      if (!st.isDirectory()) {
        return { success: false, error: `不是目录或无法访问: ${rel}`, duration: Date.now() - started }
      }
      let entries: Dirent[]
      try {
        entries = await fs.readdir(target, { withFileTypes: true })
      } catch (e) {
        const ab = fileToolAbortResult(op, '目录读取超时', started)
        if (ab) return ab
        throw e
      }
      const root = path.resolve(ctx.workDir)
      const rows: Array<{ name: string; path: string; isDirectory: boolean; size?: number; mtimeMs?: number }> = []
      let i = 0
      for (const ent of entries) {
        if (++i % 25 === 0) throwIfAborted(op)
        const p = path.join(target, ent.name)
        let size: number | undefined
        let mtimeMs: number | undefined
        try {
          const s = await fs.stat(p)
          mtimeMs = s.mtimeMs
          if (ent.isFile()) size = s.size
        } catch (e) {
          const ab = fileToolAbortResult(op, '目录读取超时', started)
          if (ab) return ab
          /* skip entry */
        }
        rows.push({
          name: ent.name,
          path: path.relative(root, p) || '.',
          isDirectory: ent.isDirectory(),
          size,
          mtimeMs
        })
      }
      rows.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
      return { success: true, data: { entries: rows }, duration: Date.now() - started }
    } finally {
      dispose()
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return hay.length + 1
  let c = 0
  let i = 0
  while (i <= hay.length) {
    const j = hay.indexOf(needle, i)
    if (j < 0) break
    c++
    i = j + needle.length
  }
  return c
}

function applyEdit(content: string, oldS: string, newS: string, replaceAll: boolean): string {
  if (oldS === '') return newS
  if (replaceAll) return content.split(oldS).join(newS)
  const i = content.indexOf(oldS)
  if (i < 0) return content
  return content.slice(0, i) + newS + content.slice(i + oldS.length)
}

function normalizeLineEndingsForMatch(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function detectFileEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function applyEditWithEolTolerance(
  cur: string,
  oldS: string,
  newS: string,
  replaceAll: boolean
): string {
  const fileEol = detectFileEol(cur)
  const curNorm = normalizeLineEndingsForMatch(cur)
  const oldNorm = normalizeLineEndingsForMatch(oldS)
  const newNorm = normalizeLineEndingsForMatch(newS)
  const nextNorm = applyEdit(curNorm, oldNorm, newNorm, replaceAll)
  if (fileEol === '\r\n') return nextNorm.replace(/\n/g, '\r\n')
  return nextNorm
}

function countOccurrencesWithEolTolerance(hay: string, needle: string): number {
  return countOccurrences(normalizeLineEndingsForMatch(hay), normalizeLineEndingsForMatch(needle))
}

import { toolErrMissingPath } from '../toolInputGuards'

const ERR_FILE_NOT_READ_FOR_EDIT =
  '文件尚未在本会话中通过 read_file 读取，请先读取后再编辑'
const ERR_FILE_NOT_READ_FOR_WRITE =
  '文件尚未在本会话中通过 read_file 读取，请先读取后再写入'
const ERR_WIKI_RAW_READONLY = 'raw/ 为只读源，不可通过工具修改 (WIKI_RAW_READONLY)'

function wikiRawWriteBlocked(ctx: ToolExecutionContext, rel: string): ToolExecutorResult | null {
  if (!ctx.wikiConfig?.enabled) return null
  const normalized = rel.replace(/\\/g, '/')
  if (isUnderWikiRaw(ctx.workDir, ctx.wikiConfig, normalized)) {
    return { success: false, error: ERR_WIKI_RAW_READONLY }
  }
  return null
}

async function recordFileStateAfterWrite(
  cache: ToolExecutionContext['fileStateCache'],
  abs: string,
  content: string
): Promise<void> {
  const st = await fs.stat(abs)
  cache.set(abs, {
    path: abs,
    content,
    mtime: st.mtimeMs,
    readAt: Date.now(),
    isPartial: false
  })
}

export const editFileExecutor: ToolExecutor = {
  name: 'edit_file',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = typeof input.path === 'string' ? input.path : ''
    if (!rel.trim()) {
      return { success: false, error: toolErrMissingPath('edit_file'), duration: Date.now() - started }
    }
    const oldS = typeof input.old_string === 'string' ? input.old_string : ''
    const newS = typeof input.new_string === 'string' ? input.new_string : ''
    const replaceAll = Boolean(input.replace_all)
    const rawBlock = wikiRawWriteBlocked(ctx, rel)
    if (rawBlock) return { ...rawBlock, duration: Date.now() - started }
    ctx.sendProgress('editing', '正在编辑文件...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      let abs: string
      try {
        abs = await resolveSafePathReal(ctx.workDir, rel)
      } catch {
        return { success: false, error: `路径超出工作目录范围: ${rel}`, duration: Date.now() - started }
      }
      if (oldS === newS) {
        return { success: false, error: '新旧字符串相同，无需修改', duration: Date.now() - started }
      }
      const existed = await pathExists(abs)
      let stCache = existed ? ctx.fileStateCache.get(abs) : undefined
      if (existed) {
        if (!ctx.fileStateCache.hasBeenRead(abs)) {
          return { success: false, error: ERR_FILE_NOT_READ_FOR_EDIT, duration: Date.now() - started }
        }
        if (stCache?.isPartial) {
          return { success: false, error: '文件内容被截断，请完整读取后再进行修改', duration: Date.now() - started }
        }
      }
      let cur = ''
      if (existed) {
        try {
          cur = await fs.readFile(abs, { encoding: 'utf8', signal: op })
        } catch (e) {
          const ab = fileToolAbortResult(op, '编辑超时', started)
          if (ab) return ab
          throw e
        }
      }
      if (existed && stCache) {
        const mismatch = await assertDiskMatchesReadCache(
          abs,
          stCache,
          cur,
          op,
          '文件已被外部程序修改，请重新读取后再编辑'
        )
        if (mismatch) return { ...mismatch, duration: Date.now() - started }
      }
      const occ = countOccurrencesWithEolTolerance(cur, oldS)
      if (occ === 0 && oldS !== '') {
        return { success: false, error: '未找到待替换的字符串', duration: Date.now() - started }
      }
      if (!replaceAll && oldS !== '' && occ > 1) {
        return { success: false, error: '找到多个匹配，请提供更精确的上下文或使用 replace_all', duration: Date.now() - started }
      }
      const next = applyEditWithEolTolerance(cur, oldS, newS, replaceAll)
      throwIfAborted(op)
      if (existed && ctx.toolsConfig.fileCheckpointingEnabled) {
        try {
          await backupIfEnabled(ctx, rel.replace(/\\/g, '/'), Buffer.from(cur, 'utf8'), op)
        } catch (e) {
          const ab = fileToolAbortResult(op, '编辑超时', started)
          if (ab) return ab
          throw e
        }
      }
      throwIfAborted(op)
      try {
        await atomicWriteFile(abs, next, op)
      } catch (e) {
        const ab = fileToolAbortResult(op, '编辑超时', started)
        if (ab) return ab
        throw e
      }
      await recordFileStateAfterWrite(ctx.fileStateCache, abs, next)
      return {
        success: true,
        data: { path: rel, bytesWritten: Buffer.byteLength(next, 'utf8') },
        duration: Date.now() - started
      }
    } finally {
      dispose()
    }
  }
}

export const writeFileExecutor: ToolExecutor = {
  name: 'write_file',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = typeof input.path === 'string' ? input.path : ''
    if (!rel.trim()) {
      return { success: false, error: toolErrMissingPath('write_file'), duration: Date.now() - started }
    }
    const content = typeof input.content === 'string' ? input.content : ''
    const rawBlock = wikiRawWriteBlocked(ctx, rel)
    if (rawBlock) return { ...rawBlock, duration: Date.now() - started }
    ctx.sendProgress('writing', '正在写入文件...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      let abs: string
      try {
        abs = await resolveSafePathReal(ctx.workDir, rel)
      } catch {
        return { success: false, error: `路径超出工作目录范围: ${rel}`, duration: Date.now() - started }
      }
      const existed = await pathExists(abs)
      const body = content.replace(/\r\n/g, '\n')
      if (existed) {
        if (!ctx.fileStateCache.hasBeenRead(abs)) {
          return { success: false, error: ERR_FILE_NOT_READ_FOR_WRITE, duration: Date.now() - started }
        }
        const stCache = ctx.fileStateCache.get(abs)
        if (stCache?.isPartial) {
          return { success: false, error: '文件内容被截断，请完整读取后再进行修改', duration: Date.now() - started }
        }
        let cur: string
        try {
          cur = await fs.readFile(abs, { encoding: 'utf8', signal: op })
        } catch (e) {
          const ab = fileToolAbortResult(op, '写入超时', started)
          if (ab) return ab
          throw e
        }
        if (stCache) {
          const mismatch = await assertDiskMatchesReadCache(
            abs,
            stCache,
            cur,
            op,
            '文件已被外部程序修改，请重新读取后再写入'
          )
          if (mismatch) return { ...mismatch, duration: Date.now() - started }
        }
        throwIfAborted(op)
        if (ctx.toolsConfig.fileCheckpointingEnabled) {
          try {
            await backupIfEnabled(ctx, rel.replace(/\\/g, '/'), Buffer.from(cur, 'utf8'), op)
          } catch (e) {
            const ab = fileToolAbortResult(op, '写入超时', started)
            if (ab) return ab
            throw e
          }
        }
      }
      throwIfAborted(op)
      try {
        await atomicWriteFile(abs, body, op)
      } catch (e) {
        const ab = fileToolAbortResult(op, '写入超时', started)
        if (ab) return ab
        throw e
      }
      await recordFileStateAfterWrite(ctx.fileStateCache, abs, body)
      return { success: true, data: { path: rel }, duration: Date.now() - started }
    } finally {
      dispose()
    }
  }
}

async function grepWithRg(
  workDir: string,
  searchPath: string,
  pattern: string,
  args: {
    glob?: string
    outputMode: string
    ignoreCase: boolean
    showLineNumber: boolean
    context?: number
    multiline: boolean
    headLimit: number
  },
  timeoutMs: number,
  signal: AbortSignal,
  onProgress: (msg: string) => void
): Promise<string | null> {
  const rgArgs = ['--color', 'never', '--regexp', pattern]
  if (args.ignoreCase) rgArgs.push('-i')
  if (args.glob) {
    rgArgs.push('--glob', args.glob)
  }
  if (args.outputMode === 'files_with_matches') rgArgs.push('-l')
  else if (args.outputMode === 'count') rgArgs.push('--count')
  else {
    if (args.showLineNumber !== false) rgArgs.push('-n')
    if (args.context != null && args.context > 0) rgArgs.push('-C', String(args.context))
    if (args.multiline) rgArgs.push('-U', '--multiline-dotall')
  }
  rgArgs.push('--max-columns', '500')
  for (const d of GREP_SKIP_DIRS) rgArgs.push('--glob', `!**/${d}/**`)
  rgArgs.push(searchPath)
  return await new Promise((resolve) => {
    const proc = spawn('rg', rgArgs, { cwd: workDir, windowsHide: true })
    let out = ''
    let killed = false
    const t = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
    }, timeoutMs)
    proc.stdout?.on('data', (ch: Buffer) => {
      out += ch.toString('utf8')
      if (out.length > 512 * 1024) out = out.slice(-400 * 1024)
      onProgress(`搜索中...`)
    })
    proc.stderr?.on('data', () => {})
    proc.on('error', () => {
      clearTimeout(t)
      resolve(null)
    })
    proc.on('close', (code) => {
      clearTimeout(t)
      if (signal.aborted) resolve(out.trimEnd() + '\n[已取消]')
      else if (killed) resolve(out.trimEnd() + '\n[搜索超时，仅展示部分结果]')
      else if (code !== 0 && code !== 1) resolve(null)
      else resolve(out.trimEnd() || 'No matches found')
    })
  })
}

async function grepFallbackJs(
  workDir: string,
  absSearch: string,
  pattern: string,
  args: {
    glob?: string
    outputMode: string
    ignoreCase: boolean
    showLineNumber: boolean
    headLimit: number
  },
  signal: AbortSignal,
  onProgress: (s: string) => void
): Promise<string> {
  let flags = args.ignoreCase ? 'gi' : 'g'
  let lineRe: RegExp
  try {
    lineRe = new RegExp(pattern, flags)
  } catch (e) {
    return `Error: ${toToolUserError(e, { toolName: 'grep' })}`
  }
  const headLimit = args.headLimit <= 0 ? Infinity : args.headLimit
  const filesWithMatches: string[] = []
  const contentLines: string[] = []
  const counts = new Map<string, number>()
  let totalMatches = 0
  let filesScanned = 0

  function matchGlob(rel: string, g?: string): boolean {
    if (!g) return true
    const base = path.basename(rel)
    if (g.includes('*')) {
      const rx = g
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '___')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/___/g, '.*')
      try {
        return new RegExp(`^${rx}$`, 'i').test(rel) || new RegExp(`^${rx}$`, 'i').test(base)
      } catch {
        return true
      }
    }
    return rel.endsWith(g) || base === g
  }

  async function walk(dir: string): Promise<void> {
    if (signal.aborted) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (signal.aborted) return
      if (GREP_SKIP_DIRS.has(ent.name)) continue
      const full = path.join(dir, ent.name)
      const rel = path.relative(workDir, full)
      if (ent.isDirectory()) await walk(full)
      else if (ent.isFile()) {
        if (!matchGlob(rel, args.glob)) continue
        filesScanned++
        if (filesScanned % 30 === 0) onProgress(`搜索中... 已扫描 ${filesScanned} 个文件`)
        let buf: Buffer
        try {
          buf = await fs.readFile(full)
        } catch {
          continue
        }
        if (buf.length > GREP_FILE_MAX) continue
        if (isBinaryBuffer(buf)) continue
        const text = buf.toString('utf8')
        const lines = text.split(/\r?\n/)
        let fileMatches = 0
        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx]!
          lineRe.lastIndex = 0
          if (lineRe.test(line)) {
            fileMatches++
            totalMatches++
            if (args.outputMode === 'content') {
              const num = args.showLineNumber !== false ? `${idx + 1}:` : ''
              let display = line
              if (display.length > 500) display = display.slice(0, 500) + ' [行被截断]'
              contentLines.push(`${rel}:${num}${display}`)
              if (contentLines.length >= headLimit) return
            }
          }
        }
        if (fileMatches > 0) {
          if (args.outputMode === 'files_with_matches') {
            filesWithMatches.push(rel)
            if (filesWithMatches.length >= headLimit) return
          } else if (args.outputMode === 'count') {
            counts.set(rel, fileMatches)
          }
        }
      }
    }
  }

  await walk(absSearch)
  if (args.outputMode === 'files_with_matches') {
    if (filesWithMatches.length === 0) return 'No matches found'
    const slice = filesWithMatches.slice(0, headLimit)
    return `Found ${slice.length} files\n${slice.join('\n')}`
  }
  if (args.outputMode === 'count') {
    if (counts.size === 0) return 'No matches found'
    const lines: string[] = []
    for (const [f, c] of counts) {
      lines.push(`${f}:${c}`)
      if (lines.length >= headLimit) break
    }
    return `${lines.join('\n')}\n\n共 ${totalMatches} 处匹配，涉及 ${counts.size} 个文件`
  }
  if (contentLines.length === 0) return 'No matches found'
  const suffix = `\n[共 ${contentLines.length} 条匹配${headLimit !== Infinity ? `，限制: ${headLimit}` : ''}]`
  return contentLines.slice(0, headLimit).join('\n') + suffix
}

export const grepExecutor: ToolExecutor = {
  name: 'grep',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) return { success: false, error: '缺少 pattern', duration: Date.now() - started }
    const relPath = typeof input.path === 'string' ? input.path : ''
    const glob = typeof input.glob === 'string' ? input.glob : undefined
    const outputMode = typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches'
    const ignoreCase = Boolean(input.ignore_case)
    const showLineNumber = input.show_line_number !== false
    const context = typeof input.context === 'number' ? input.context : undefined
    const multiline = Boolean(input.multiline)
    const headLimit = typeof input.head_limit === 'number' ? input.head_limit : 100
    ctx.sendProgress('grep', '搜索中...')
    let absSearch: string
    try {
      if (relPath && path.isAbsolute(relPath)) {
        const norm = path.resolve(relPath)
        const base = path.resolve(ctx.workDir)
        const relToBase = path.relative(base, norm)
        if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
          return { success: false, error: '路径超出工作目录范围', duration: Date.now() - started }
        }
        absSearch = await fs.realpath(norm).catch(() => norm)
      } else {
        absSearch = relPath ? await resolveSafePathReal(ctx.workDir, relPath) : path.resolve(ctx.workDir)
      }
    } catch {
      return { success: false, error: '路径超出工作目录范围', duration: Date.now() - started }
    }
    const timeoutMs = (ctx.toolsConfig.grepTimeoutSec ?? 60) * 1000
    const gargs = { glob, outputMode, ignoreCase, showLineNumber, context, multiline, headLimit }
    let text = await grepWithRg(ctx.workDir, absSearch, pattern, gargs, timeoutMs, ctx.signal, (m) =>
      ctx.sendProgress('grep', m)
    )
    if (text == null) {
      text = await grepFallbackJs(ctx.workDir, absSearch, pattern, { glob, outputMode, ignoreCase, showLineNumber, headLimit }, ctx.signal, (m) =>
        ctx.sendProgress('grep', m)
      )
    }
    return { success: true, data: { output: text }, duration: Date.now() - started }
  }
}

export const runScriptExecutor: ToolExecutor = {
  name: 'run_script',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const code = typeof input.code === 'string' ? input.code : ''
    const timeoutSec = typeof input.timeout === 'number' ? input.timeout : ctx.toolsConfig.scriptTimeout
    const py = ctx.toolsConfig.pythonPath || 'python'
    ctx.sendProgress('script', '启动 Python...')
    const env = buildPythonScriptEnv()
    const stdoutDecoder = createStreamTextDecoder('utf-8')
    const stderrDecoder = createStreamTextDecoder('utf-8')
    let stdout = ''
    let stderr = ''
    return await new Promise((resolve) => {
      const proc = spawn(py, ['-c', code], {
        cwd: ctx.workDir,
        env,
        windowsHide: true,
        shell: false
      })
      const onDataOut = (b: Buffer) => {
        stdout += stdoutDecoder.write(b)
        if (stdout.length > SCRIPT_IO_MAX) stdout = stdout.slice(0, SCRIPT_IO_MAX) + '\n[输出被截断]'
        ctx.sendProgress('script', stdout.slice(-4000))
      }
      const onDataErr = (b: Buffer) => {
        stderr += stderrDecoder.write(b)
        if (stderr.length > SCRIPT_IO_MAX) stderr = stderr.slice(0, SCRIPT_IO_MAX) + '\n[输出被截断]'
      }
      proc.stdout?.on('data', onDataOut)
      proc.stderr?.on('data', onDataErr)
      const killTimer = setTimeout(() => {
        proc.kill('SIGTERM')
      }, timeoutSec * 1000)
      const onAbort = () => proc.kill('SIGTERM')
      ctx.signal.addEventListener('abort', onAbort)
      proc.on('error', (err) => {
        clearTimeout(killTimer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolve({
          success: false,
          error: toToolUserError(err, { toolName: 'run_script' }),
          duration: Date.now() - started
        })
      })
      proc.on('close', (code) => {
        clearTimeout(killTimer)
        ctx.signal.removeEventListener('abort', onAbort)
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
        if (ctx.signal.aborted) {
          resolve({ success: false, error: '用户取消执行', duration: Date.now() - started })
          return
        }
        if (code !== 0) {
          const failMsg = `脚本执行失败（退出码: ${code}）\n${stderr}`
          resolve({
            success: false,
            error: toToolUserError(new Error(failMsg), { toolName: 'run_script' }),
            data: {
              exitCode: code,
              stdout: sanitizeToolOutputText(stdout, 'run_script'),
              stderr: sanitizeToolOutputText(stderr, 'run_script')
            },
            duration: Date.now() - started
          })
        } else {
          resolve({
            success: true,
            data: {
              exitCode: code,
              stdout: sanitizeToolOutputText(stdout, 'run_script'),
              stderr: sanitizeToolOutputText(stderr, 'run_script')
            },
            duration: Date.now() - started
          })
        }
      })
    })
  }
}

const registry = new Map<string, ToolExecutor>([
  [readFileExecutor.name, readFileExecutor],
  [listDirectoryExecutor.name, listDirectoryExecutor],
  [editFileExecutor.name, editFileExecutor],
  [writeFileExecutor.name, writeFileExecutor],
  [grepExecutor.name, grepExecutor],
  [runScriptExecutor.name, runScriptExecutor],
  [runLarkCliExecutor.name, runLarkCliExecutor],
  [readFeishuAttachmentExecutor.name, readFeishuAttachmentExecutor],
  [wechatReplyExecutor.name, wechatReplyExecutor],
  [wechatSendExecutor.name, wechatSendExecutor],
  [browserExecutor.name, browserExecutor],
  [browserDetectExecutor.name, browserDetectExecutor],
  [runShellExecutor.name, runShellExecutor],
  [listWorkDirsExecutor.name, listWorkDirsExecutor],
  [switchWorkDirExecutor.name, switchWorkDirExecutor],
  [switchSessionExecutor.name, switchSessionExecutor]
])

export function getToolExecutor(name: string): ToolExecutor | undefined {
  return registry.get(name)
}
