import { createHash } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import fs from 'fs/promises'
import { realpathSync } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import type { Dirent } from 'fs'
import { resolveSafePath, resolveSafePathReal, resolveSafeWorkDirPath, resolveSafeWriteTarget } from '../pathSecurity'
import {
  captureFileIdentity,
  identityFromStat,
  safeAtomicWrite,
  type FileIdentity
} from '../safeAtomicWrite'
import { resolveReadPermitTarget } from '../confirmation/readPermitExecutor'
import { validateWriteExecutionPermit } from '../confirmation/writeExecutionPermit'
import { resolvePermittedWriteTarget } from '../confirmation/writePermitExecutor'
import { classifyWriteTargetScope } from '../confirmation/extractors/writePathFacts'
import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'
import { sanitizeToolOutput, sanitizeToolOutputText, toToolUserError } from './toolUserErrors'
import {
  combineUserAbortAndTimeout,
  outcomeFromFileToolSignal,
  throwIfAborted
} from './toolExecutionResource'
import { buildPythonScriptEnv } from '../processOutputEncoding'
import { UTF8_CONTRACT } from '../processOutput/contracts'
import { createChildStreamDecoder } from '../processOutput/decodeChildOutput'
import { processTreeKiller, runCommandWithTimeout } from '../spawnUtil'
import { ProcessSupervisor } from '../shell/processSupervisor'
import { snapshotEnvForLog } from '../shell/envSnapshot'
import { logAgentEvent } from '../agentLogger/agentLogger'
import {
  classifyRipgrepSpawnError,
  inspectRipgrepBinary,
  resolveRipgrepBinary,
  type RipgrepUnavailableReason
} from './ripgrepBinary'
import { runLarkCliExecutor } from './runLarkCliExecutor'
import { readFeishuAttachmentExecutor } from './readFeishuAttachmentExecutor'
import { wechatReplyExecutor, wechatSendExecutor } from './wechatExecutors'
import { browserExecutor } from './browserExecutor'
import { runShellExecutor } from './runShellExecutor'
import { TypedToolRegistry } from './plannedToolRegistry'
import { runShellRegisteredTool } from './runShellRegisteredTool'
import { skillsReadTool } from './skillsReadTool'
import { historyReadTool } from './historyTool'
import { toolkitFindTool, toolkitCallTool } from '../capabilities/toolkitTool'
import '../capabilities/registerBuiltinCapabilities'
import { listWorkDirsExecutor, switchWorkDirExecutor } from './workDirExecutors'
import { switchSessionExecutor } from './remoteSessionExecutors'
import { READ_FILE_MAX_CHARS } from '../../src/shared/toolResultLimits'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { buildEscapeLayerVariants, diagnoseMissingOldString } from './editDiagnosis'
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
  opts: { content: string; truncated: boolean; rangeRequested: boolean; size: number }
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
    isRangeView: false,
    size: opts.size
  })
}

async function assertDiskMatchesReadCache(
  abs: string,
  stCache: FileState,
  cur: string,
  op: AbortSignal,
  errorMessage: string,
  cache: ToolExecutionContext['fileStateCache']
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
      // 评审 P1-1：报「外部修改」即失效缓存，保证随后的重读绕过去重提示拿到真实内容（自愈出口）
      cache.invalidate(abs)
      return { success: false, error: errorMessage }
    }
    return null
  }
  if (cur !== stCache.content) {
    cache.invalidate(abs)
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
  resourceKeys: (input, context) => workspaceResourceKeys(input, context, 'read'),
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    let permitFileHandle: Awaited<ReturnType<typeof fs.open>> | undefined
    const rel = extractPathField(input)
    if (rel === undefined) {
      return { success: false, error: toolErrMissingPath('read_file'), duration: Date.now() - started }
    }
    ctx.sendProgress('reading', '正在读取文件...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      const permitted = await resolveReadPermitTarget('read_file', input, ctx)
      if (!permitted.ok) return { success: false, error: permitted.caseId === 'read-permit-missing' ? '读取许可缺失，未执行读取' : '读取许可校验失败', diagnostic: { caseId: permitted.caseId, retryable: false, category: permitted.failureClass, ...(permitted.factId ? { factId: permitted.factId } : {}) }, duration: Date.now() - started }
      const abs = permitted.path
      permitFileHandle = permitted.fileHandle
      if (!permitFileHandle && !(await pathExists(abs))) {
        return { success: true, data: { path: rel, content: '', encoding: 'utf8', note: '文件不存在' }, duration: Date.now() - started }
      }
      let st: Awaited<ReturnType<typeof fs.stat>>
      try {
        st = permitFileHandle ? await permitFileHandle.stat() : await fs.stat(abs)
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

      // P1-5（agent-context-token-cost-optimization-plan §5.5）：会话内已完整读取过且文件未变化
      // （mtime 一致）时，不再重发全文，只返回提示——实测 read_file 重复率 43%（69 读 / 39 路径）。
      // 只提示不拒绝：需要特定区间传 offset/limit；需要强制重读全文传 offset=0。
      // 评审 P1-1：mtime 单判据会被 FAT32 2s 精度 / 同步软件保留时间戳绕过（内容已变却提示
      // 「已在上下文」→ edit 护栏报外部修改 → 重读又命中提示，不可自愈），故加 size 双重校验。
      if (!rangeRequested) {
        const cached = ctx.fileStateCache.get(abs)
        if (cached && !cached.isPartial && !cached.isRangeView && cached.mtime === st.mtimeMs && (cached.size === undefined || cached.size === st.size)) {
          return {
            success: true,
            data: {
              path: rel,
              content: '',
              unchangedSinceLastRead: true,
              byteSize: st.size,
              note: '该文件已在本次会话中完整读取且此后未变化，正文不再重复返回。如需特定区间请传 offset/limit；如需强制重读全文请传 offset=0。'
            },
            duration: Date.now() - started
          }
        }
      }

      // Meta：大文件且无范围参数
      if (!rangeRequested && st.size > READ_FILE_MAX_CHARS) {
        recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
          content: '',
          truncated: true,
          rangeRequested: false,
          size: st.size
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
          const tailed = await readFileTailFromDisk(abs, tail, { signal: op, fileSize: st.size, ...(permitFileHandle ? { fileHandle: permitFileHandle } : {}) })
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
            rangeRequested: true,
            size: st.size
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
            fileSize: st.size,
            ...(permitFileHandle ? { fileHandle: permitFileHandle } : {})
          })
          const limited = applyReadCharLimit(ranged.content, { isTail: false })
          const truncated = limited.truncated || ranged.truncated
          recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
            content: limited.content,
            truncated,
            rangeRequested: true,
            size: st.size
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
        const buf = permitFileHandle ? await permitFileHandle.readFile() : await fs.readFile(abs, { signal: op })
        if (isBinaryBuffer(buf)) {
          return { success: false, error: '文件为二进制格式，无法读取', duration: Date.now() - started }
        }
        const text = buf.toString('utf8')
        if (text.length > READ_FILE_MAX_CHARS) {
          recordReadFileCache(ctx.fileStateCache, abs, st.mtimeMs, {
            content: '',
            truncated: true,
            rangeRequested: false,
            size: st.size
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
          rangeRequested: false,
          size: st.size
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
      await permitFileHandle?.close().catch(() => undefined)
      dispose()
    }
  }
}

export const listDirectoryExecutor: ToolExecutor = {
  name: 'list_directory',
  resourceKeys: (input, context) => workspaceResourceKeys(input, context, 'read'),
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    ctx.sendProgress('listing', '正在读取目录...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      const permitted = await resolveReadPermitTarget('list_directory', input, ctx)
      if (!permitted.ok) return { success: false, error: '目录读取许可校验失败', diagnostic: { caseId: permitted.caseId, retryable: false, category: permitted.failureClass, ...(permitted.factId ? { factId: permitted.factId } : {}) }, duration: Date.now() - started }
      const target = permitted.path
      const root = path.resolve(ctx.workDir)
      const rows: Array<{ name: string; path: string; isDirectory: boolean; size?: number; mtimeMs?: number }> = []
      const dir = await fs.opendir(target)
      try {
        for await (const ent of dir) {
          if (rows.length % 25 === 0) throwIfAborted(op)
          const p = path.join(target, ent.name)
          let size: number | undefined
          let mtimeMs: number | undefined
          try {
            const s = await fs.lstat(p)
            mtimeMs = s.mtimeMs
            if (s.isFile()) size = s.size
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
      } finally {
        await dir.close().catch(() => undefined)
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

/**
 * P1-C：转义归一后唯一命中回退（§5.3，默认关闭，入参 tolerate_escape_layer 显式开启）。
 * 仅在有限变体集（反斜杠 run ±1、字面 \n ↔ 真实换行）中「恰好一个变体、且该变体在
 * 文件中恰好命中一次」时返回该变体；否则返回 null，退回诊断路径。不做任何模糊匹配。
 */
function applyEditWithEscapeTolerance(
  cur: string,
  oldS: string
): { variant: string; kind: 'escape-layer' | 'literal-newline'; backslashRunDelta: number } | null {
  const curNorm = normalizeLineEndingsForMatch(cur)
  const oldNorm = normalizeLineEndingsForMatch(oldS)
  const hits = buildEscapeLayerVariants(oldNorm)
    .map((v) => ({ variant: v.text, kind: v.kind, backslashRunDelta: v.backslashRunDelta }))
    .filter((v) => countOccurrences(curNorm, v.variant) === 1)
  if (hits.length !== 1) return null
  return hits[0]
}

import { toolErrMissingPath } from '../toolInputGuards'
import { extractPathField } from '../toolPathField'

/** 仅为调度冲突检测生成保守资源键；无法规范化时返回 undefined 触发串行屏障。 */
export function workspaceResourceKeys(
  input: Record<string, unknown>,
  context: { workDir: string; sessionId: string },
  _mode: 'read' | 'write'
): readonly string[] | undefined {
  const rel = extractPathField(input)
  if (!rel || path.isAbsolute(rel)) return undefined
  const normalized = path.posix.normalize(rel.replaceAll('\\', '/'))
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined
  // 资源身份是桌面运行时全局共享的绝对路径，不能包含 sessionId；否则跨会话
  // 对同一文件的写入会得到不同锁键并发执行。
  const lexical = path.resolve(context.workDir, normalized)
  try {
    return [`workspace:${realpathSync.native(lexical)}`]
  } catch {
    let ancestor = lexical
    const suffix: string[] = []
    while (ancestor !== path.dirname(ancestor)) {
      suffix.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
      try {
        const realAncestor = realpathSync.native(ancestor)
        return [`workspace:${path.join(realAncestor, ...suffix)}`]
      } catch {
        // 继续向上寻找最近存在的祖先目录。
      }
    }
    // 无法判断真实身份时使用未知屏障，禁止跨会话并发绕过互斥。
    return ['unknown:workspace-path']
  }
}
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { normalizeRunScriptLanguage, resolveNonPythonScriptLaunch } from './scriptRunner'

const ERR_FILE_NOT_READ_FOR_EDIT =
  '文件尚未在本会话中通过 read_file 读取，请先读取后再编辑'
const ERR_FILE_NOT_READ_FOR_WRITE =
  '文件尚未在本会话中通过 read_file 读取，请先读取后再写入'
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
  if (msg === 'remote-write-target-outside-workdir') return `远程会话只能写入当前工作目录内的文件: ${rel}`
  if (msg.includes('路径超出') || msg.includes('工作目录')) return `路径超出工作目录范围: ${rel}`
  return msg
}

async function assertRemoteWriteTargetInsideWorkDir(workDir: string, targetPath: string): Promise<void> {
  try {
    if (await classifyWriteTargetScope(targetPath, workDir) !== 'inside-workdir') {
      throw new Error('remote-write-target-outside-workdir')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'remote-write-target-outside-workdir') throw error
    throw new Error('remote-write-workdir-unavailable')
  }
}

async function resolveWriteTargetFromPermit(input: Record<string, unknown>, ctx: ToolExecutionContext, toolName: 'write_file' | 'edit_file') {
  const permit = ctx.writeExecutionPermit
  const rawPath = extractPathField(input)
  if (rawPath === undefined) throw new Error('write-path-missing')
  if (!permit && ctx.lane !== 'desktop') return resolveSafeWriteTarget(ctx.workDir, rawPath)
  if (!permit) throw new Error('write-permit-missing')
  const valid = validateWriteExecutionPermit(permit, { requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName, input })
  if (!valid.ok) throw new Error(valid.caseId)
  if (ctx.lane === 'feishu' || ctx.lane === 'wechat' || ctx.remoteContext !== undefined) {
    await assertRemoteWriteTargetInsideWorkDir(ctx.workDir, permit.target.normalizedPath)
  }
  return resolvePermittedWriteTarget(permit.target)
}

function writePermitFailure(e: unknown): Pick<ToolExecutorResult, 'success' | 'error' | 'diagnostic'> {
  const caseId = e instanceof Error ? e.message : 'write-permit-validation-failed'
  const environmentFailure = caseId === 'remote-write-workdir-unavailable' || (caseId !== 'remote-write-target-outside-workdir' && (caseId.includes('identity') || caseId.includes('target-') || caseId.includes('symlink') || caseId.includes('parent-')))
  return {
    success: false,
    error: environmentFailure ? '写入目标在检查后发生变化或不符合普通文件要求。' : '写入许可校验失败，未执行写入。',
    diagnostic: { caseId, retryable: environmentFailure, category: environmentFailure ? 'environment' : 'policy' }
  }
}

function capturedIdentityMatchesPermit(ctx: ToolExecutionContext, identity: FileIdentity | null): boolean {
  const permitted = ctx.writeExecutionPermit?.target.identity
  if (!permitted) return ctx.writeExecutionPermit?.target.targetKind === 'missing' && identity === null
  return identity !== null && identity.dev === permitted.dev && identity.ino === permitted.ino && identity.size === permitted.size && identity.mtimeMs === permitted.mtimeMs
}

export const editFileExecutor: ToolExecutor = {
  name: 'edit_file',
  resourceKeys: (input, context) => workspaceResourceKeys(input, context, 'write'),
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = extractPathField(input)
    if (rel === undefined) {
      return { success: false, error: toolErrMissingPath('edit_file'), duration: Date.now() - started }
    }
    const oldS = typeof input.old_string === 'string' ? input.old_string : ''
    const newS = typeof input.new_string === 'string' ? input.new_string : ''
    const replaceAll = Boolean(input.replace_all)
    ctx.sendProgress('editing', '正在编辑文件...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      let writeTarget: Awaited<ReturnType<typeof resolveSafeWriteTarget>>
      try {
        writeTarget = await resolveWriteTargetFromPermit(input, ctx, 'edit_file')
      } catch (e) {
        if (ctx.lane === 'desktop') return { ...writePermitFailure(e), duration: Date.now() - started }
        return { ...writePermitFailure(e), error: writePathErrorMessage(e, rel), duration: Date.now() - started }
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
          if (ctx.lane === 'desktop' && !capturedIdentityMatchesPermit(ctx, expectedIdentity)) {
            return { ...writePermitFailure(new Error('write-target-identity-mismatch')), duration: Date.now() - started }
          }
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
          '文件已被外部程序修改，请重新读取后再编辑',
          ctx.fileStateCache
        )
        if (mismatch) return { ...mismatch, duration: Date.now() - started }
      }
      const occ = countOccurrencesWithEolTolerance(cur, oldS)
      // 写路径（检查点备份 + 原子写 + 身份校验）对正常编辑与 P1-C 回退共用；
      // 护栏次序保持不变：backupIfEnabled → safeAtomicWrite → recordFileStateAfterWrite。
      const applyAndWrite = async (oldForEdit: string, extraData?: Record<string, unknown>): Promise<ToolExecutorResult> => {
        const next = applyEditWithEolTolerance(cur, oldForEdit, newS, replaceAll)
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
            ...(ctx.writeExecutionPermit ? { expectedParentIdentity: ctx.writeExecutionPermit.target.parentIdentity } : {}),
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
          data: { path: rel, bytesWritten: Buffer.byteLength(next, 'utf8'), ...extraData },
          duration: Date.now() - started
        }
      }
      // P1-C：显式开启 tolerate_escape_layer 时，先尝试转义归一后的唯一命中回退；
      // 恰好一个变体命中才执行，其余情况一律走诊断分支，匹配语义保持确定性。
      if (occ === 0 && oldS !== '' && input.tolerate_escape_layer === true) {
        const hit = applyEditWithEscapeTolerance(cur, oldS)
        if (hit) {
          const submitRun = (normalizeLineEndingsForMatch(oldS).match(/\\+/g) ?? []).reduce((n, r) => n + r.length, 0)
          return await applyAndWrite(hit.variant, {
            matchedVariant: { kind: hit.kind, backslashRunDelta: hit.backslashRunDelta },
            notice: hit.kind === 'escape-layer'
              ? `已按转义层归一匹配（提交 ${submitRun} 个反斜杠，文件 ${submitRun + hit.backslashRunDelta} 个）`
              : '已按字面换行归一匹配（字面 \\n 与真实换行视为等价）'
          })
        }
      }
      if (occ === 0 && oldS !== '') {
        // P0-A/P0-B/P1-E：结构化诊断 + 可用性预检后的建议片段 + 恢复路径提示（§5.1/§5.2/§5.5）。
        // error 为稳定错误码（投影层原样保留），userMessage 保持原文案以兼容展示层。
        const diagnosis = diagnoseMissingOldString(cur, oldS)
        return {
          success: false,
          error: ErrorCodes.EDIT_OLD_STRING_NOT_FOUND,
          userMessage: '未找到待替换的字符串',
          data: { diagnosis },
          duration: Date.now() - started
        }
      }
      if (!replaceAll && oldS !== '' && occ > 1) {
        return { success: false, error: '找到多个匹配，请提供更精确的上下文或使用 replace_all', duration: Date.now() - started }
      }
      return await applyAndWrite(oldS)
    } finally {
      dispose()
    }
  }
}

export const writeFileExecutor: ToolExecutor = {
  name: 'write_file',
  resourceKeys: (input, context) => workspaceResourceKeys(input, context, 'write'),
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const rel = extractPathField(input)
    if (rel === undefined) {
      return { success: false, error: toolErrMissingPath('write_file'), duration: Date.now() - started }
    }
    const content = typeof input.content === 'string' ? input.content : ''
    ctx.sendProgress('writing', '正在写入文件...')
    const { signal: op, dispose } = combineUserAbortAndTimeout(ctx.signal)
    try {
      let writeTarget: Awaited<ReturnType<typeof resolveSafeWriteTarget>>
      try {
        writeTarget = await resolveWriteTargetFromPermit(input, ctx, 'write_file')
      } catch (e) {
        if (ctx.lane === 'desktop') return { ...writePermitFailure(e), duration: Date.now() - started }
        return { ...writePermitFailure(e), error: writePathErrorMessage(e, rel), duration: Date.now() - started }
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
          if (ctx.lane === 'desktop' && !capturedIdentityMatchesPermit(ctx, expectedIdentity)) {
            return { ...writePermitFailure(new Error('write-target-identity-mismatch')), duration: Date.now() - started }
          }
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
            '文件已被外部程序修改，请重新读取后再写入',
            ctx.fileStateCache
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
          ...(ctx.writeExecutionPermit ? { expectedParentIdentity: ctx.writeExecutionPermit.target.parentIdentity } : {}),
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
  | { kind: 'unavailable'; reason: Exclude<RipgrepUnavailableReason, 'unsupported' | 'not_file'> }
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

export function createGrepRipgrepUnavailableDiagnostic(
  resolved: Pick<ReturnType<typeof resolveRipgrepBinary>, 'source' | 'platform' | 'arch'>,
  reason: RipgrepUnavailableReason
): string {
  return `source=${resolved.source};platform=${resolved.platform};arch=${resolved.arch};status=unavailable;reason=${reason}`
}

function mapOpenedFileGrepOutput(output: string, filePath: string, outputMode: GrepExecArgs['outputMode']): string {
  const stdinNames = ['<stdin>', '/dev/fd/3', '-']
  return output.split('\n').map((line) => {
    for (const stdinName of stdinNames) {
      if (outputMode === 'files_with_matches' && line === stdinName) return filePath
      if (outputMode === 'count') {
        const count = line.startsWith(`${stdinName}:`) ? line.slice(stdinName.length + 1) : ''
        if (/^\d+$/.test(count)) return `${filePath}:${count}`
      }
      if (outputMode === 'content' && (line.startsWith(`${stdinName}:`) || line.startsWith(`${stdinName}-`))) {
        return `${filePath}${line.slice(stdinName.length)}`
      }
    }
    return line
  }).join('\n')
}

export function grepRipgrepUnavailableUserMessage(
  resolved: Pick<ReturnType<typeof resolveRipgrepBinary>, 'source' | 'platform' | 'arch'>,
  reason: RipgrepUnavailableReason
): string {
  if (resolved.source === 'development') {
    return `开发态内置 ripgrep 未准备（${reason}）。请执行 npm run prepare:rg -- --target=${resolved.platform}-${resolved.arch} 后重启应用。`
  }
  return `内置 ripgrep 不可用（${reason}）。请重新安装应用后重试。`
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
  spawnProcess: (binary: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess = spawn,
  openedFile?: { fileHandle: FileHandle; platform?: NodeJS.Platform }
): Promise<RipgrepRunResult> {
  if (signal.aborted) return { kind: 'cancelled', partialOutput: '' }
  const openedFileFd = openedFile?.fileHandle.fd
  const stableFilePlatform = openedFile?.platform ?? process.platform
  const stableFileOnWindows = openedFileFd !== undefined && stableFilePlatform === 'win32'
  const rgArgs = ['--no-config', '--color', 'never', '--regexp', pattern]
  if (args.ignoreCase) rgArgs.push('-i')
  if (args.glob) {
    rgArgs.push('--glob', args.glob)
  }
  if (args.outputMode === 'files_with_matches') rgArgs.push('-l')
  else if (args.outputMode === 'count') rgArgs.push('--count', '--with-filename')
  else {
    if (stableFileOnWindows) rgArgs.push('--with-filename')
    if (args.showLineNumber !== false) rgArgs.push('-n')
    else rgArgs.push('--no-line-number')
    if (args.context != null && args.context > 0) rgArgs.push('-C', String(args.context))
    if (args.multiline) rgArgs.push('-U', '--multiline-dotall')
  }
  rgArgs.push('--max-columns', '500')
  for (const d of GREP_SKIP_DIRS) rgArgs.push('--glob', `!**/${d}/**`)
  // 有读取许可时只从已打开目标读取：类 Unix 继承 fd，Windows 通过 stdin 流传递句柄内容。
  rgArgs.push(stableFileOnWindows ? '-' : openedFileFd !== undefined ? '/dev/fd/3' : searchPath)
  return await new Promise((resolve) => {
    const proc = spawnProcess(binaryPath, rgArgs, {
      cwd: workDir,
      windowsHide: true,
      ...(stableFileOnWindows ? { stdio: ['pipe', 'pipe', 'pipe'] } : openedFileFd !== undefined ? { stdio: ['ignore', 'pipe', 'pipe', openedFileFd] } : {})
    })
    let settled = false
    let stableInputStream: ReturnType<FileHandle['createReadStream']> | undefined
    let out = ''
    let stderr = ''
    let killed = false
    let truncated = false
    // §12-#5：ripgrep 输出其自身决定编码（正常为 UTF-8），契约显式声明为 utf8 并保留探测兜底；
    // 跨 chunk 的多字节字符由流式解码器保状态，不再逐 chunk toString('utf8')。
    const stdoutDecoder = createChildStreamDecoder({ contract: UTF8_CONTRACT })
    const stderrDecoder = createChildStreamDecoder({ contract: UTF8_CONTRACT })
    let stdoutRawBytes = 0
    const STDOUT_RAW_LIMIT = 400 * 1024
    const STDERR_RAW_LIMIT = 16 * 1024
    let stderrRawBytes = 0
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
      stdoutRawBytes += ch.length
      // 截断发生在原始字节层：超出上限后不再继续交付，避免把多字节字符切成 U+FFFD。
      if (stdoutRawBytes <= STDOUT_RAW_LIMIT) {
        out += stdoutDecoder.write(ch)
      } else if (!truncated) {
        truncated = true
        out += stdoutDecoder.end()
      }
      onProgress(`搜索中...`)
    })
    proc.stderr?.on('data', (ch: Buffer) => {
      stderrRawBytes += ch.length
      if (stderrRawBytes <= STDERR_RAW_LIMIT) stderr += stderrDecoder.write(ch)
    })
    const finish = (result: RipgrepRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      stableInputStream?.destroy()
      resolve(result)
    }
    proc.on('error', (err) => {
      finish({ kind: 'unavailable', reason: classifyRipgrepSpawnError(err as NodeJS.ErrnoException) })
    })
    proc.on('close', (code) => {
      if (!truncated) {
        out += stdoutDecoder.end()
      }
      // MINOR：stdout 截断只应影响 stdout；stderr 的尾部仍必须 flush，
      // 否则「挂死/超限前写出的错误信息」会丢掉未完成的多字节尾巴。
      stderr += stderrDecoder.end()
      if (signal.aborted) finish({ kind: 'cancelled', partialOutput: out.trimEnd() })
      else if (killed) finish({ kind: 'timeout', partialOutput: out.trimEnd() })
      else if (code !== 0 && code !== 1) finish({ kind: 'failed', exitCode: code, message: sanitizeToolOutputText(stderr.trim().slice(0, 4000) || 'ripgrep 返回非成功状态', 'grep') })
      else {
        let result = out.trimEnd()
        if (openedFile) result = mapOpenedFileGrepOutput(result, searchPath, args.outputMode)
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
    if (stableFileOnWindows && openedFile) {
      stableInputStream = openedFile.fileHandle.createReadStream({ autoClose: false, start: 0 })
      stableInputStream.on('error', (error) => {
        if (!settled) finish({ kind: 'failed', exitCode: null, message: sanitizeToolOutputText(error.message, 'grep') })
      })
      proc.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        if (!settled && error.code !== 'EPIPE') finish({ kind: 'failed', exitCode: null, message: sanitizeToolOutputText(error.message, 'grep') })
      })
      stableInputStream.pipe(proc.stdin!)
    }
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
  resourceKeys: (input, context) => workspaceResourceKeys(input, context, 'read'),
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
    let permitFileHandle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      const permitted = await resolveReadPermitTarget('grep', input, ctx)
      if (!permitted.ok) return { success: false, error: permitted.caseId === 'read-permit-missing' ? '读取许可缺失，未执行搜索' : '读取许可校验失败', diagnostic: { caseId: permitted.caseId, retryable: false, category: permitted.failureClass, ...(permitted.factId ? { factId: permitted.factId } : {}) }, duration: Date.now() - started }
      absSearch = permitted.path
      permitFileHandle = permitted.fileHandle
    } catch { return { success: false, error: '读取许可校验失败', diagnostic: { caseId: 'read-permit-validation-error', retryable: false, category: 'integration-violation' }, duration: Date.now() - started } }
    try {
      const timeoutMs = (ctx.toolsConfig.grepTimeoutSec ?? 60) * 1000
      const gargs: GrepExecArgs = { glob, outputMode, ignoreCase, showLineNumber, context, multiline, headLimit }
      const resolved = resolveRipgrepBinary({
        packaged: app?.isPackaged ?? false,
        resourcesPath: process.resourcesPath,
        // Electron 开发态的 app path 是 worktree 根目录；不要依赖测试/打包转换后的 __dirname 形态。
        developmentRoot: app?.isPackaged ? undefined : app?.getAppPath?.() ?? path.resolve(__dirname, '../../..'),
        platform: process.platform,
        arch: process.arch
      })
      void ctx.recordDiagnostic?.({
        code: 'grep-ripgrep',
        message: createGrepRipgrepDiagnostic(resolved)
      })
      if (!resolved.path) {
        void ctx.recordDiagnostic?.({
          code: 'grep-ripgrep-unavailable',
          message: createGrepRipgrepUnavailableDiagnostic(resolved, resolved.reason ?? 'unsupported')
        })
        return { success: false, error: grepRipgrepUnavailableUserMessage(resolved, resolved.reason ?? 'unsupported'), duration: Date.now() - started }
      }
      const availability = await inspectRipgrepBinary(resolved)
      if (!availability.available) {
        void ctx.recordDiagnostic?.({
          code: 'grep-ripgrep-unavailable',
          message: createGrepRipgrepUnavailableDiagnostic(resolved, availability.reason)
        })
        return { success: false, error: grepRipgrepUnavailableUserMessage(resolved, availability.reason), duration: Date.now() - started }
      }
      const text = await grepWithRg(
        resolved.path,
        ctx.workDir,
        absSearch,
        pattern,
        gargs,
        timeoutMs,
        ctx.signal,
        (message) => ctx.sendProgress('grep', message),
        ctx.grepSpawnProcess,
        permitFileHandle ? { fileHandle: permitFileHandle, platform: process.platform } : undefined
      )
      if (text.kind === 'success' || text.kind === 'no_match') {
        return { success: true, data: { output: text.output }, duration: Date.now() - started }
      }
      if (text.kind === 'unavailable') {
        void ctx.recordDiagnostic?.({
          code: 'grep-ripgrep-unavailable',
          message: createGrepRipgrepUnavailableDiagnostic(resolved, text.reason)
        })
        return { success: false, error: grepRipgrepUnavailableUserMessage(resolved, text.reason), duration: Date.now() - started }
      }
      if (text.kind === 'cancelled') return { success: false, error: `${text.partialOutput}\n[已取消]`, duration: Date.now() - started }
      if (text.kind === 'timeout') return { success: false, error: `${text.partialOutput}\n[搜索超时，仅展示部分结果]`, duration: Date.now() - started }
      return { success: false, error: text.message, duration: Date.now() - started }
    } finally {
      await permitFileHandle?.close().catch(() => undefined)
    }
  }
}

/** 产品默认解释器命令，与 DEFAULT_TOOLS_CONFIG.pythonPath 保持一致。 */
const DEFAULT_PYTHON_PATH = 'python'
/** 默认解释器不可用时的候选顺序，按产品目标平台给出。 */
const PYTHON_FALLBACK_CANDIDATES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: ['py', 'python3'],
  darwin: ['python3'],
  linux: ['python3']
}
const PYTHON_PROBE_TIMEOUT_MS = 5_000

export type PythonInterpreterResolution = {
  /** 本次实际使用的解释器命令 */
  command: string
  /** 发生回退时被替换掉的原始命令 */
  fallbackFrom?: string
}
export type PythonInterpreterProbe = (command: string) => Promise<boolean>

/** 只问版本、绝不执行用户代码：回退判定必须发生在运行脚本之前，避免二次执行副作用。 */
async function probePythonInterpreter(command: string): Promise<boolean> {
  const probe = await runCommandWithTimeout(command, ['--version'], PYTHON_PROBE_TIMEOUT_MS)
  return probe.completed && probe.code === 0
}

/**
 * 解析本次 run_script 使用的解释器。
 *
 * 只有"未配置或仍是产品默认值 python"时才启用回退：Windows 上 `python` 常被
 * Microsoft Store 别名占用（stub 以 9009 退出且不会执行用户代码），真实解释器往往
 * 只注册了 `py`；macOS 新版本则通常只有 `python3`。显式配置的自定义解释器失败时
 * 按原样返回，让用户看到自己的配置问题，而不是被静默替换。
 */
export async function resolvePythonInterpreter(
  configured?: string,
  options: { platform?: NodeJS.Platform; probe?: PythonInterpreterProbe } = {}
): Promise<PythonInterpreterResolution> {
  const command = configured?.trim() || DEFAULT_PYTHON_PATH
  if (command !== DEFAULT_PYTHON_PATH) return { command }
  const probe = options.probe ?? probePythonInterpreter
  if (await probe(command)) return { command }
  for (const candidate of PYTHON_FALLBACK_CANDIDATES[options.platform ?? process.platform] ?? []) {
    if (await probe(candidate)) return { command: candidate, fallbackFrom: command }
  }
  return { command }
}

export const runScriptExecutor: ToolExecutor = {
  name: 'run_script',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const code = typeof input.code === 'string' ? input.code : ''
    let language: ReturnType<typeof normalizeRunScriptLanguage>
    try {
      language = normalizeRunScriptLanguage(input.language)
    } catch {
      return { success: false, error: 'UNSUPPORTED_SCRIPT_LANGUAGE', diagnostic: { caseId: 'unsupported-script-language', category: 'executor', retryable: false }, duration: Date.now() - started }
    }
    const timeoutSec = typeof input.timeout === 'number' ? input.timeout : ctx.toolsConfig.scriptTimeout
    let command: string
    let commandArgs: string[]
    let interpreterName: string
    let fallbackFrom: string | undefined
    try {
      if (language === 'python') {
        const interpreter = await resolvePythonInterpreter(ctx.toolsConfig.pythonPath)
        command = interpreter.command
        commandArgs = ['-c', code]
        interpreterName = 'python'
        fallbackFrom = interpreter.fallbackFrom
      } else {
        const launch = resolveNonPythonScriptLaunch(language, code, ctx.toolsConfig.scriptInterpreterPaths)
        command = launch.command
        commandArgs = launch.args
        interpreterName = launch.interpreterName
      }
    } catch (error) {
      const caseId = error instanceof Error ? error.message : 'script-launch-preparation-failed'
      return { success: false, error: caseId, diagnostic: { caseId: caseId.toLowerCase().replace(/_/g, '-'), category: 'executor', retryable: false }, duration: Date.now() - started }
    }
    ctx.sendProgress('script', fallbackFrom ? `未找到 ${fallbackFrom}，改用 ${command} 启动 Python...` : `启动 ${interpreterName}...`)
    const env = buildPythonScriptEnv()
    // §7.5 / §12-#6：宿主侧已用 PYTHONUTF8=1 与 PYTHONIOENCODING=utf-8 钉死契约，这里显式登记同一契约。
    const stdoutDecoder = createChildStreamDecoder({ contract: UTF8_CONTRACT })
    const stderrDecoder = createChildStreamDecoder({ contract: UTF8_CONTRACT })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    // P0-D3 组 1（§5.4.3 缺口）：run_script 此前没有执行期埋点，"成功路径"无事后证据。
    // 事件字段与 shell.exec.* 对齐；code 传原始值、指纹化由投影层负责（评审观察项 5，
    // 与 run_shell 的 command 同模式）；env 只留键计数与哈希（组 5）。
    const scriptBaseLog = {
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      toolUseId: ctx.toolUseId,
      language,
      code,
      interpreter: path.basename(command),
      timeoutSec,
      envKeyCount: 0,
      envKeysSha256: '',
      envEntriesSha256: ''
    }
    const envSnapshot = snapshotEnvForLog(env)
    scriptBaseLog.envKeyCount = envSnapshot.keyCount
    scriptBaseLog.envKeysSha256 = envSnapshot.keysSha256
    scriptBaseLog.envEntriesSha256 = envSnapshot.entriesSha256
    logAgentEvent('info', 'script.exec.start', scriptBaseLog)
    return await new Promise((resolve) => {
      const proc = spawn(command, commandArgs, {
        cwd: ctx.workDir,
        env,
        windowsHide: true,
        shell: false
      })
      logAgentEvent('info', 'script.exec.spawned', { ...scriptBaseLog, pid: proc.pid ?? null })
      const supervisor = new ProcessSupervisor(proc, processTreeKiller)
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
        timedOut = true
        void supervisor.terminate()
      }, timeoutSec * 1000)
      const onAbort = () => {
        void supervisor.terminate()
      }
      ctx.signal.addEventListener('abort', onAbort)
      proc.on('error', (err) => {
        clearTimeout(killTimer)
        ctx.signal.removeEventListener('abort', onAbort)
        logAgentEvent('error', 'script.exec.finish', {
          ...scriptBaseLog,
          pid: proc.pid ?? null,
          exitCode: null,
          status: 'spawn_failed',
          success: false,
          error: 'SCRIPT_SPAWN_ERROR',
          durationMs: Date.now() - started
        })
        resolve({
          success: false,
          error: 'SCRIPT_SPAWN_ERROR',
          userMessage: toToolUserError(err, { toolName: 'run_script', scriptLanguage: language }),
          data: { processResult: null, status: 'spawn_failed', executable: command, cwd: '<workdir>' },
          duration: Date.now() - started
        })
      })
      proc.on('close', (code, signal) => {
        clearTimeout(killTimer)
        ctx.signal.removeEventListener('abort', onAbort)
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
        const stdoutSafe = sanitizeToolOutput(stdout, 'run_script')
        const stderrSafe = sanitizeToolOutput(stderr, 'run_script')
        const status = ctx.signal.aborted ? 'cancelled' : timedOut ? 'timed_out' : signal ? 'signalled' : code === 0 ? 'succeeded' : 'failed'
        const data = {
          stdout: stdoutSafe.text,
          stderr: stderrSafe.text,
          exitCode: signal ? null : code,
          signal: signal ?? undefined,
          status,
          terminationReason: ctx.signal.aborted ? 'user_cancel' : timedOut ? 'timeout' : signal ? 'external_signal' : 'process_exit'
        }
        // P0-D3 组 1：finish 与 shell.exec.finish 字段对齐（exitCode/status/字节口径/时长），
        // 文本正文与秘密不落盘（allowlist 之外的 stdout/stderr 会被丢弃）。
        logAgentEvent(status === 'succeeded' ? 'info' : 'warn', 'script.exec.finish', {
          ...scriptBaseLog,
          pid: proc.pid ?? null,
          exitCode: signal ? null : code,
          signal: signal ?? undefined,
          status,
          success: status === 'succeeded',
          interrupted: ctx.signal.aborted,
          timedOut,
          cancelled: ctx.signal.aborted,
          stdoutBytes: Buffer.byteLength(stdoutSafe.text, 'utf8'),
          stderrBytes: Buffer.byteLength(stderrSafe.text, 'utf8'),
          stdoutRedacted: stdoutSafe.redacted,
          stderrRedacted: stderrSafe.redacted,
          durationMs: Date.now() - started
        })
        if (ctx.signal.aborted) {
          resolve({ success: false, error: 'SCRIPT_CANCELLED', userMessage: '用户取消执行', data, duration: Date.now() - started })
          return
        }
        if (timedOut) {
          resolve({ success: false, error: 'SCRIPT_TIMEOUT', userMessage: `脚本执行超时（${timeoutSec} 秒）`, data, duration: Date.now() - started })
          return
        }
        if (code !== 0 || signal) {
          const failMsg = `脚本执行失败（退出码: ${code}）\n${stderr}`
          resolve({
            success: false,
            error: 'SCRIPT_PROCESS_EXIT',
            userMessage: toToolUserError(new Error(failMsg), { toolName: 'run_script', scriptLanguage: language }),
            data,
            duration: Date.now() - started
          })
        } else {
          resolve({ success: true, data, duration: Date.now() - started })
        }
      })
    })
  }
}

/**
 * 内置工具注册表(A2,偏差 18):registry 随 runtime 实例走——
 * 工厂每次构建全新 registry(工具定义与 executor 为模块级无状态纯函数,可安全共享引用)。
 */
export function createBuiltinToolRegistry(): TypedToolRegistry {
  const registry = new TypedToolRegistry()
  registry.register(runShellRegisteredTool)
  registry.register(skillsReadTool)
  registry.register(historyReadTool)
  // toolkit 网关：能力集合的两个稳定工具（browser_detect 已收编为 env.browserDetect 能力）
  registry.register(toolkitFindTool)
  registry.register(toolkitCallTool)
  for (const executor of [
    readFileExecutor,
    listDirectoryExecutor,
    editFileExecutor,
    writeFileExecutor,
    grepExecutor,
    runScriptExecutor,
    runLarkCliExecutor,
    readFeishuAttachmentExecutor,
    wechatReplyExecutor,
    wechatSendExecutor,
    browserExecutor,
    runShellExecutor,
    listWorkDirsExecutor,
    switchWorkDirExecutor,
    switchSessionExecutor
  ]) {
    registry.registerLegacyExecutor(executor)
  }
  return registry
}

/** @deprecated 兼容转发(偏差 18,一个发布周期,P8 评估删除):经默认 runtime 实例。 */
export function getToolExecutor(name: string): ToolExecutor | undefined {
  return getDefaultAgentRuntime().builtinRegistry.getLegacyExecutor(name) as ToolExecutor | undefined
}

/** @deprecated 兼容转发(偏差 18)。 */
export function getRegisteredTool(name: string): import('./plannedToolRegistry').RegisteredTool | undefined {
  return getDefaultAgentRuntime().builtinRegistry.get(name) as import('./plannedToolRegistry').RegisteredTool | undefined
}
