import { createHash } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { Dirent } from 'fs'
import { resolveSafePath, resolveSafePathReal, resolveSafeWorkDirPath, resolveSafeWriteTarget } from '../pathSecurity'
import {
  captureFileIdentity,
  identityFromStat,
  safeAtomicWrite,
  type FileIdentity
} from '../safeAtomicWrite'
import { isUnderWikiRaw } from '../wiki/wikiPaths'
import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'
import { sanitizeToolOutputText, toToolUserError } from './toolUserErrors'
import {
  combineUserAbortAndTimeout,
  outcomeFromFileToolSignal,
  throwIfAborted
} from './toolExecutionResource'
import { buildPythonScriptEnv, createStreamTextDecoder } from '../processOutputEncoding'
import { killProcessTree } from '../spawnUtil'
import { resolveRipgrepBinary } from './ripgrepBinary'
import { runLarkCliExecutor } from './runLarkCliExecutor'
import { readFeishuAttachmentExecutor } from './readFeishuAttachmentExecutor'
import { wechatReplyExecutor, wechatSendExecutor } from './wechatExecutors'
import { browserExecutor } from './browserExecutor'
import { browserDetectExecutor } from './browserDetectExecutor'
import { runShellExecutor } from './runShellExecutor'
import { listWorkDirsExecutor, switchWorkDirExecutor } from './workDirExecutors'
import { switchSessionExecutor } from './remoteSessionExecutors'
import { READ_FILE_MAX_CHARS } from '../../src/shared/toolResultLimits'
import type { FileState } from '../fileStateCache'
import { sliceFileTailLines } from '../../src/shared/readFileRange'
import {
  applyReadCharLimit,
  isBinaryBuffer,
  readFileRangeFromDisk,
  readFileTailFromDisk
} from './readFileStreaming'

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
    const rel = extractPathField(input)
    if (rel === undefined) {
      return { success: false, error: toolErrMissingPath('read_file'), duration: Date.now() - started }
    }
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

      const offsetRaw = input.offset
      const limitRaw = input.limit
      const tailRaw = input.tail
      const hasTail = tailRaw !== undefined && tailRaw !== null
      const hasOffset = offsetRaw !== undefined && offsetRaw !== null
      const hasLimit = limitRaw !== undefined && limitRaw !== null
      const rangeRequested = hasTail || hasOffset || hasLimit

      // Meta：大文件且无范围参数
      if (!rangeRequested && st.size > READ_FILE_MAX_CHARS) {
        recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
          content: '',
          truncated: true,
          rangeRequested: false
        })
        return {
          success: true,
          data: {
            path: rel,
            content: '',
            encoding: 'utf8',
            byteSize: st.size,
            exceedsReadLimit: true,
            maxChars: READ_FILE_MAX_CHARS,
            note: `文件超过 read_file 单次字符上限（${READ_FILE_MAX_CHARS}），未返回正文。请使用 tail（如 tail=200 读末尾）或 offset+limit 分段读取。`
          },
          duration: Date.now() - started
        }
      }

      try {
        if (hasTail) {
          const tail =
            typeof tailRaw === 'number' && Number.isFinite(tailRaw) ? Math.floor(tailRaw) : 1
          const tailed = await readFileTailFromDisk(abs, tail, { signal: op, fileSize: st.size })
          const limited = applyReadCharLimit(tailed.content, {
            isTail: true,
            hasMoreBefore: tailed.hasMoreBefore
          })
          const truncated = limited.truncated || tailed.truncated
          // linesReturned 须为截断后实际返回行数（§4.3.2）
          const linesReturned = limited.truncated
            ? sliceFileTailLines(limited.content, tail).linesReturned
            : tailed.linesReturned
          recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
            content: limited.content,
            truncated,
            rangeRequested: true
          })
          return {
            success: true,
            data: {
              path: rel,
              content: limited.content,
              encoding: 'utf8',
              linesReturned,
              hasMoreBefore: limited.hasMoreBefore || tailed.truncated,
              truncated,
              ...(truncated ? { note: `内容超过 ${READ_MAX} 字符已截断（保留窗口尾部）` } : {})
            },
            duration: Date.now() - started
          }
        }

        if (hasOffset || hasLimit) {
          const offset =
            hasOffset && typeof offsetRaw === 'number' && Number.isFinite(offsetRaw)
              ? Math.floor(offsetRaw)
              : 1
          const limit =
            hasLimit && typeof limitRaw === 'number' && Number.isFinite(limitRaw)
              ? Math.floor(limitRaw)
              : undefined
          const ranged = await readFileRangeFromDisk(abs, offset, limit, {
            signal: op,
            fileSize: st.size
          })
          const limited = applyReadCharLimit(ranged.content, { isTail: false })
          const truncated = limited.truncated || ranged.truncated
          recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
            content: limited.content,
            truncated,
            rangeRequested: true
          })
          const data: Record<string, unknown> = {
            path: rel,
            content: limited.content,
            encoding: 'utf8',
            startLine: ranged.startLine,
            endLine: ranged.endLine,
            hasMore: ranged.hasMore,
            ...(ranged.totalLines !== undefined ? { totalLines: ranged.totalLines } : {}),
            ...(truncated ? { truncated: true, note: `内容超过 ${READ_MAX} 字符已截断` } : {})
          }
          if (!truncated && ranged.hasMore) {
            data.note =
              ranged.totalLines !== undefined
                ? `仅返回第 ${ranged.startLine}–${ranged.endLine} 行，共 ${ranged.totalLines} 行；可增大 offset 继续读取`
                : `仅返回第 ${ranged.startLine}–${ranged.endLine} 行；可增大 offset 继续读取`
          }
          return { success: true, data, duration: Date.now() - started }
        }

        // Full：小文件全文（边界附近可能仍超字符上限 → Meta）
        const buf = await fs.readFile(abs, { signal: op })
        if (isBinaryBuffer(buf)) {
          return { success: false, error: '文件为二进制格式，无法读取', duration: Date.now() - started }
        }
        const text = buf.toString('utf8')
        if (text.length > READ_FILE_MAX_CHARS) {
          recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
            content: '',
            truncated: true,
            rangeRequested: false
          })
          return {
            success: true,
            data: {
              path: rel,
              content: '',
              encoding: 'utf8',
              byteSize: st.size,
              exceedsReadLimit: true,
              maxChars: READ_FILE_MAX_CHARS,
              note: `文件超过 read_file 单次字符上限（${READ_FILE_MAX_CHARS}），未返回正文。请使用 tail（如 tail=200 读末尾）或 offset+limit 分段读取。`
            },
            duration: Date.now() - started
          }
        }
        recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
          content: text,
          truncated: false,
          rangeRequested: false
        })
        return {
          success: true,
          data: { path: rel, content: text, encoding: 'utf8' },
          duration: Date.now() - started
        }
      } catch (e) {
        const ab = fileToolAbortResult(op, '读取超时，请检查文件路径或网络连接', started)
        if (ab) return ab
        if (e instanceof Error && e.message === 'BINARY') {
          return { success: false, error: '文件为二进制格式，无法读取', duration: Date.now() - started }
        }
        throw e
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
    const rel = extractPathField(input) ?? '.'
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
import { extractPathField } from '../toolPathField'

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

function writePathErrorMessage(e: unknown, rel: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('路径超出') || msg.includes('工作目录')) return `路径超出工作目录范围: ${rel}`
  return msg
}

export const editFileExecutor: ToolExecutor = {
  name: 'edit_file',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = extractPathField(input)
    if (rel === undefined) {
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
      let writeTarget: Awaited<ReturnType<typeof resolveSafeWriteTarget>>
      try {
        writeTarget = await resolveSafeWriteTarget(ctx.workDir, rel)
      } catch (e) {
        return { success: false, error: writePathErrorMessage(e, rel), duration: Date.now() - started }
      }
      const abs = writeTarget.targetPath
      if (oldS === newS) {
        return { success: false, error: '新旧字符串相同，无需修改', duration: Date.now() - started }
      }
      const existed = writeTarget.existed
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
      let expectedIdentity: FileIdentity | null = null
      if (existed) {
        try {
          cur = await fs.readFile(abs, { encoding: 'utf8', signal: op })
          expectedIdentity = await captureFileIdentity(abs)
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
        await safeAtomicWrite({
          targetPath: abs,
          parentReal: writeTarget.parentReal,
          body: next,
          expectedIdentity,
          signal: op
        })
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
    const rel = extractPathField(input)
    if (rel === undefined) {
      return { success: false, error: toolErrMissingPath('write_file'), duration: Date.now() - started }
    }
    const content = typeof input.content === 'string' ? input.content : ''
    const rawBlock = wikiRawWriteBlocked(ctx, rel)
    if (rawBlock) return { ...rawBlock, duration: Date.now() - started }
    ctx.sendProgress('writing', '正在写入文件...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      let writeTarget: Awaited<ReturnType<typeof resolveSafeWriteTarget>>
      try {
        writeTarget = await resolveSafeWriteTarget(ctx.workDir, rel)
      } catch (e) {
        return { success: false, error: writePathErrorMessage(e, rel), duration: Date.now() - started }
      }
      const abs = writeTarget.targetPath
      const existed = writeTarget.existed
      const body = content.replace(/\r\n/g, '\n')
      let expectedIdentity: FileIdentity | null = null
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
          expectedIdentity = await captureFileIdentity(abs)
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
      } else if (writeTarget.existingStat) {
        expectedIdentity = identityFromStat(writeTarget.existingStat)
      }
      throwIfAborted(op)
      try {
        await safeAtomicWrite({
          targetPath: abs,
          parentReal: writeTarget.parentReal,
          body,
          expectedIdentity,
          signal: op
        })
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

export type GrepExecArgs = {
  glob?: string
  outputMode: string
  ignoreCase: boolean
  showLineNumber: boolean
  context?: number
  multiline: boolean
  headLimit: number
}

export type RipgrepRunResult =
  | { kind: 'success'; output: string }
  | { kind: 'no_match'; output: 'No matches found' }
  | { kind: 'unavailable'; reason: 'missing' | 'permission' | 'load_failed' }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'timeout'; partialOutput: string }
  | { kind: 'cancelled'; partialOutput: string }
  | { kind: 'failed'; exitCode: number | null; message: string }

export function validateGrepInput(input: Record<string, unknown>): string | null {
  const outputMode = typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches'
  if (!['files_with_matches', 'content', 'count'].includes(outputMode)) return 'output_mode 参数无效'
  const context = typeof input.context === 'number' ? input.context : undefined
  const headLimit = typeof input.head_limit === 'number' ? input.head_limit : 100
  if (context !== undefined && (!Number.isInteger(context) || context < 0 || context > 1000)) return 'context 必须是 0～1000 的整数'
  if (!Number.isInteger(headLimit) || headLimit < 0 || headLimit > 1_000_000) return 'head_limit 必须是 0～1000000 的整数'
  if (outputMode !== 'content' && (Object.prototype.hasOwnProperty.call(input, 'context') || Object.prototype.hasOwnProperty.call(input, 'multiline') || Object.prototype.hasOwnProperty.call(input, 'show_line_number'))) return 'context、multiline、show_line_number 仅适用于 content 模式'
  return null
}

export function createGrepRipgrepDiagnostic(resolved: Pick<ReturnType<typeof resolveRipgrepBinary>, 'source' | 'platform' | 'arch' | 'path'>): string {
  return `source=${resolved.source};platform=${resolved.platform};arch=${resolved.arch};status=${resolved.path ? 'ready' : 'unavailable'}`
}

export async function grepWithRg(
  binaryPath: string,
  workDir: string,
  searchPath: string,
  pattern: string,
  args: GrepExecArgs,
  timeoutMs: number,
  signal: AbortSignal,
  onProgress: (msg: string) => void,
  spawnProcess: (binary: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess = spawn
): Promise<RipgrepRunResult> {
  if (signal.aborted) return { kind: 'cancelled', partialOutput: '' }
  const rgArgs = ['--no-config', '--color', 'never', '--regexp', pattern]
  if (args.ignoreCase) rgArgs.push('-i')
  if (args.glob) {
    rgArgs.push('--glob', args.glob)
  }
  if (args.outputMode === 'files_with_matches') rgArgs.push('-l')
  else if (args.outputMode === 'count') rgArgs.push('--count', '--with-filename')
  else {
    if (args.showLineNumber !== false) rgArgs.push('-n')
    else rgArgs.push('--no-line-number')
    if (args.context != null && args.context > 0) rgArgs.push('-C', String(args.context))
    if (args.multiline) rgArgs.push('-U', '--multiline-dotall')
  }
  rgArgs.push('--max-columns', '500')
  for (const d of GREP_SKIP_DIRS) rgArgs.push('--glob', `!**/${d}/**`)
  rgArgs.push(searchPath)
  return await new Promise((resolve) => {
    const proc = spawnProcess(binaryPath, rgArgs, { cwd: workDir, windowsHide: true })
    let settled = false
    let out = ''
    let stderr = ''
    let killed = false
    let truncated = false
    const t = setTimeout(() => {
      if (settled) return
      killed = true
      proc.kill('SIGTERM')
    }, timeoutMs)
    const onAbort = () => {
      if (!settled) {
        killed = true
        proc.kill('SIGTERM')
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    proc.stdout?.on('data', (ch: Buffer) => {
      out += ch.toString('utf8')
      if (Buffer.byteLength(out, 'utf8') > 512 * 1024) {
        out = Buffer.from(out, 'utf8').subarray(0, 400 * 1024).toString('utf8')
        truncated = true
      }
      onProgress(`搜索中...`)
    })
    proc.stderr?.on('data', (ch: Buffer) => {
      if (Buffer.byteLength(stderr, 'utf8') < 16 * 1024) {
        stderr += ch.toString('utf8')
        if (Buffer.byteLength(stderr, 'utf8') > 16 * 1024) stderr = Buffer.from(stderr).subarray(0, 16 * 1024).toString('utf8')
      }
    })
    const finish = (result: RipgrepRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    proc.on('error', (err) => {
      const errorCode = (err as NodeJS.ErrnoException).code
      finish({ kind: 'unavailable', reason: errorCode === 'EACCES' ? 'permission' : 'missing' })
    })
    proc.on('close', (code) => {
      if (signal.aborted) finish({ kind: 'cancelled', partialOutput: out.trimEnd() })
      else if (killed) finish({ kind: 'timeout', partialOutput: out.trimEnd() })
      else if (code !== 0 && code !== 1) finish({ kind: 'failed', exitCode: code, message: sanitizeToolOutputText(Buffer.from(stderr.trim(), 'utf8').subarray(0, 4000).toString('utf8') || 'ripgrep 返回非成功状态', 'grep') })
      else {
        let result = out.trimEnd()
        if (args.headLimit > 0) {
          const lines = result.split('\n')
          if (lines.length > args.headLimit) {
            result = lines.slice(0, args.headLimit).join('\n') + `\n[已按 head_limit=${args.headLimit} 截断，共 ${lines.length} 行]`
          }
        }
        if (truncated) result += '\n[输出过大，仅展示前 400KB]'
        finish(result ? { kind: 'success', output: result } : { kind: 'no_match', output: 'No matches found' })
      }
    })
  })
}

export async function grepFallbackJs(
  workDir: string,
  absSearch: string,
  pattern: string,
  args: GrepExecArgs,
  signal: AbortSignal,
  onProgress: (s: string) => void
): Promise<string> {
  let flags = 'g'
  if (args.ignoreCase) flags += 'i'
  if (args.multiline) flags += 's'
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

  // glob 过滤只对目录递归生效；显式命名的单文件目标不应用（与 ripgrep 语义一致）。
  // 匹配前先统一为 posix 分隔符，避免 Windows 反斜杠路径对含 / 的 glob 失配。
  const buildGlobMatcher = (g: string | undefined): ((rel: string) => boolean) | null => {
    if (!g) return null
    const toPosix = (r: string): string => r.split(path.sep).join('/')
    if (!g.includes('*')) {
      const gg = toPosix(g)
      return (rel: string): boolean => {
        const p = toPosix(rel)
        const base = p.slice(p.lastIndexOf('/') + 1)
        return p.endsWith(gg) || base === gg
      }
    }
    const rx = g
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '___')
      .replace(/\*/g, '[^/]*')
      .replace(/___/g, '.*')
    let re: RegExp
    try {
      re = new RegExp(`^${rx}$`, 'i')
    } catch {
      return () => true
    }
    return (rel: string): boolean => {
      const p = toPosix(rel)
      const base = p.slice(p.lastIndexOf('/') + 1)
      return re.test(p) || re.test(base)
    }
  }

  const globMatcher = buildGlobMatcher(args.glob)
  const matchesGlob = (rel: string, applyGlob: boolean): boolean =>
    !applyGlob || !globMatcher || globMatcher(rel)

  async function scanFile(full: string, applyGlob: boolean): Promise<void> {
    const rel = path.relative(workDir, full)
    if (!matchesGlob(rel, applyGlob)) return
    filesScanned++
    if (filesScanned % 30 === 0) onProgress(`搜索中... 已扫描 ${filesScanned} 个文件`)
    let buf: Buffer
    try {
      buf = await fs.readFile(full)
    } catch {
      return
    }
    if (buf.length > GREP_FILE_MAX) return
    if (isBinaryBuffer(buf)) return
    const text = buf.toString('utf8')

    if (args.outputMode === 'content') {
      if (args.multiline) scanContentMultiline(rel, text)
      else scanContentLines(rel, text)
      return
    }

    const matches = countMatches(text)
    if (matches === 0) return
    totalMatches += matches
    if (args.outputMode === 'files_with_matches') {
      filesWithMatches.push(rel)
      if (filesWithMatches.length >= headLimit) return
    } else if (args.outputMode === 'count') {
      counts.set(rel, matches)
    }
  }

  // 统一展示规则：内嵌换行转义为字面量 \n（保证一条匹配一行），单条展示上限 500 字符
  function clampLine(line: string): string {
    let display = line.replace(/\r?\n/g, '\\n')
    if (display.length > 500) display = display.slice(0, 500) + ' [行被截断]'
    return display
  }

  // 对齐 rg 输出：匹配行 rel:num:content，上下文行 rel-num-content；不带行号时省略 num
  function pushContentLine(rel: string, num: number, line: string, isMatch: boolean): void {
    const display = clampLine(line)
    if (args.showLineNumber !== false) {
      contentLines.push(isMatch ? `${rel}:${num}:${display}` : `${rel}-${num}-${display}`)
    } else {
      contentLines.push(isMatch ? `${rel}:${display}` : `${rel}-${display}`)
    }
  }

  // 逐行匹配（非 multiline），context>0 时附带上下文行
  function scanContentLines(rel: string, text: string): void {
    const lines = text.split(/\r?\n/)
    const ctx = args.context && args.context > 0 ? args.context : 0
    const emitted = new Set<number>()
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!
      lineRe.lastIndex = 0
      if (!lineRe.test(line)) continue
      totalMatches++
      if (ctx > 0) {
        const lo = Math.max(0, idx - ctx)
        const hi = Math.min(lines.length - 1, idx + ctx)
        for (let cix = lo; cix <= hi; cix++) {
          if (emitted.has(cix)) continue
          emitted.add(cix)
          pushContentLine(rel, cix + 1, lines[cix]!, cix === idx)
        }
      } else {
        pushContentLine(rel, idx + 1, line, true)
      }
      if (totalMatches >= headLimit) return
    }
  }

  // 跨行匹配（multiline）：对整段文本做匹配，输出命中块
  function scanContentMultiline(rel: string, text: string): void {
    lineRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = lineRe.exec(text)) !== null) {
      totalMatches++
      const startLine = text.slice(0, m.index).split('\n').length
      pushContentLine(rel, startLine, m[0], true)
      if (totalMatches >= headLimit) return
      if (m[0].length === 0) lineRe.lastIndex++
    }
  }

  // count/files 模式用于判断文件是否命中并统计：multiline 按整段计数，否则按行计数
  function countMatches(text: string): number {
    let c = 0
    if (args.multiline) {
      lineRe.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = lineRe.exec(text)) !== null) {
        c++
        if (m[0].length === 0) lineRe.lastIndex++
      }
      return c
    }
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      lineRe.lastIndex = 0
      if (lineRe.test(line)) c++
    }
    return c
  }

  const limitReached = (): boolean =>
    (args.outputMode === 'content' && totalMatches >= headLimit) ||
    (args.outputMode === 'files_with_matches' && filesWithMatches.length >= headLimit)

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (signal.aborted || limitReached()) return
      if (GREP_SKIP_DIRS.has(ent.name)) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) await walk(full)
      else if (ent.isFile()) await scanFile(full, true)
    }
  }

  if (signal.aborted) return 'No matches found'
  const st = await fs.stat(absSearch).catch(() => null)
  if (st?.isFile()) await scanFile(absSearch, false)
  else await walk(absSearch)
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
  const suffix = `\n[共 ${totalMatches} 条匹配${headLimit !== Infinity ? `，限制: ${headLimit}` : ''}]`
  return contentLines.join('\n') + suffix
}

export const grepExecutor: ToolExecutor = {
  name: 'grep',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) return { success: false, error: '缺少 pattern', duration: Date.now() - started }
    const relPath = extractPathField(input) ?? ''
    const glob = typeof input.glob === 'string' ? input.glob : undefined
    const outputMode = typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches'
    const inputError = validateGrepInput(input)
    if (inputError) return { success: false, error: inputError, duration: Date.now() - started }
    const ignoreCase = Boolean(input.ignore_case)
    const showLineNumber = input.show_line_number !== false
    const context = typeof input.context === 'number' ? input.context : undefined
    const multiline = Boolean(input.multiline)
    const headLimit = typeof input.head_limit === 'number' ? input.head_limit : 100
    ctx.sendProgress('grep', '搜索中...')
    let absSearch: string
    try {
      if (relPath && path.isAbsolute(relPath)) {
        absSearch = await resolveSafeWorkDirPath(ctx.workDir, relPath)
      } else {
        absSearch = relPath ? await resolveSafePathReal(ctx.workDir, relPath) : path.resolve(ctx.workDir)
      }
    } catch {
      return { success: false, error: '路径超出工作目录范围', duration: Date.now() - started }
    }
    const timeoutMs = (ctx.toolsConfig.grepTimeoutSec ?? 60) * 1000
    const gargs: GrepExecArgs = { glob, outputMode, ignoreCase, showLineNumber, context, multiline, headLimit }
    const resolved = resolveRipgrepBinary({
      packaged: app?.isPackaged ?? false,
      resourcesPath: process.resourcesPath,
      developmentRoot: path.resolve(__dirname, '../../..'),
      platform: process.platform,
      arch: process.arch
    })
    void ctx.recordDiagnostic?.({
      code: 'grep-ripgrep',
      message: createGrepRipgrepDiagnostic(resolved)
    })
    if (!resolved.path) {
      void ctx.recordDiagnostic?.({
        code: 'grep-ripgrep-fallback',
        message: 'source=' + resolved.source + ';platform=' + resolved.platform + ';arch=' + resolved.arch + ';status=fallback;reason=' + (resolved.reason ?? 'unavailable')
      })
      const fallbackOutput = await grepFallbackJs(ctx.workDir, absSearch, pattern, gargs, ctx.signal, (m) =>
        ctx.sendProgress('grep', m)
      )
      return { success: true, data: { output: fallbackOutput, degraded: true }, duration: Date.now() - started }
    }
    const text = await grepWithRg(resolved.path, ctx.workDir, absSearch, pattern, gargs, timeoutMs, ctx.signal, (m) =>
      ctx.sendProgress('grep', m)
    )
    if (text.kind === 'success' || text.kind === 'no_match') {
      return { success: true, data: { output: text.output }, duration: Date.now() - started }
    }
    if (text.kind === 'unavailable') {
      void ctx.recordDiagnostic?.({
        code: 'grep-ripgrep-fallback',
        message: 'source=' + resolved.source + ';platform=' + resolved.platform + ';arch=' + resolved.arch + ';status=fallback;reason=' + text.reason
      })
      const fallbackOutput = await grepFallbackJs(ctx.workDir, absSearch, pattern, gargs, ctx.signal, (m) =>
        ctx.sendProgress('grep', m)
      )
      return { success: true, data: { output: fallbackOutput, degraded: true }, duration: Date.now() - started }
    }
    if (text.kind === 'cancelled') return { success: false, error: `${text.partialOutput}\n[已取消]`, duration: Date.now() - started }
    if (text.kind === 'timeout') return { success: false, error: `${text.partialOutput}\n[搜索超时，仅展示部分结果]`, duration: Date.now() - started }
    return { success: false, error: text.message, duration: Date.now() - started }
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
        void killProcessTree(proc)
      }, timeoutSec * 1000)
      const onAbort = () => {
        void killProcessTree(proc)
      }
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
