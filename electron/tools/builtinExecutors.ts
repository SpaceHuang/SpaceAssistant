import { createHash } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { Worker } from 'node:worker_threads'
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
  SafeAtomicWriteUncertainError,
  type FileIdentity
} from '../safeAtomicWrite'
import { resolveReadPermitTarget } from '../confirmation/readPermitExecutor'
import { recordPolicyExecutionVeto } from '../confirmation/audit'
import { readDirectoryBoundToIdentity } from '../confirmation/directoryHandleReader'
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
import { ProcessSupervisor, type ProcessKiller, type ProcessTerminationResult } from '../shell/processSupervisor'
import { snapshotEnvForLog } from '../shell/envSnapshot'
import { logAgentEvent } from '../agentLogger/agentLogger'
import {
  classifyRipgrepSpawnError,
  inspectRipgrepBinary,
  resolveRipgrepBinary,
  type RipgrepUnavailableReason
} from './ripgrepBinary'
import { planGrepInvocation, formatGrepNoMatchOutput, type GrepScope } from './grepScope'
import { isSensitivePath } from '../shell/shellSensitivePaths'
import { runLarkCliExecutor } from './runLarkCliExecutor'
import { readFeishuAttachmentExecutor } from './readFeishuAttachmentExecutor'
import { wechatReplyExecutor, wechatSendExecutor } from './wechatExecutors'
import { browserExecutor } from './browserExecutor'
import { runShellExecutor } from './runShellExecutor'
import { TypedToolRegistry } from './plannedToolRegistry'
import { runShellRegisteredTool } from './runShellRegisteredTool'
import { createRunScriptRegisteredTool } from './runScriptRegisteredTool'
import { createReadRegisteredTools } from './readRegisteredTools'
import { createWriteFileRegisteredTools } from './writeFileRegisteredTools'
import { createSwitchWorkDirRegisteredTool } from './workDirRegisteredTools'
import { createSwitchSessionRegisteredTool } from './remoteSessionRegisteredTools'
import { createBrowserRegisteredTool } from './browserRegisteredTool'
import { createWeChatOutboundRegisteredTools } from './wechatOutboundRegisteredTools'
import { createRunLarkCliRegisteredTool } from './runLarkCliRegisteredTool'
import { createListWorkDirsRegisteredTool } from './listWorkDirsRegisteredTool'
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
const GREP_FILE_MAX = 2 * 1024 * 1024
const GREP_REGEX_FILE_TIMEOUT_MS = 250
const GREP_FALLBACK_SAMPLE_MAX = 5
type GrepFallbackDeps = {
  stat?: (file: string) => Promise<{ size: number; isFile: () => boolean }>
  readFile?: (file: string, options?: { signal?: AbortSignal }) => Promise<Buffer>
  readdir?: (dir: string) => Promise<Dirent[]>
  now?: () => number
}
const GREP_REGEX_WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, pattern, flags, text, multiline, mode, matchLimit, validateOnly }) => {
  try {
    const regex = new RegExp(pattern, flags);
    if (validateOnly) {
      parentPort.postMessage({ id, ok: true, count: 0, matches: [] });
      return;
    }
    const matches = [];
    let count = 0;
    const add = (match, lineIndex) => {
      count++;
      if (mode === 'content') matches.push({ index: match.index, text: match[0], lineIndex });
    };
    if (multiline) {
      let match;
      while ((match = regex.exec(text)) !== null) {
        add(match, undefined);
        if (matchLimit > 0 && count >= matchLimit) break;
        if (match[0].length === 0) regex.lastIndex++;
      }
    } else {
      const lines = text.split(/\\r?\\n/);
      let offset = 0;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        regex.lastIndex = 0;
        const match = regex.exec(line);
        if (match) {
          add({ index: offset + match.index, 0: line }, lineIndex);
          if (matchLimit > 0 && count >= matchLimit) break;
        }
        offset += line.length + (text.slice(offset + line.length, offset + line.length + 2) === '\\r\\n' ? 2 : text[offset + line.length] === '\\n' ? 1 : 0);
      }
    }
    parentPort.postMessage({ id, ok: true, count, matches });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`
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

function readIdentityMatches(stat: Pick<Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>, 'dev' | 'ino' | 'mode' | 'size' | 'mtimeMs'>, identity: NonNullable<NonNullable<ToolExecutionContext['readExecutionPermit']>['targets'][number]['identity']>): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino && stat.mode === identity.mode && stat.size === identity.size && stat.mtimeMs === identity.mtimeMs
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
      const authorizedIdentity = ctx.readExecutionPermit?.targets[0]?.identity
      const identityChanged = (caseId: 'read-target-identity-changed' | 'read-target-identity-changed-during-read'): ToolExecutorResult => {
        recordPolicyExecutionVeto({ audit: ctx.audit, lane: (ctx.lane as import('../../src/shared/confirmation/types').ExecutionLane | undefined) ?? 'desktop', sessionId: ctx.sessionId, requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'read_file', decisionRuleId: ctx.readExecutionPermit?.decisionRuleId ?? ctx.readExecutionPermit?.targets[0]?.decisionRuleId, pathZone: ctx.readExecutionPermit?.targets[0]?.zone, factId: ctx.readExecutionPermit?.targets[0]?.factId, failureClass: 'mechanism', caseId })
        return { success: false, error: '读取期间文件身份或内容发生变化，已丢弃读取结果。', diagnostic: { caseId, retryable: false, category: 'mechanism', ...(ctx.readExecutionPermit?.targets[0]?.factId ? { factId: ctx.readExecutionPermit.targets[0].factId } : {}) }, duration: Date.now() - started }
      }
      if (permitFileHandle && authorizedIdentity && !readIdentityMatches(st, authorizedIdentity)) return identityChanged('read-target-identity-changed')
      const validateAfterRead = async (): Promise<ToolExecutorResult | undefined> => {
        if (!permitFileHandle || !authorizedIdentity) return undefined
        const after = await permitFileHandle.stat()
        return readIdentityMatches(after, authorizedIdentity) ? undefined : identityChanged('read-target-identity-changed-during-read')
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
          const abortResult = fileToolAbortResult(op, '读取超时，请检查文件路径或网络连接', started)
          if (abortResult) return abortResult
          const changed = await validateAfterRead()
          if (changed) return changed
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
          const abortResult = fileToolAbortResult(op, '读取超时，请检查文件路径或网络连接', started)
          if (abortResult) return abortResult
          const changed = await validateAfterRead()
          if (changed) return changed
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
        const buf = permitFileHandle ? await permitFileHandle.readFile({ signal: op }) : await fs.readFile(abs, { signal: op })
        const abortResult = fileToolAbortResult(op, '读取超时，请检查文件路径或网络连接', started)
        if (abortResult) return abortResult
        const changed = await validateAfterRead()
        if (changed) return changed
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

/**
 * R8：目录错误四分类（机器可读 data.errorClass；文案由渲染端 errorTranslator 取 i18n）。
 * 未知错误一律归 ACCESS_DENIED——最保守且可解释的一类，不新增第五种文案（D.4）。
 */
export type DirectoryErrorClass =
  | 'PATH_OUTSIDE_WORKDIR'
  | 'PATH_NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'ACCESS_DENIED'
  | 'READ_TIMEOUT'

export function classifyDirectoryError(e: unknown): DirectoryErrorClass | 'ABORTED' {
  if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError') return 'ABORTED'
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'PATH_NOT_FOUND'
  if (code === 'EACCES' || code === 'EPERM') return 'ACCESS_DENIED'
  if (code === 'ENOTDIR') return 'NOT_A_DIRECTORY'
  return 'ACCESS_DENIED'
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
      // R8（融合）：结构化超时返回 + 前置 abort 检查；permit 通过后错误一律走五类分类出口
      const failedPath = typeof input.path === 'string' && input.path ? input.path : '.'
      const dirTimeoutResult = (): ToolExecutorResult => ({
        success: false,
        error: 'DIRECTORY_READ_TIMEOUT',
        data: { errorClass: 'READ_TIMEOUT' as const, path: failedPath, retryable: true },
        duration: Date.now() - started
      })
      if (op.aborted) return dirTimeoutResult()
      const target = permitted.path
      const root = path.resolve(ctx.workDir)
      const identity = ctx.readExecutionPermit?.targets[0]?.identity
      if (!identity) return { success: false, error: '目录读取许可缺少身份事实。', diagnostic: { caseId: 'read-directory-identity-missing', retryable: false, category: 'mechanism' }, duration: Date.now() - started }
      const snapshot = await readDirectoryBoundToIdentity(target, identity, op)
      if (!snapshot.ok) {
        if (snapshot.caseId === 'read-directory-cancelled') return dirTimeoutResult()
        const failureClass = snapshot.caseId === 'read-directory-identity-changed' ? 'mechanism' : 'environment'
        recordPolicyExecutionVeto({ audit: ctx.audit, lane: (ctx.lane as import('../../src/shared/confirmation/types').ExecutionLane | undefined) ?? 'desktop', sessionId: ctx.sessionId, requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'list_directory', decisionRuleId: ctx.readExecutionPermit?.decisionRuleId, pathZone: ctx.readExecutionPermit?.targets[0]?.zone, factId: ctx.readExecutionPermit?.targets[0]?.factId, failureClass, caseId: snapshot.caseId })
        return { success: false, error: snapshot.caseId === 'read-directory-identity-changed' ? '目录在许可校验后发生变化，已停止枚举。' : '目录不可用，已停止枚举。', diagnostic: { caseId: snapshot.caseId, retryable: false, category: failureClass }, duration: Date.now() - started }
      }
      const rows = snapshot.entries.map((entry) => {
        const entryPath = path.join(target, entry.name)
        return { name: entry.name, path: path.relative(root, entryPath) || '.', isDirectory: entry.isDirectory, ...(entry.size === undefined ? {} : { size: entry.size }), ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }) }
      })
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
    const writePermitAtStart = ctx.writeExecutionPermit
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
        if (ctx.writeExecutionPermit !== writePermitAtStart) {
          return { ...writePermitFailure(new Error('write-permit-changed-during-execution')), duration: Date.now() - started }
        }
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
          if (e instanceof SafeAtomicWriteUncertainError) throw e
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
    const writePermitAtStart = ctx.writeExecutionPermit
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
      if (ctx.writeExecutionPermit !== writePermitAtStart) {
        return { ...writePermitFailure(new Error('write-permit-changed-during-execution')), duration: Date.now() - started }
      }
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
        if (e instanceof SafeAtomicWriteUncertainError) throw e
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
  /** R6：对齐 ripgrep -uu（--no-ignore --hidden）；敏感路径不由此开关解除 */
  includeIgnored: boolean
}

export type RipgrepRunResult =
  | { kind: 'success'; output: string }
  | { kind: 'no_match'; output: 'No matches found' }
  | { kind: 'unavailable'; reason: Exclude<RipgrepUnavailableReason, 'unsupported' | 'not_file'> }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'timeout'; partialOutput: string; terminated?: 'graceful' | 'forced' }
  | { kind: 'cancelled'; partialOutput: string; terminated?: 'graceful' | 'forced' }
  | { kind: 'failed'; exitCode: number | null; message: string }

export type GrepTerminateInfo = {
  reason: 'abort' | 'timeout'
  terminated: 'graceful' | 'forced' | null
  elapsedMs: number
  treeKillVerified: boolean | null
  terminationState: ProcessTerminationResult['state'] | null
}

const GREP_TERMINATE_GRACE_MS = 1_500
const GREP_SETTLE_SLACK_MS = 500

/**
 * R7：grep 参数归一的唯一入口（校验层与执行层共用，判定按「生效值」而非「字段是否出现」）。
 * - 等价默认值（context=0 / multiline=false / show_line_number 任意值于非 content 模式）不报错；
 * - 有实际效果的冲突（非 content + context>0 / multiline=true）报 param-conflict 并给可执行建议。
 */
export type GrepNormalizeResult =
  | { ok: true; args: GrepExecArgs; effectful: string[] }
  | {
      ok: false
      error: { code: 'param-conflict'; field: string; mode: string; allowed: string; suggestedWrite: string }
    }

const GREP_MODES = ['files_with_matches', 'content', 'count'] as const

export function normalizeGrepArgs(input: Record<string, unknown>): GrepNormalizeResult {
  const outputMode = (typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches') as
    | (typeof GREP_MODES)[number]
    | string
  if (!GREP_MODES.includes(outputMode as (typeof GREP_MODES)[number])) {
    return {
      ok: false,
      error: {
        code: 'param-conflict',
        field: 'output_mode',
        mode: String(outputMode),
        allowed: 'files_with_matches | content | count',
        suggestedWrite: '去掉 output_mode 或改用 files_with_matches / content / count 之一'
      }
    }
  }
  const contextRaw = typeof input.context === 'number' ? input.context : undefined
  if (contextRaw !== undefined && (!Number.isInteger(contextRaw) || contextRaw < 0 || contextRaw > 1000)) {
    return {
      ok: false,
      error: {
        code: 'param-conflict',
        field: 'context',
        mode: outputMode,
        allowed: '0～1000 的整数',
        suggestedWrite: '去掉 context 或改为 0～1000 的整数'
      }
    }
  }
  const headLimit = typeof input.head_limit === 'number' ? input.head_limit : 100
  if (!Number.isInteger(headLimit) || headLimit < 0 || headLimit > 1_000_000) {
    return {
      ok: false,
      error: {
        code: 'param-conflict',
        field: 'head_limit',
        mode: outputMode,
        allowed: '0～1000000 的整数',
        suggestedWrite: '去掉 head_limit 或改为 0～1000000 的整数'
      }
    }
  }

  // 判定依据：生效值（>0 / true），不是「字段是否出现」。show_line_number 不计入冲突
  // （评审 P2-1：它只在 content 模式有效果，而 content 正是它适用的模式）。
  const effectful: string[] = []
  if (contextRaw !== undefined && contextRaw > 0) effectful.push(`context=${contextRaw}`)
  if (input.multiline === true) effectful.push('multiline=true')
  if (outputMode !== 'content' && effectful.length > 0) {
    return {
      ok: false,
      error: {
        code: 'param-conflict',
        field: effectful[0]!,
        mode: outputMode,
        allowed: '仅 output_mode=content 下生效',
        suggestedWrite: `改用 output_mode=content，或去掉 ${effectful.join(' / ')}`
      }
    }
  }

  return {
    ok: true,
    effectful,
    args: {
      glob: typeof input.glob === 'string' ? input.glob : undefined,
      outputMode,
      ignoreCase: Boolean(input.ignore_case),
      // 生效值只在 content 模式有意义；非 content 模式一律归一为「无效果」
      showLineNumber: outputMode === 'content' && input.show_line_number !== false,
      context: outputMode === 'content' ? contextRaw : undefined,
      multiline: outputMode === 'content' && Boolean(input.multiline),
      headLimit,
      includeIgnored: Boolean(input.include_ignored)
    }
  }
}

/** R7 兼容导出：薄壳——判定规则只有 normalizeGrepArgs 一份。 */
export function validateGrepInput(input: Record<string, unknown>): string | null {
  const r = normalizeGrepArgs(input)
  if (r.ok) return null
  const { field, mode, allowed, suggestedWrite } = r.error
  return `grep.paramConflict(${field};${mode};${allowed};${suggestedWrite})`
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
  const target = `${resolved.platform}-${resolved.arch}`
  const alternative = '替代路径：用 list_directory + read_file 逐层查看文件，或用 run_shell 调用系统搜索（Windows findstr / Select-String，macOS grep / mdfind）。'
  if (reason === 'resource_exhausted') {
    return `内置 ripgrep 本次启动失败（系统临时资源不足，通常稍后自行恢复），请稍后重试本次搜索。${alternative}`
  }
  if (reason === 'unsupported') {
    return `当前平台（${target}）不在内置 ripgrep 支持面内（支持 macOS x64/arm64、Windows x64），重装或重试均无效。${alternative}`
  }
  if (resolved.source === 'development') {
    const interception = reason === 'exec_format' || reason === 'spawn_failed'
      ? '若已准备仍失败，检查安全软件是否拦截了 rg。'
      : ''
    return `开发态内置 ripgrep 未就绪。请执行 npm run prepare:rg -- --target=${target} 后重启应用；新 worktree 首次 npm run dev 会自动准备。${interception}${alternative}`
  }
  if (reason === 'exec_format' || reason === 'spawn_failed') {
    const platformHint = resolved.platform === 'darwin'
      ? 'macOS 可在终端执行 xattr -cr（拖入本应用）去除隔离属性后重新打开。'
      : 'Windows 可在安全软件中将本应用的 rg 加入白名单后重试。'
    return `内置 ripgrep 未能启动，通常被安全软件/EDR 拦截。${platformHint}${alternative}`
  }
  return `内置 ripgrep 文件缺失或不可访问，通常被安全软件隔离或删除；请在安全软件的隔离区/白名单中恢复本应用的 rg 后重试，重装通常无效。${alternative}`
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
  openedFile?: { fileHandle: FileHandle; platform?: NodeJS.Platform },
  killer: ProcessKiller = processTreeKiller,
  onTerminate?: (info: GrepTerminateInfo) => void
): Promise<RipgrepRunResult> {
  if (signal.aborted) return { kind: 'cancelled', partialOutput: '' }
  const openedFileFd = openedFile?.fileHandle.fd
  const stableFilePlatform = openedFile?.platform ?? process.platform
  const stableFileOnWindows = openedFileFd !== undefined && stableFilePlatform === 'win32'
  // R6：范围规划由 planGrepInvocation 统一产出（显式路径解除 / --hidden / 敏感排除同源）
  const plan = planGrepInvocation({ workDir, searchPath, args })
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
  if (plan.hidden) rgArgs.push('--hidden')
  // D1（评审 2026-09-28）：glob 大小写无关（--iglob）——isSensitivePath 是小写化判定，
  // 大小写敏感的 --glob 会让 Secrets/、.ENV、NodeModules 等变体绕过排除。
  if (plan.caseInsensitiveGlobs) {
    for (const g of plan.ignoreGlobs) rgArgs.push('--iglob', g)
    for (const g of plan.sensitiveExcludes) rgArgs.push('--iglob', g)
  } else {
    for (const g of plan.ignoreGlobs) rgArgs.push('--glob', g)
    for (const g of plan.sensitiveExcludes) rgArgs.push('--glob', g)
  }
  // 有读取许可时只从已打开目标读取：类 Unix 继承 fd，Windows 通过 stdin 流传递句柄内容。
  rgArgs.push(stableFileOnWindows ? '-' : openedFileFd !== undefined ? '/dev/fd/3' : searchPath)
  return await new Promise((resolve) => {
    const proc = spawnProcess(binaryPath, rgArgs, {
      cwd: workDir,
      windowsHide: true,
      detached: process.platform === 'darwin',
      ...(stableFileOnWindows ? { stdio: ['pipe', 'pipe', 'pipe'] } : openedFileFd !== undefined ? { stdio: ['ignore', 'pipe', 'pipe', openedFileFd] } : {})
    })
    let settled = false
    let stableInputStream: ReturnType<FileHandle['createReadStream']> | undefined
    let out = ''
    let stderr = ''
    let truncated = false
    const supervisor = new ProcessSupervisor(proc, killer)
    let terminationReason: 'abort' | 'timeout' | null = null
    let terminationRequestedAt: number | undefined
    let terminationOutcome: ProcessTerminationResult | undefined
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    // §12-#5：ripgrep 输出其自身决定编码（正常为 UTF-8），契约显式声明为 utf8 并保留探测兜底；
    // 跨 chunk 的多字节字符由流式解码器保状态，不再逐 chunk toString('utf8')。
    const stdoutDecoder = createChildStreamDecoder({ contract: UTF8_CONTRACT })
    const stderrDecoder = createChildStreamDecoder({ contract: UTF8_CONTRACT })
    let stdoutRawBytes = 0
    const STDOUT_RAW_LIMIT = 400 * 1024
    const STDERR_RAW_LIMIT = 16 * 1024
    let stderrRawBytes = 0
    const requestTermination = (reason: 'abort' | 'timeout'): void => {
      if (settled) return
      if (terminationReason === null) {
        terminationReason = reason
        terminationRequestedAt = Date.now()
      }
      void supervisor.terminate(GREP_TERMINATE_GRACE_MS).then((result) => { terminationOutcome = result })
      if (settleTimer === undefined) {
        settleTimer = setTimeout(() => {
          if (settled) return
          finish({
            kind: terminationReason === 'timeout' ? 'timeout' : 'cancelled',
            partialOutput: out.trimEnd(),
            terminated: 'forced'
          })
        }, GREP_TERMINATE_GRACE_MS + GREP_SETTLE_SLACK_MS)
      }
    }
    const t = setTimeout(() => requestTermination('timeout'), timeoutMs)
    const onAbort = () => {
      requestTermination('abort')
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
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      signal.removeEventListener('abort', onAbort)
      stableInputStream?.destroy()
      proc.stdin?.destroy()
      proc.stdout?.destroy()
      proc.stderr?.destroy()
      if (terminationReason !== null && onTerminate) {
        const terminated = result.kind === 'cancelled' || result.kind === 'timeout' ? result.terminated ?? 'graceful' : null
        onTerminate({
          reason: terminationReason,
          terminated,
          elapsedMs: terminationRequestedAt !== undefined ? Date.now() - terminationRequestedAt : 0,
          treeKillVerified: terminationOutcome?.treeKillVerified ?? null,
          terminationState: terminationOutcome?.state ?? null
        })
      }
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
      if (terminationReason !== null) finish({
        kind: terminationReason === 'timeout' ? 'timeout' : 'cancelled',
        partialOutput: out.trimEnd(),
        terminated: 'graceful'
      })
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
  onProgress: (s: string) => void,
  timeoutMs = 60_000,
  stableFileHandle?: FileHandle,
  deps: GrepFallbackDeps = {}
): Promise<string> {
  let flags = 'g'
  if (args.ignoreCase) flags += 'i'
  if (args.multiline) flags += 's'
  const now = deps.now ?? Date.now
  const deadline = now() + Math.max(1, timeoutMs)
  let regexWorker: Worker | undefined
  let nextRegexJobId = 0
  let pendingRegexJob: {
    id: number
    resolve: (result: { count: number; matches: Array<{ index: number; text: string; lineIndex?: number }> }) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    abort: () => void
  } | undefined
  const terminateRegexWorker = (): void => {
    const worker = regexWorker
    regexWorker = undefined
    if (pendingRegexJob) {
      clearTimeout(pendingRegexJob.timer)
      signal.removeEventListener('abort', pendingRegexJob.abort)
      pendingRegexJob = undefined
    }
    if (worker) void worker.terminate()
  }
  const scanText = (text: string, matchLimit: number, validateOnly = false): Promise<{ count: number; matches: Array<{ index: number; text: string; lineIndex?: number }> }> => {
    if (signal.aborted) return Promise.resolve({ count: 0, matches: [] })
    const remainingMs = deadline - now()
    if (remainingMs <= 0) return Promise.reject(new Error('正则搜索总时间已超时'))
    regexWorker ??= new Worker(GREP_REGEX_WORKER_SOURCE, { eval: true })
    const worker = regexWorker
    const id = ++nextRegexJobId
    return new Promise((resolve, reject) => {
      const settle = (action: () => void): void => {
        if (!pendingRegexJob || pendingRegexJob.id !== id) return
        clearTimeout(pendingRegexJob.timer)
        signal.removeEventListener('abort', pendingRegexJob.abort)
        pendingRegexJob = undefined
        action()
      }
      const timer = setTimeout(() => {
        terminateRegexWorker()
        reject(new Error('单文件正则执行超时，已终止隔离扫描'))
      }, Math.min(GREP_REGEX_FILE_TIMEOUT_MS, remainingMs))
      const abort = (): void => {
        terminateRegexWorker()
        resolve({ count: 0, matches: [] })
      }
      pendingRegexJob = { id, resolve, reject, timer, abort }
      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', (result: { id: number; ok: boolean; count?: number; matches?: Array<{ index: number; text: string; lineIndex?: number }>; error?: string }) => {
        if (result.id !== id) return
        if (!result.ok) {
          settle(() => reject(new Error(result.error ?? '无效的正则表达式')))
          return
        }
        settle(() => resolve({ count: result.count ?? 0, matches: result.matches ?? [] }))
      })
      worker.once('error', (error) => settle(() => reject(error)))
      worker.postMessage({
        id, pattern, flags, text, multiline: args.multiline,
        mode: args.outputMode, matchLimit, validateOnly
      })
    })
  }
  const headLimit = args.headLimit <= 0 ? Infinity : args.headLimit
  const filesWithMatches: string[] = []
  const contentLines: string[] = []
  const counts = new Map<string, number>()
  let totalMatches = 0
  let filesScanned = 0
  let skippedTotal = 0
  let readErrorCount = 0
  const skippedSample: string[] = []
  const readErrorSample: string[] = []
  let timedOut = false
  let aborted = false
  const pastDeadline = (): boolean => { if (!timedOut && now() >= deadline) timedOut = true; return timedOut }
  const shouldStop = (): boolean => { if (signal.aborted) aborted = true; return aborted || pastDeadline() }
  const noteReadError = (rel: string): void => { readErrorCount++; if (readErrorSample.length < GREP_FALLBACK_SAMPLE_MAX) readErrorSample.push(rel) }

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
    const wildcardMatch = (pattern: string, value: string): boolean => {
      const p = pattern.toLowerCase()
      const v = value.toLowerCase()
      let pi = 0
      let vi = 0
      let starIndex = -1
      let starCanMatchSlash = false
      let starValueIndex = 0
      let starNextPatternIndex = 0
      while (vi < v.length) {
        if (pi < p.length && (p[pi] === '?' || p[pi] === v[vi])) {
          pi++
          vi++
        } else if (p[pi] === '*') {
          const doubleStar = p[pi + 1] === '*'
          starIndex = pi
          starCanMatchSlash = doubleStar
          pi += doubleStar ? 2 : 1
          starNextPatternIndex = pi
          starValueIndex = vi
        } else if (starIndex >= 0 && (starCanMatchSlash || v[starValueIndex] !== '/')) {
          starValueIndex++
          vi = starValueIndex
          pi = starNextPatternIndex
        } else {
          return false
        }
      }
      while (p[pi] === '*') pi++
      return pi === p.length
    }
    return (rel: string): boolean => {
      const p = toPosix(rel)
      const base = p.slice(p.lastIndexOf('/') + 1)
      const pattern = toPosix(g)
      return wildcardMatch(pattern, p) || wildcardMatch(pattern, base)
    }
  }

  const globMatcher = buildGlobMatcher(args.glob)
  const matchesGlob = (rel: string, applyGlob: boolean): boolean =>
    !applyGlob || !globMatcher || globMatcher(rel)

  async function scanFile(full: string, applyGlob: boolean): Promise<void> {
    if (shouldStop()) return
    const rel = path.relative(workDir, full)
    if (!matchesGlob(rel, applyGlob)) return
    filesScanned++
    if (filesScanned % 30 === 0) onProgress(`搜索中... 已扫描 ${filesScanned} 个文件`)
    let buf: Buffer
    if (stableFileHandle && !applyGlob && path.resolve(full) === path.resolve(absSearch)) {
      let before: Awaited<ReturnType<FileHandle['stat']>>
      try { before = await stableFileHandle.stat() } catch { noteReadError(rel); return }
      if (!before.isFile()) { noteReadError(rel); return }
      if (before.size > GREP_FILE_MAX) { skippedTotal++; if (skippedSample.length < GREP_FALLBACK_SAMPLE_MAX) skippedSample.push(rel); return }
      buf = Buffer.alloc(before.size)
      let offset = 0
      while (offset < buf.length) {
        const { bytesRead } = await stableFileHandle.read(buf, offset, buf.length - offset, offset)
        if (bytesRead <= 0) break
        offset += bytesRead
      }
      if (offset !== buf.length) { noteReadError(rel); return }
      const after = await stableFileHandle.stat()
      if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('搜索期间获准文件发生变化，已丢弃搜索结果')
      }
    } else {
      try {
        const st = await (deps.stat ? deps.stat(full) : fs.stat(full))
        if (!st.isFile()) { noteReadError(rel); return }
        if (st.size > GREP_FILE_MAX) { skippedTotal++; if (skippedSample.length < GREP_FALLBACK_SAMPLE_MAX) skippedSample.push(rel); return }
        buf = await (deps.readFile ? deps.readFile(full, { signal }) : fs.readFile(full, { signal }))
      } catch {
        if (signal.aborted) aborted = true
        else noteReadError(rel)
        return
      }
    }
    if (buf.length > GREP_FILE_MAX) { skippedTotal++; if (skippedSample.length < GREP_FALLBACK_SAMPLE_MAX) skippedSample.push(rel); return }
    if (isBinaryBuffer(buf)) return
    const text = buf.toString('utf8')
    const matchLimit = args.outputMode === 'content'
      ? Math.max(1, headLimit === Infinity ? 100_000 : headLimit - totalMatches)
      : 0
    let scan: Awaited<ReturnType<typeof scanText>>
    try { scan = await scanText(text, matchLimit) } catch (error) {
      if (pastDeadline() || (error instanceof Error && /超时/.test(error.message))) { timedOut = true; return }
      throw error
    }
    if (signal.aborted || scan.count === 0) return
    totalMatches += scan.count
    if (args.outputMode === 'content') {
      if (args.multiline) {
        for (const match of scan.matches) {
          const startLine = text.slice(0, match.index).split('\n').length
          pushContentLine(rel, startLine, match.text, true)
        }
      } else {
        const lines = text.split(/\r?\n/)
        const ctx = args.context && args.context > 0 ? args.context : 0
        const emitted = new Set<number>()
        for (const match of scan.matches) {
          const lineIndex = match.lineIndex!
          if (ctx > 0) {
            const lo = Math.max(0, lineIndex - ctx)
            const hi = Math.min(lines.length - 1, lineIndex + ctx)
            for (let cix = lo; cix <= hi; cix++) {
              if (emitted.has(cix)) continue
              emitted.add(cix)
              pushContentLine(rel, cix + 1, lines[cix]!, cix === lineIndex)
            }
          } else pushContentLine(rel, lineIndex + 1, lines[lineIndex]!, true)
        }
      }
      return
    }
    if (args.outputMode === 'files_with_matches') {
      filesWithMatches.push(rel)
      return
    } else if (args.outputMode === 'count') {
      counts.set(rel, scan.count)
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

  const limitReached = (): boolean =>
    (args.outputMode === 'content' && totalMatches >= headLimit) ||
    (args.outputMode === 'files_with_matches' && filesWithMatches.length >= headLimit)

  // R6（C4）：walk 与 rg 同语义——默认跳名单成员 + 隐藏条目 + 敏感路径（修掉「walk 能搜到 .env、
  // rg 不能」的既有两引擎不一致；这是收紧，非放宽）。includeIgnored 解除名单与隐藏（不解除敏感）。
  async function walk(dir: string): Promise<void> {
    if (shouldStop()) return
    let entries: Dirent[]
    try {
      entries = await (deps.readdir ? deps.readdir(dir) : fs.readdir(dir, { withFileTypes: true }))
    } catch {
      if (signal.aborted) aborted = true
      else noteReadError(path.relative(workDir, dir) || '.')
      return
    }
    for (const ent of entries) {
      if (shouldStop() || limitReached()) return
      const full = path.join(dir, ent.name)
      const isHiddenEntry = ent.name.startsWith('.')
      if (!args.includeIgnored && (GREP_SKIP_DIRS.has(ent.name) || isHiddenEntry)) continue
      // 敏感路径逐条目判定（includeIgnored 不解除；显式点名由调用方处理，walk 不经此路径）
      if (isSensitivePath(full)) continue
      if (ent.isDirectory()) await walk(full)
      else if (ent.isFile()) await scanFile(full, true)
    }
  }

  try {
    if (shouldStop()) return 'No matches found'
    await scanText('', 1, true)
    if (shouldStop()) return 'No matches found'
    const st = await (deps.stat ? deps.stat(absSearch) : fs.stat(absSearch)).catch(() => null)
    if (st?.isFile()) await scanFile(absSearch, false)
    else await walk(absSearch)
  } catch (error) {
    return `Error: ${toToolUserError(error, { toolName: 'grep' })}`
  } finally {
    terminateRegexWorker()
  }
  const boundary: string[] = []
  if (skippedTotal > 0) boundary.push(`已跳过 ${skippedTotal} 个超过 ${GREP_FILE_MAX / (1024 * 1024)} MiB 上限的文件，其中可能包含匹配${skippedSample.length ? `（如：${skippedSample.join('、')}）` : ''}`)
  if (readErrorCount > 0) boundary.push(`${readErrorCount} 个文件/目录读取失败，其中可能存在匹配${readErrorSample.length ? `（如：${readErrorSample.join('、')}）` : ''}`)
  if (timedOut) boundary.push('搜索超时，结果可能不完整')
  if (aborted) boundary.push('搜索已被中止，结果可能不完整')
  const finishOutput = (body: string): string => boundary.length ? `${body}\n[边界摘要]\n- ${boundary.join('\n- ')}` : body
  if (args.outputMode === 'files_with_matches') {
    if (filesWithMatches.length === 0) return finishOutput('No matches found')
    const slice = filesWithMatches.slice(0, headLimit)
    return finishOutput(`Found ${slice.length} files\n${slice.join('\n')}`)
  }
  if (args.outputMode === 'count') {
    if (counts.size === 0) return finishOutput('No matches found')
    const lines: string[] = []
    for (const [f, c] of counts) {
      lines.push(`${f}:${c}`)
      if (lines.length >= headLimit) break
    }
    return finishOutput(`${lines.join('\n')}\n\n共 ${totalMatches} 处匹配，涉及 ${counts.size} 个文件`)
  }
  if (contentLines.length === 0) return finishOutput('No matches found')
  const suffix = `\n[共 ${totalMatches} 条匹配${headLimit !== Infinity ? `，限制: ${headLimit}` : ''}]`
  return finishOutput(contentLines.join('\n') + suffix)
}

export const grepExecutor: ToolExecutor = {
  name: 'grep',
  resourceKeys: (input, context) => workspaceResourceKeys(input, context, 'read'),
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) return { success: false, error: '缺少 pattern', duration: Date.now() - started }
    const relPath = extractPathField(input) ?? ''
    // R7：校验与执行同源——只经 normalizeGrepArgs 单一入口，执行器不再各自读 input.*
    const normalized = normalizeGrepArgs(input)
    if (!normalized.ok) {
      const { field, mode, allowed, suggestedWrite } = normalized.error
      return {
        success: false,
        error: `grep.paramConflict(${field};${mode};${allowed};${suggestedWrite})`,
        duration: Date.now() - started
      }
    }
    const gargs: GrepExecArgs = normalized.args
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
      const executeFallback = async (): Promise<ToolExecutorResult> => {
        const fallbackText = await grepFallbackJs(
          ctx.workDir, absSearch, pattern, gargs, ctx.signal,
          (message) => ctx.sendProgress('grep', message), timeoutMs, permitFileHandle
        )
        const permitTarget = ctx.readExecutionPermit?.targets[0]
        const authorizedIdentity = permitTarget?.identity
        const currentStat = authorizedIdentity ? await fs.stat(absSearch).catch(() => null) : null
        const handleStat = permitFileHandle && authorizedIdentity ? await permitFileHandle.stat().catch(() => null) : null
        if (authorizedIdentity && (!currentStat || !handleStat || !readIdentityMatches(currentStat, authorizedIdentity) || !readIdentityMatches(handleStat, authorizedIdentity))) {
          const caseId = 'read-target-identity-changed-during-read'
          recordPolicyExecutionVeto({ audit: ctx.audit, lane: (ctx.lane as import('../../src/shared/confirmation/types').ExecutionLane | undefined) ?? 'desktop', sessionId: ctx.sessionId, requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'grep', decisionRuleId: ctx.readExecutionPermit?.decisionRuleId ?? permitTarget?.decisionRuleId, pathZone: permitTarget?.zone, factId: permitTarget?.factId, failureClass: 'mechanism', caseId })
          return { success: false, error: '搜索期间文件身份或内容发生变化，已丢弃搜索结果。', diagnostic: { caseId, retryable: false, category: 'mechanism' as const, ...(permitTarget?.factId ? { factId: permitTarget.factId } : {}) }, duration: Date.now() - started }
        }
        if (ctx.signal.aborted) return { success: false, error: '搜索已取消。', duration: Date.now() - started }
        const plan = planGrepInvocation({ workDir: ctx.workDir, searchPath: absSearch, args: gargs, engine: 'walk' })
        const boundaryIndex = fallbackText.indexOf('\n[边界摘要]')
        const fallbackBody = boundaryIndex >= 0 ? fallbackText.slice(0, boundaryIndex) : fallbackText
        const boundarySummary = boundaryIndex >= 0 ? fallbackText.slice(boundaryIndex) : ''
        const noMatch = fallbackBody === 'No matches found'
        if (fallbackText.startsWith('Error:')) {
          return { success: false, error: fallbackText.slice('Error:'.length).trim(), duration: Date.now() - started }
        }
        const truncated = fallbackText.includes('已按 head_limit=') || boundaryIndex >= 0
        const scope: GrepScope = {
          ...plan.scope,
          truncated,
          ...(fallbackText.includes('搜索超时') ? { limitReason: 'timeout' as const } : fallbackText.includes('已按 head_limit=') ? { limitReason: 'head_limit' as const } : {})
        }
        const output = `${noMatch ? formatGrepNoMatchOutput(scope) : fallbackBody}${boundarySummary}`
        return {
          success: true,
          data: {
            output,
            ...(noMatch ? { status: scope.skippedCount > 0 ? 'no_match_with_skips' : 'no_match' } : {}),
            searchScope: scope,
            ...(plan.explicitSensitiveHit ? { sensitivePathHit: true } : {})
          },
          duration: Date.now() - started
        }
      }
      if (!resolved.path) {
        void ctx.recordDiagnostic?.({
          code: 'grep-ripgrep-unavailable',
          message: createGrepRipgrepUnavailableDiagnostic(resolved, resolved.reason ?? 'unsupported')
        })
        return await executeFallback()
      }
      const availability = await inspectRipgrepBinary(resolved)
      if (!availability.available) {
        void ctx.recordDiagnostic?.({
          code: 'grep-ripgrep-unavailable',
          message: createGrepRipgrepUnavailableDiagnostic(resolved, availability.reason)
        })
        return await executeFallback()
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
        permitFileHandle ? { fileHandle: permitFileHandle, platform: process.platform } : undefined,
        processTreeKiller,
        (info) => logAgentEvent(info.terminated === 'forced' || info.terminationState === 'termination_failed' ? 'warn' : 'info', 'grep.terminate', {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          toolUseId: ctx.toolUseId,
          ...info
        })
      )
      const authorizedIdentity = ctx.readExecutionPermit?.targets[0]?.identity
      if (permitFileHandle && authorizedIdentity && !readIdentityMatches(await permitFileHandle.stat(), authorizedIdentity)) {
        const caseId = 'read-target-identity-changed-during-read'
        recordPolicyExecutionVeto({ audit: ctx.audit, lane: (ctx.lane as import('../../src/shared/confirmation/types').ExecutionLane | undefined) ?? 'desktop', sessionId: ctx.sessionId, requestId: ctx.requestId, toolUseId: ctx.toolUseId, toolName: 'grep', decisionRuleId: ctx.readExecutionPermit?.decisionRuleId ?? ctx.readExecutionPermit?.targets[0]?.decisionRuleId, pathZone: ctx.readExecutionPermit?.targets[0]?.zone, factId: ctx.readExecutionPermit?.targets[0]?.factId, failureClass: 'mechanism', caseId })
        return { success: false, error: '搜索期间文件身份或内容发生变化，已丢弃搜索结果。', diagnostic: { caseId, retryable: false, category: 'mechanism', ...(ctx.readExecutionPermit?.targets[0]?.factId ? { factId: ctx.readExecutionPermit.targets[0].factId } : {}) }, duration: Date.now() - started }
      }
      if (text.kind === 'success' || text.kind === 'no_match') {
        // R6：范围事实（skipped 由 planGrepInvocation 统一规划；no_match 必带范围）
        const plan = planGrepInvocation({ workDir: ctx.workDir, searchPath: absSearch, args: gargs })
        const truncatedByHead = text.output.includes('已按 head_limit=')
        const scope: GrepScope = {
          ...plan.scope,
          engine: 'ripgrep',
          truncated: truncatedByHead,
          ...(truncatedByHead ? { limitReason: 'head_limit' as const } : {})
        }
        if (text.kind === 'no_match') {
          return {
            success: true,
            data: {
              output: formatGrepNoMatchOutput(scope),
              status: scope.skippedCount > 0 ? 'no_match_with_skips' : 'no_match',
              searchScope: scope,
              ...(plan.explicitSensitiveHit ? { sensitivePathHit: true } : {})
            },
            duration: Date.now() - started
          }
        }
        return {
          success: true,
          data: {
            output: text.output,
            searchScope: scope,
            ...(plan.explicitSensitiveHit ? { sensitivePathHit: true } : {})
          },
          duration: Date.now() - started
        }
      }
      if (text.kind === 'unavailable') {
        void ctx.recordDiagnostic?.({
          code: 'grep-ripgrep-unavailable',
          message: createGrepRipgrepUnavailableDiagnostic(resolved, text.reason)
        })
        return await executeFallback()
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
        shell: false,
        detached: process.platform === 'darwin'
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
  registry.register(createRunScriptRegisteredTool(runScriptExecutor))
  for (const tool of createReadRegisteredTools({ readFile: readFileExecutor, listDirectory: listDirectoryExecutor, grep: grepExecutor, readFeishuAttachment: readFeishuAttachmentExecutor })) {
    registry.register(tool)
  }
  for (const tool of createWriteFileRegisteredTools({ writeFile: writeFileExecutor, editFile: editFileExecutor })) {
    registry.register(tool)
  }
  registry.register(createSwitchWorkDirRegisteredTool(switchWorkDirExecutor))
  registry.register(createSwitchSessionRegisteredTool(switchSessionExecutor))
  registry.register(createBrowserRegisteredTool(browserExecutor))
  for (const tool of createWeChatOutboundRegisteredTools({ send: wechatSendExecutor, reply: wechatReplyExecutor })) {
    registry.register(tool)
  }
  registry.register(createRunLarkCliRegisteredTool(runLarkCliExecutor))
  registry.register(createListWorkDirsRegisteredTool(listWorkDirsExecutor))
  registry.register(skillsReadTool)
  registry.register(historyReadTool)
  // toolkit 网关：能力集合的两个稳定工具（browser_detect 已收编为 env.browserDetect 能力）
  registry.register(toolkitFindTool)
  registry.register(toolkitCallTool)
  return registry
}

/** @deprecated 兼容转发(偏差 18)。 */
export function getRegisteredTool(name: string): import('./plannedToolRegistry').RegisteredTool | undefined {
  return getDefaultAgentRuntime().builtinRegistry.get(name) as import('./plannedToolRegistry').RegisteredTool | undefined
}
