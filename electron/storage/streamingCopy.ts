import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { StorageMaintenanceError } from './storageMaintenanceError'

const COPY_CHUNK_BYTES = 4 * 1024 * 1024

export type StreamingCopyOptions = { signal?: AbortSignal; onProgress?: (completedBytes: number) => void }

export type CopyFileWithHashResult = Readonly<{ bytes: number; sourceSha256: string; destSha256: string }>
export type CopyTreeWithManifestResult = Readonly<{ bytes: number; sourceManifest: string[]; destManifest: string[] }>

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StorageMaintenanceError('STORAGE_MAINTENANCE_CANCELLED', 'database maintenance was cancelled')
}

/** 目录内全部常规文件的字节合计（跳过 symlink；根不存在返回 0）。 */
export function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0
  let bytes = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) bytes += directoryBytes(filePath)
    else if (entry.isFile()) bytes += fs.statSync(filePath).size
  }
  return bytes
}

/**
 * 流式复制单个文件：读源即算 sourceSha256 并写入 dest（省掉 copyFileSync 的独立一遍读），
 * 写毕读回 dest 流式算 destSha256（保持读回校验强度）。dest 以 'wx' 打开，等价 COPYFILE_EXCL。
 * chunk 循环保持同步执行（进度/取消在 chunk 边界生效），不向事件循环让步——进程内压缩路径依赖这一不变量。
 */
export async function copyFileWithHash(sourcePath: string, destPath: string, options: StreamingCopyOptions = {}): Promise<CopyFileWithHashResult> {
  const { signal, onProgress } = options
  throwIfAborted(signal)
  const sourceHash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  const source = fs.openSync(sourcePath, 'r')
  let bytes = 0
  try {
    const dest = fs.openSync(destPath, 'wx')
    try {
      let bytesRead = 0
      do {
        throwIfAborted(signal)
        bytesRead = fs.readSync(source, buffer, 0, buffer.length, null)
        if (bytesRead > 0) {
          const chunk = buffer.subarray(0, bytesRead)
          sourceHash.update(chunk)
          fs.writeSync(dest, chunk)
          bytes += bytesRead
          onProgress?.(bytes)
        }
      } while (bytesRead > 0)
    } finally { fs.closeSync(dest) }
  } finally { fs.closeSync(source) }
  const destSha256 = await hashFileStreaming(destPath, options)
  return { bytes, sourceSha256: sourceHash.digest('hex'), destSha256 }
}

export async function hashFileStreaming(filePath: string, options: StreamingCopyOptions = {}): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
  const descriptor = fs.openSync(filePath, 'r')
  try {
    let bytesRead = 0
    do {
      throwIfAborted(options.signal)
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally { fs.closeSync(descriptor) }
  return hash.digest('hex')
}

/**
 * 一遍遍历完成目录复制 + 双侧逐文件哈希清单（清单格式与 directoryContentManifest 一致：
 * `相对路径\0字节\0sha256`，排序输出），替代 cpSync + 两次独立清单扫描。
 * 保留现语义：symlink / 非常规文件抛错；空目录或根不存在返回空清单（不存在时不动目标）。
 */
export async function copyTreeWithManifest(sourceRoot: string, destRoot: string, options: StreamingCopyOptions = {}): Promise<CopyTreeWithManifestResult> {
  if (!fs.existsSync(sourceRoot)) return { bytes: 0, sourceManifest: [], destManifest: [] }
  const rootStat = fs.lstatSync(sourceRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('archive spill root is not a regular directory')
  const bytes = { value: 0 }
  const sourceManifest: string[] = []
  const destManifest: string[] = []
  let completedBeforeCurrentFile = 0
  const fileOptions: StreamingCopyOptions = options.onProgress
    ? { signal: options.signal, onProgress: (completed) => options.onProgress!(completedBeforeCurrentFile + completed) }
    : { signal: options.signal }
  const visit = async (directory: string, destDirectory: string, prefix: string): Promise<void> => {
    fs.mkdirSync(destDirectory, { recursive: true })
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      throwIfAborted(options.signal)
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.posix.join(prefix, entry.name)
      if (entry.isSymbolicLink()) throw new Error('archive spill tree contains a symbolic link')
      if (entry.isDirectory()) {
        await visit(absolutePath, path.join(destDirectory, entry.name), relativePath)
      } else if (entry.isFile()) {
        const destPath = path.join(destDirectory, entry.name)
        const size = fs.statSync(absolutePath).size
        const copied = await copyFileWithHash(absolutePath, destPath, fileOptions)
        completedBeforeCurrentFile += copied.bytes
        bytes.value += copied.bytes
        sourceManifest.push(`${relativePath}\0${size}\0${copied.sourceSha256}`)
        destManifest.push(`${relativePath}\0${fs.statSync(destPath).size}\0${copied.destSha256}`)
      } else throw new Error('archive spill tree contains an unsupported file type')
    }
  }
  await visit(sourceRoot, destRoot, '')
  sourceManifest.sort()
  destManifest.sort()
  return { bytes: bytes.value, sourceManifest, destManifest }
}
