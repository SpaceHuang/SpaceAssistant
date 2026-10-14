import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { logAgentEvent } from '../agentLogger/agentLogger'

export const SESSION_ARCHIVE_KEEP_COUNT = 1
export const SESSION_ARCHIVE_RETENTION_DAYS = 14
/**
 * 宽限期：比一次压缩的最长耗时高一个量级，用于避开「进行中压缩」的半成品归档。
 * 假设单次压缩（含超大库的进程内降级路径）在该窗口内完成；若压缩实际超过宽限期，期间并发的
 * 另一次成功收口 prune 可能删掉仍在写入的归档——该残余风险与「并发压缩」同级（runSafeDbMaintenance
 * 绕过租约的既有事实，见 sessionStorageMaintenance.ts），不在此用更长的宽限期兜底。
 */
export const SESSION_ARCHIVE_PRUNE_GRACE_MS = 5 * 60_000

const RETENTION_MS = SESSION_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000

export type SessionArchivePruneResult = { removed: string[]; kept: string | null; freedBytes: number }

/** 压缩归档目录名（sessionStorageMaintenance 生成：ISO 的 `:`/`.` 替换为 `-`，后接 UUID）。捕获段即创建时间。 */
const MANAGED_ARCHIVE_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 只认目录名的精确模式；不匹配一律视为不受管（无 mtime 回退的模糊地带）。 */
function managedArchiveCreatedAt(name: string): number | null {
  const match = MANAGED_ARCHIVE_NAME.exec(name)
  if (!match) return null
  const stamped = match[1]!
  const iso = `${stamped.slice(0, 10)}T${stamped.slice(11, 13)}:${stamped.slice(14, 16)}:${stamped.slice(17, 19)}.${stamped.slice(20, 23)}Z`
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp) ? null : timestamp
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(entryPath)
      else if (entry.isFile()) {
        try { total += (await fsp.stat(entryPath)).size } catch { /* 竞态消失的文件按 0 计 */ }
      }
    }
  }
  return total
}

/**
 * 压缩归档保留策略：只保留最近一份、保留 14 天。状态盲（不读 maintenance.json），按目录名管理。
 * 两个触发点：应用启动（无 protect）与压缩成功收口（protect = 刚生成的归档路径）；调用方均 fire-and-forget。
 * 函数整体不抛错；逐目录 best-effort，单个目录删除失败记 warn 跳过，重复触发幂等（容忍 ENOENT）。
 */
export async function pruneSessionArchives(
  userDataDir: string,
  options: { now?: number; protect?: string } = {}
): Promise<SessionArchivePruneResult> {
  const now = options.now ?? Date.now()
  const archiveRoot = path.join(userDataDir, 'session-archives')
  let names: string[]
  try {
    names = await fsp.readdir(archiveRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logAgentEvent('warn', 'storage.archives.pruned', {
        removedCount: 0, freedBytes: 0, reason: 'readdir-failed',
        errorCode: (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : 'UNKNOWN_ERROR')
      })
    }
    return { removed: [], kept: null, freedBytes: 0 }
  }
  const managed = names
    .map((name) => ({ name, createdAt: managedArchiveCreatedAt(name) }))
    .filter((entry): entry is { name: string; createdAt: number } => entry.createdAt !== null)
    .sort((left, right) => right.createdAt - left.createdAt)

  const keepNames = new Set<string>()
  const protectName = options.protect ? path.basename(options.protect) : null
  if (protectName && managedArchiveCreatedAt(protectName) !== null) {
    // 成功收口形态：保留集 = {protect}；其余受管目录中年轻于宽限期者不删（可能是在飞压缩半成品）。
    keepNames.add(protectName)
  } else if (managed.length > 0) {
    // 启动形态：最新归档年轻于宽限期 → 可能有压缩在飞行（runSafeDbMaintenance 绕过租约），本次整体延后。
    const newest = managed[0]!
    if (now - newest.createdAt < SESSION_ARCHIVE_PRUNE_GRACE_MS) {
      logAgentEvent('info', 'storage.archives.pruned', { removedCount: 0, freedBytes: 0, reason: 'in-flight-grace' })
      return { removed: [], kept: null, freedBytes: 0 }
    }
    for (const entry of managed.slice(0, SESSION_ARCHIVE_KEEP_COUNT)) {
      if (entry.createdAt >= now - RETENTION_MS) keepNames.add(entry.name)
    }
  }

  const removed: string[] = []
  let freedBytes = 0
  let graceSkipped = 0
  let firstErrorCode: string | undefined
  for (const entry of managed) {
    if (keepNames.has(entry.name)) continue
    if (now - entry.createdAt < SESSION_ARCHIVE_PRUNE_GRACE_MS) {
      graceSkipped += 1
      continue
    }
    const directory = path.join(archiveRoot, entry.name)
    try {
      const bytes = await directoryBytes(directory)
      await fsp.rm(directory, { recursive: true, force: true })
      // 只有删除成功才计入释放量：rm 失败（可能已部分删除）按 0 报，遥测宁可虚低不虚高。
      freedBytes += bytes
      removed.push(entry.name)
    } catch (error) {
      firstErrorCode ??= (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : 'UNKNOWN_ERROR')
    }
  }

  const kept = keepNames.size > 0 ? managed.find((entry) => keepNames.has(entry.name))?.name ?? null : null
  logAgentEvent(firstErrorCode ? 'warn' : 'info', 'storage.archives.pruned', {
    removedCount: removed.length,
    freedBytes,
    ...(kept ? { kept } : {}),
    ...(graceSkipped > 0 ? { reason: 'grace' } : {}),
    ...(firstErrorCode ? { errorCode: firstErrorCode } : {})
  })
  return { removed, kept, freedBytes }
}
