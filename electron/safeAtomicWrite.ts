import { randomBytes } from 'crypto'
import fs from 'fs/promises'
import fsc from 'fs'
import path from 'path'
import type { Stats } from 'fs'
import type { FileHandle } from 'fs/promises'

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

function openFlagsExclusive(): number {
  const c = fsc.constants
  let flags = c.O_WRONLY | c.O_CREAT | c.O_EXCL
  if (typeof c.O_NOFOLLOW === 'number') {
    flags |= c.O_NOFOLLOW
  }
  return flags
}

function openFlagsReadNoFollow(): number {
  const c = fsc.constants
  let flags = c.O_RDONLY
  if (typeof c.O_NOFOLLOW === 'number') {
    flags |= c.O_NOFOLLOW
  }
  return flags
}

async function unlinkQuiet(p: string): Promise<void> {
  await fs.unlink(p).catch(() => {})
}

/**
 * 在已验证父目录内清理应用专属前缀的遗留普通文件（非目录、非符号链接）。
 */
export async function cleanupSafeWriteTemps(parentDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(parentDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(SAFE_WRITE_TEMP_PREFIX)) continue
    const full = path.join(parentDir, name)
    try {
      const st = await fs.lstat(full)
      if (st.isSymbolicLink() || !st.isFile()) continue
      await fs.unlink(full)
    } catch {
      // ignore
    }
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
  signal?: AbortSignal
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
  const { targetPath, parentReal, body, expectedIdentity, signal } = opts
  throwIfAborted(signal)

  await cleanupSafeWriteTemps(parentDirForTarget(targetPath, parentReal))

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

  throwIfAborted(signal)
  const tmpName = `${SAFE_WRITE_TEMP_PREFIX}${randomBytes(12).toString('hex')}`
  const tmpPath = path.join(path.dirname(targetPath), tmpName)

  let tmpFh: FileHandle | null = null
  try {
    tmpFh = await fs.open(tmpPath, openFlagsExclusive(), 0o600)
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    await writeAllBytes(tmpFh, buf, 0)
    throwIfAborted(signal)
    await tmpFh.sync()
    const tmpStat = await tmpFh.stat()
    assertRegularFileSingleLink(tmpStat, '临时文件')
    const tmpIdentity = identityFromStat(tmpStat)
    await tmpFh.close()
    tmpFh = null

    throwIfAborted(signal)

    if (expectedIdentity === null) {
      // 新文件：link 提交，目标已存在则失败（不替换）
      try {
        await fs.link(tmpPath, targetPath)
      } catch (e: unknown) {
        const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : ''
        if (code === 'EEXIST') {
          throw new Error('目标文件已存在，拒绝覆盖新建路径')
        }
        throw e
      }
      await unlinkQuiet(tmpPath)
      const finalFh = await fs.open(targetPath, openFlagsReadNoFollow())
      try {
        const finalStat = await finalFh.stat()
        assertRegularFileSingleLink(finalStat, '最终目标')
        const finalId = identityFromStat(finalStat)
        // link 后 ino 应与临时文件一致（同一 inode）；size/mtime 一致
        if (finalId.dev !== tmpIdentity.dev || finalId.ino !== tmpIdentity.ino) {
          throw new Error('提交后文件 identity 不一致')
        }
        if (finalId.nlink !== 1) {
          // link 成功后临时已删，应为 1；若仍 >1 说明另有硬链接
          throw new Error('最终目标是硬链接，拒绝写入')
        }
        return finalId
      } finally {
        await finalFh.close()
      }
    }

    // 覆盖：重新打开当前目标，校验 identity 后 rename
    let verifyFh: FileHandle | null = null
    try {
      verifyFh = await fs.open(targetPath, openFlagsReadNoFollow())
      const curStat = await verifyFh.stat()
      assertRegularFileSingleLink(curStat, '覆盖目标')
      const curId = identityFromStat(curStat)
      if (!identitiesMatch(curId, expectedIdentity)) {
        throw new Error('文件在写入前被外部修改或替换，请重新读取后再写入')
      }
    } finally {
      if (verifyFh) await verifyFh.close()
    }

    throwIfAborted(signal)
    await fs.rename(tmpPath, targetPath)

    const finalFh = await fs.open(targetPath, openFlagsReadNoFollow())
    try {
      const finalStat = await finalFh.stat()
      assertRegularFileSingleLink(finalStat, '最终目标')
      const finalId = identityFromStat(finalStat)
      // rename 后临时 inode 成为目标；应与 tmpIdentity 的 size 一致，ino 为临时文件的 ino
      if (finalId.size !== tmpIdentity.size) {
        throw new Error('提交后文件内容不完整')
      }
      if (finalId.nlink !== 1) {
        throw new Error('最终目标是硬链接，拒绝写入')
      }
      if (finalId.dev !== tmpIdentity.dev || finalId.ino !== tmpIdentity.ino) {
        throw new Error('提交后文件 identity 与临时文件不一致')
      }
      return finalId
    } finally {
      await finalFh.close()
    }
  } catch (e) {
    if (tmpFh) {
      await tmpFh.close().catch(() => {})
      tmpFh = null
    }
    await unlinkQuiet(tmpPath)
    throw e
  }
}

function parentDirForTarget(targetPath: string, parentReal: string): string {
  const dir = path.dirname(targetPath)
  return dir || parentReal
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
