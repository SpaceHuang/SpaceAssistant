import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { estimateTokensFromUtf8Text } from '../../src/shared/contextUsageEstimate'

export const AGENTS_MD_FILE_NAME = 'AGENTS.md'
export const AGENTS_MD_MAX_BYTES = 32 * 1024
export const AGENTS_MD_MAX_TOKENS = 8_000

export type AgentsMdLoadStatus =
  | 'loaded' | 'missing' | 'empty' | 'disabled' | 'too-large' | 'token-budget-exceeded'
  | 'invalid-workdir' | 'outside-workdir' | 'not-file' | 'invalid-encoding'
  | 'read-error' | 'unstable'

export type AgentsMdLoadResult = Readonly<{
  status: AgentsMdLoadStatus
  sourcePath: string
  content: string | null
  byteLength: number
  digest: string | null
  loadedAt: number
  tokenCount: number
  workDir: string
}>

export type LoadAgentsMdOptions = Readonly<{
  enabled?: boolean
  contextWindow?: number
  /** Tokens reserved for the surrounding prompt wrapper. */
  promptOverheadTokens?: number
  maxBytes?: number
  /** Test seam for normal concurrent edits; at most one retry is made. */
  beforeRead?: (attempt: number, filePath: string) => void | Promise<void>
  /** Test seam for deterministic path replacement after open but before validation. */
  afterOpen?: (attempt: number, filePath: string) => void | Promise<void>
}>

function result(input: Omit<AgentsMdLoadResult, 'sourcePath' | 'workDir'> & { workDir: string }): AgentsMdLoadResult {
  return { ...input, sourcePath: AGENTS_MD_FILE_NAME }
}

type FileStat = Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>

function sameFile(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export async function loadAgentsMd(workDir: string, options: LoadAgentsMdOptions = {}): Promise<AgentsMdLoadResult> {
  const loadedAt = Date.now()
  const rootPath = path.resolve(workDir)
  const emptyResult = (status: AgentsMdLoadStatus, byteLength = 0) => result({
    status, content: null, byteLength, digest: null, loadedAt, tokenCount: 0, workDir: rootPath
  })
  if (options.enabled === false) return emptyResult('disabled')
  if (!workDir.trim()) return emptyResult('invalid-workdir')

  const maxBytes = Math.min(options.maxBytes ?? AGENTS_MD_MAX_BYTES, AGENTS_MD_MAX_BYTES)
  let authorizedRootRealPath: string | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resolvedRootPath = await fs.realpath(rootPath)
      if (authorizedRootRealPath && resolvedRootPath !== authorizedRootRealPath) return emptyResult('unstable')
      authorizedRootRealPath ??= resolvedRootPath
      const rootRealPath = authorizedRootRealPath
      // Pin the direct child path to the authorized directory identity. Using
      // the caller's (possibly symlinked) workDir path here would re-resolve
      // that alias on every subsequent filesystem operation.
      const filePath = path.join(rootRealPath, AGENTS_MD_FILE_NAME)
      // Node does not expose portable openat-style traversal for arbitrary
      // in-directory links. Reject AGENTS.md symlinks rather than following a
      // mutable parent component and attempting to validate it after the fact.
      const linkStat = await fs.lstat(filePath)
      if (linkStat.isSymbolicLink()) return emptyResult('not-file')
      const pathBeforeOpen = await fs.stat(filePath)
      if (!pathBeforeOpen.isFile()) return emptyResult('not-file')
      if (pathBeforeOpen.size > maxBytes) return emptyResult('too-large', pathBeforeOpen.size)
      await options.beforeRead?.(attempt, filePath)
      // Open first, then prove that the opened inode is still named by the
      // in-workdir path. No bytes are read until this binding is verified.
      // O_NONBLOCK avoids hanging if an attacker swaps in a FIFO before open;
      // it has no effect on ordinary files.
      let handle: Awaited<ReturnType<typeof fs.open>>
      try {
        handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') return emptyResult('not-file')
        throw error
      }
      let buffer: Buffer
      let before: Awaited<ReturnType<typeof handle.stat>>
      let after: Awaited<ReturnType<typeof handle.stat>>
      try {
        await options.afterOpen?.(attempt, filePath)
        before = await handle.stat()
        if (!before.isFile()) return emptyResult('not-file')
        if (before.size > maxBytes) return emptyResult('too-large', before.size)
        if (!sameFile(before, pathBeforeOpen) || before.size !== pathBeforeOpen.size || before.mtimeMs !== pathBeforeOpen.mtimeMs) {
          if (attempt === 0) continue
          return emptyResult('unstable')
        }

        const verifiedRootPath = await fs.realpath(rootPath)
        if (verifiedRootPath !== rootRealPath) return emptyResult('unstable')
        const verifiedPathStat = await fs.lstat(filePath)
        if (verifiedPathStat.isSymbolicLink()) return emptyResult('not-file')
        if (!sameFile(before, verifiedPathStat)) {
          if (attempt === 0) continue
          return emptyResult('unstable')
        }

        buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1))
        const read = await handle.read(buffer, 0, buffer.length, 0)
        buffer = buffer.subarray(0, read.bytesRead)
        after = await handle.stat()
      } finally {
        await handle.close()
      }

      const finalRootPath = await fs.realpath(rootPath)
      if (finalRootPath !== rootRealPath) return emptyResult('unstable')
      const afterPath = await fs.lstat(filePath)
      if (afterPath.isSymbolicLink()) return emptyResult('not-file')
      const stableVersion = sameFile(before, after) && before.size === after.size &&
        before.mtimeMs === after.mtimeMs && afterPath.dev === after.dev && afterPath.ino === after.ino &&
        afterPath.size === after.size && afterPath.mtimeMs === after.mtimeMs && buffer.length === after.size
      if (!stableVersion) {
        if (attempt === 0) continue
        return emptyResult('unstable')
      }
      if (buffer.length > maxBytes) return emptyResult('too-large', buffer.length)
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        return emptyResult('invalid-encoding', buffer.length)
      }
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
      content = content.replace(/\r\n?/g, '\n')
      const digest = createHash('sha256').update(buffer).digest('hex')
      if (!content.trim()) return result({ status: 'empty', content: null, byteLength: buffer.length, digest, loadedAt, tokenCount: 0, workDir: rootPath })
      const tokenCount = estimateTokensFromUtf8Text(content)
      const tokenBudget = Math.max(0, Math.min(AGENTS_MD_MAX_TOKENS, Math.floor((options.contextWindow ?? 200_000) * 0.05)) - Math.max(0, options.promptOverheadTokens ?? 0))
      if (tokenCount > tokenBudget) return result({ status: 'token-budget-exceeded', content: null, byteLength: buffer.length, digest, loadedAt, tokenCount, workDir: rootPath })
      return result({ status: 'loaded', content, byteLength: buffer.length, digest, loadedAt, tokenCount, workDir: rootPath })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return emptyResult('missing')
      if (code === 'EACCES' || code === 'EPERM') return emptyResult('read-error')
      return emptyResult('read-error')
    }
  }
  return emptyResult('unstable')
}
