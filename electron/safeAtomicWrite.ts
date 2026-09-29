import { randomBytes } from 'crypto'
import fs from 'fs/promises'
import fsc from 'fs'
import path from 'path'
import type { Stats } from 'fs'
import type { FileHandle } from 'fs/promises'
import { cleanupDirectoryTempsBoundToIdentity, writeFileAtomicallyBoundToDirectory } from './confirmation/directoryHandleWriter'

/** 应用专属临时文件前缀；初始化时只清理该前缀的遗留普通文件 */
export const SAFE_WRITE_TEMP_PREFIX = '.sa-wtmp-'

export type FileIdentity = {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  nlink: number
}

export function identityFromStat(st: Stats): FileIdentity {
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    nlink: typeof st.nlink === 'number' ? st.nlink : 1
  }
}

export function identitiesMatch(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.nlink === b.nlink
  )
}

/** FileHandle.write may return partial bytesWritten — loop until the full buffer is written. */
export async function writeAllBytes(
  fh: FileHandle,
  data: Buffer | string,
  position?: number
): Promise<void> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  let offset = 0
  let pos = position
  while (offset < buf.length) {
    const result =
      pos === undefined
        ? await fh.write(buf, offset, buf.length - offset)
        : await fh.write(buf, offset, buf.length - offset, pos)
    if (result.bytesWritten <= 0) {
      throw new Error('写入返回 0 字节，无法完成完整写入')
    }
    offset += result.bytesWritten
    if (pos !== undefined) {
      pos += result.bytesWritten
    }
  }
}

function assertRegularFileSingleLink(st: Stats, label: string): void {
  if (st.isSymbolicLink()) {
    throw new Error(`${label}是符号链接，拒绝写入`)
  }
  if (!st.isFile()) {
    throw new Error(`${label}不是普通文件`)
  }
  if (typeof st.nlink === 'number' && st.nlink > 1) {
    throw new Error(`${label}是硬链接，拒绝写入`)
  }
}

function openFlagsReadNoFollow(): number {
  const c = fsc.constants
  let flags = c.O_RDONLY
  if (typeof c.O_NOFOLLOW === 'number') {
    flags |= c.O_NOFOLLOW
  }
  return flags
}

/**
 * 在已验证父目录内清理应用专属前缀的遗留普通文件（非目录、非符号链接）。
 */
export async function cleanupSafeWriteTemps(parentDir: string): Promise<void> {
  try {
    const parentLstat = await fs.lstat(parentDir)
    if (parentLstat.isSymbolicLink() || !parentLstat.isDirectory() || await fs.realpath(parentDir) !== parentDir) return
    await cleanupDirectoryTempsBoundToIdentity({
      directory: parentDir,
      expectedDirectoryIdentity: { dev: parentLstat.dev, ino: parentLstat.ino, mode: parentLstat.mode, size: parentLstat.size, mtimeMs: parentLstat.mtimeMs },
      tempPrefix: SAFE_WRITE_TEMP_PREFIX
    })
  } catch {
    return
  }
}

export type SafeAtomicWriteOptions = {
  /** 目标绝对路径（词法，来自 resolveSafeWriteTarget） */
  targetPath: string
  /** 最近存在父目录 realpath */
  parentReal: string
  body: string | Buffer
  /** 覆盖已有文件时，读取时捕获的 identity；新文件为 null */
  expectedIdentity: FileIdentity | null
  /** Permit 写入时绑定的最近已存在目录 identity。 */
  expectedParentIdentity?: { dev: number; ino: number; mode: number }
  signal?: AbortSignal
}

export class SafeAtomicWriteUncertainError extends Error {
  constructor(cause?: unknown) {
    super(cause === undefined
      ? '原子写入 worker 未返回提交结果，目标文件状态未知'
      : '原子写入已提交但许可父目录复核失败，目标文件状态未知')
    this.name = 'SafeAtomicWriteUncertainError'
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause
  }
}

/** Windows 瞬时锁（杀软/索引器短暂持住 rename/link 目标）下的有界重试；仅针对瞬时拒绝类错误码。 */
export async function withTransientLockRetry<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await op()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code !== 'EPERM' && code !== 'EACCES') throw e
      lastError = e
    }
    throwIfAborted(signal)
    await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
  }
  throw lastError
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('用户取消执行')
    err.name = 'AbortError'
    throw err
  }
}

/**
 * 受控原子写入：
 * - 在已验证父目录创建随机临时文件（wx + O_NOFOLLOW）
 * - 完整写入 + FileHandle.sync()
 * - 新文件：fs.link(temp, target)；覆盖：校验 identity 后 rename
 * - 任一步失败关闭句柄并删除临时文件
 */
export async function safeAtomicWrite(opts: SafeAtomicWriteOptions): Promise<FileIdentity> {
  const { targetPath, parentReal, body, expectedIdentity, expectedParentIdentity, signal } = opts
  throwIfAborted(signal)

  const verifyParentIdentity = async () => {
    if (!expectedParentIdentity) return
    const parentLstat = await fs.lstat(parentReal)
    const parentStat = await fs.stat(parentReal)
    if (parentLstat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.dev !== expectedParentIdentity.dev || parentStat.ino !== expectedParentIdentity.ino || parentStat.mode !== expectedParentIdentity.mode || await fs.realpath(parentReal) !== parentReal) {
      throw new Error('写入父目录 identity 已变化，拒绝提交')
    }
  }

  // 确保从 parentReal 到目标的中间目录存在（仅在已验证父目录下创建）
  const targetParent = path.dirname(targetPath)
  if (targetParent !== parentReal && !targetParent.startsWith(parentReal + path.sep) && targetParent !== parentReal) {
    // Windows 大小写：用 path.relative 判断
    const rel = path.relative(parentReal, targetParent)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('写入父目录超出已验证范围')
    }
  }
  if (targetParent !== parentReal) {
    await fs.mkdir(targetParent, { recursive: true })
    // 重新校验中间路径无 symlink（mkdir 后可能被抢占）
    await assertNoSymlinkAlong(parentReal, targetParent)
  }

  await verifyParentIdentity()
  const targetParentHandle = await fs.stat(targetParent)
  if (!targetParentHandle.isDirectory() || await fs.realpath(targetParent) !== targetParent) {
    throw new Error('写入父目录 identity 已变化，拒绝提交')
  }
  const result = await writeFileAtomicallyBoundToDirectory({
    directory: targetParent,
    expectedDirectoryIdentity: { dev: targetParentHandle.dev, ino: targetParentHandle.ino, mode: targetParentHandle.mode, size: targetParentHandle.size, mtimeMs: targetParentHandle.mtimeMs },
    targetName: path.basename(targetPath),
    tempName: `${SAFE_WRITE_TEMP_PREFIX}${randomBytes(12).toString('hex')}`,
    body,
    expectedFileIdentity: expectedIdentity,
    signal
  })
  if (!result.ok) {
    if (result.caseId === 'write-directory-cancelled') throw new SafeAtomicWriteUncertainError()
    const message = result.caseId === 'write-target-exists'
      ? '目标文件已存在，拒绝覆盖新建路径'
      : result.caseId === 'write-file-identity-changed'
        ? '文件在写入前被外部修改或替换，请重新读取后再写入'
        : result.caseId === 'write-directory-identity-changed'
          ? '写入父目录 identity 已变化，拒绝提交'
          : result.caseId
    throw new Error(message)
  }
  try {
    await verifyParentIdentity()
  } catch (error) {
    // The worker already committed. A later identity failure cannot truthfully
    // be reported as a normal write rejection because the side effect happened.
    throw new SafeAtomicWriteUncertainError(error)
  }
  return result.identity
}

async function assertNoSymlinkAlong(fromReal: string, toPath: string): Promise<void> {
  const rel = path.relative(fromReal, toPath)
  if (!rel || rel === '') return
  const segments = rel.split(path.sep).filter(Boolean)
  let cur = fromReal
  for (const seg of segments) {
    cur = path.join(cur, seg)
    let st: Stats
    try {
      st = await fs.lstat(cur)
    } catch {
      throw new Error('路径组件无法判定')
    }
    if (st.isSymbolicLink()) {
      throw new Error('路径包含符号链接，拒绝写入')
    }
    if (!st.isDirectory()) {
      throw new Error('路径组件不是目录')
    }
  }
}

/** 从已打开/已读文件捕获 identity，供覆盖写入使用 */
export async function captureFileIdentity(absPath: string): Promise<FileIdentity> {
  const fh = await fs.open(absPath, openFlagsReadNoFollow())
  try {
    const st = await fh.stat()
    assertRegularFileSingleLink(st, '目标')
    return identityFromStat(st)
  } finally {
    await fh.close()
  }
}
