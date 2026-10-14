import { createHash } from 'node:crypto'
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
}>

function result(input: Omit<AgentsMdLoadResult, 'sourcePath' | 'workDir'> & { workDir: string }): AgentsMdLoadResult {
  return { ...input, sourcePath: AGENTS_MD_FILE_NAME }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
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
  const filePath = path.join(rootPath, AGENTS_MD_FILE_NAME)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rootRealPath = await fs.realpath(rootPath)
      let targetRealPath: string
      try {
        targetRealPath = await fs.realpath(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyResult('missing')
        if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') return emptyResult('read-error')
        return emptyResult('read-error')
      }
      if (!inside(rootRealPath, targetRealPath)) return emptyResult('outside-workdir')
      const before = await fs.stat(filePath)
      if (!before.isFile()) return emptyResult('not-file')
      if (before.size > maxBytes) return emptyResult('too-large', before.size)
      await options.beforeRead?.(attempt, filePath)
      const handle = await fs.open(filePath, 'r')
      let buffer: Buffer
      let after: Awaited<ReturnType<typeof handle.stat>>
      try {
        after = await handle.stat()
        if (!after.isFile()) return emptyResult('not-file')
        if (after.size > maxBytes) return emptyResult('too-large', after.size)
        buffer = Buffer.alloc(Math.min(maxBytes + 1, after.size + 1))
        const read = await handle.read(buffer, 0, buffer.length, 0)
        buffer = buffer.subarray(0, read.bytesRead)
      } finally {
        await handle.close()
      }
      const afterPath = await fs.stat(filePath)
      const stableVersion = before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
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
