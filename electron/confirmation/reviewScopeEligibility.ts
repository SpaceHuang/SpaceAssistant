import fs from 'node:fs/promises'
import path from 'node:path'
import type { WritePathFact } from './extractors/writePathFacts'

export const REVIEW_SCOPE_SCRIPT_EXTENSIONS = Object.freeze([
  '.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.ps1', '.bat', '.cmd', '.rb', '.pl', '.php'
] as const)

const MACHO_MAGICS = new Set([
  'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca'
])
const HEADER_READ_LIMIT = 1024 * 1024 + 4

function hasExecutableMagic(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true
  if (bytes.length >= 4 && MACHO_MAGICS.has(bytes.subarray(0, 4).toString('hex'))) return true
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    if (bytes.length < 0x40) return false
    const peOffset = bytes.readUInt32LE(0x3c)
    return peOffset <= 1024 * 1024 && peOffset + 4 <= bytes.length && bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
  }
  return false
}

async function readHeader(filePath: string, expected?: WritePathFact['identity']): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const before = await fs.lstat(filePath)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null
    const flags = fsConstantsNoFollow()
    handle = await fs.open(filePath, flags)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
      (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino || opened.mode !== expected.mode || opened.size !== expected.size || opened.mtimeMs !== expected.mtimeMs || opened.nlink !== expected.nlink))) return null
    const buffer = Buffer.alloc(Math.min(HEADER_READ_LIMIT, opened.size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    const named = await fs.lstat(filePath)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink() || named.nlink !== 1) return null
    return buffer.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function fsConstantsNoFollow(): number {
  const constants = require('node:fs').constants as typeof import('node:fs').constants
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
}

async function repositoryRoot(workDir: string): Promise<string | null> {
  let current: string
  try { current = await fs.realpath(workDir) } catch { return null }
  while (true) {
    try {
      await fs.lstat(path.join(current, '.git'))
      return current
    } catch { /* walk to parent */ }
    const parent = path.dirname(current)
    if (parent === current) return await fs.realpath(workDir).catch(() => null)
    current = parent
  }
}

function isFixedCiPath(rootRelativePath: string): boolean {
  const segments = rootRelativePath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  if (segments.length === 3 && segments[0] === '.github' && segments[1] === 'workflows') {
    return segments[2]!.endsWith('.yml') || segments[2]!.endsWith('.yaml')
  }
  return (segments.length === 1 && segments[0] === '.gitlab-ci.yml') ||
    (segments.length === 2 && segments[0] === '.circleci' && segments[1] === 'config.yml')
}

export async function isReviewScopeWriteEligible(input: {
  readonly target: WritePathFact
  readonly workDir: string
  readonly proposedContent?: string | Buffer
}): Promise<boolean> {
  const extension = path.extname(input.target.normalizedPath).toLowerCase()
  if ((REVIEW_SCOPE_SCRIPT_EXTENSIONS as readonly string[]).includes(extension)) return false
  if (process.platform !== 'win32' && input.target.identity && (input.target.identity.mode & 0o111) !== 0) return false
  const proposed = input.proposedContent === undefined ? undefined
    : Buffer.isBuffer(input.proposedContent) ? input.proposedContent : Buffer.from(input.proposedContent, 'utf8')
  if (proposed && hasExecutableMagic(proposed.subarray(0, HEADER_READ_LIMIT))) return false
  if (input.target.targetKind === 'file') {
    if (!input.target.identity) return false
    const header = await readHeader(input.target.normalizedPath, input.target.identity)
    if (!header || hasExecutableMagic(header)) return false
  } else if (input.target.targetKind !== 'missing') return false

  const root = await repositoryRoot(input.workDir)
  if (!root) return false
  const relative = path.relative(root, input.target.normalizedPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  return !isFixedCiPath(relative)
}
