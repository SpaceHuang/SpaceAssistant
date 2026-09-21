import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import manifest from './ripgrep-manifest.json' with { type: 'json' }
import { validateManifest } from './ripgrep-manifest.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stagingRoot = path.join(root, 'resources', 'ripgrep')
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_ARCHIVE_FILES = 4096
const DOWNLOAD_TIMEOUT_MS = 30_000
const DOWNLOAD_ATTEMPTS = 3
const APPROVED_DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])

function sha256(data) { return createHash('sha256').update(data).digest('hex') }

async function downloadArchiveOnce(url, fetchImpl) {
  let current = new URL(url)
  if (current.protocol !== 'https:' || current.hostname !== 'github.com') throw new Error('untrusted ripgrep download URL')
  for (let redirects = 0; redirects <= 3; redirects++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    let response
    try {
      response = await fetchImpl(current.toString(), { redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error('ripgrep redirect missing location')
      if (redirects === 3) throw new Error('ripgrep redirect limit exceeded')
      current = new URL(location, current)
      if (current.protocol !== 'https:' || !APPROVED_DOWNLOAD_HOSTS.has(current.hostname)) throw new Error(`untrusted ripgrep redirect: ${current.hostname}`)
      continue
    }
    if (!response.ok) throw new Error(`ripgrep download failed: HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_ARCHIVE_BYTES) throw new Error('ripgrep archive exceeds size limit')
    const reader = response.body?.getReader?.()
    if (!reader) throw new Error('ripgrep response body is not readable')
    const chunks = []
    let total = 0
    try {
      while (true) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
        let next
        try {
          next = await Promise.race([
            reader.read(),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('ripgrep download timed out')), { once: true }))
          ])
        } finally {
          clearTimeout(timeout)
        }
        const { done, value } = next
        if (done) break
        total += value.byteLength
        if (total > MAX_ARCHIVE_BYTES) {
          await reader.cancel('ripgrep archive exceeds size limit')
          throw new Error('ripgrep archive exceeds size limit')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock?.()
    }
    return Buffer.concat(chunks, total)
  }
  throw new Error('ripgrep redirect limit exceeded')
}

export async function downloadArchive(url, fetchImpl = fetch) {
  let lastError
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await downloadArchiveOnce(url, fetchImpl)
    } catch (error) {
      lastError = error
      // 安全策略拒绝类错误是确定性的，重试会重复请求并削弱重定向上限。
      if (error instanceof Error && /redirect limit|untrusted ripgrep redirect|redirect missing location/.test(error.message)) throw error
      if (attempt < DOWNLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
    }
  }
  throw lastError
}
export function safeJoin(base, relative) {
  const resolved = path.resolve(base, relative)
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`unsafe archive path: ${relative}`)
  return resolved
}

export async function assertNoLinks(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  const inodes = new Set()
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`archive contains symbolic link: ${entry.name}`)
    if (entry.isFile()) {
      const stat = await fs.stat(path.join(entry.parentPath ?? root, entry.name))
      const inode = `${stat.dev}:${stat.ino}`
      if (inodes.has(inode)) throw new Error(`archive contains hard link: ${entry.name}`)
      inodes.add(inode)
    }
  }
}

export async function assertArchiveLimits(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  if (entries.length > MAX_ARCHIVE_FILES) throw new Error('archive contains too many files')
  let total = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    total += (await fs.stat(path.join(entry.parentPath ?? root, entry.name))).size
    if (total > MAX_ARCHIVE_BYTES) throw new Error('archive contents exceed size limit')
  }
}

export function validateArchiveEntries(entries) {
  const seen = new Set()
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`unsafe archive entry: ${entry}`)
    if (seen.has(normalized)) throw new Error(`duplicate archive entry: ${entry}`)
    seen.add(normalized)
  }
  if (seen.size > MAX_ARCHIVE_FILES) throw new Error('archive contains too many files')
  return [...seen]
}

export async function prepareTarget(targetKey, opts = {}) {
  validateManifest(manifest)
  const target = manifest.targets[targetKey]
  if (!target) throw new Error(`unsupported ripgrep target: ${targetKey}`)
  const sourceName = targetKey.startsWith('win32') ? 'rg.exe' : 'rg'
  const destination = path.join(stagingRoot, targetKey, sourceName)
  try {
    const cached = await fs.readFile(destination)
    if (sha256(cached) === target.binarySha256) {
      if (!targetKey.startsWith('win32')) await fs.chmod(destination, 0o755)
      return destination
    }
  } catch {
    // Cache miss or incomplete cache: download and verify below.
  }
  const archive = opts.archivePath ? await fs.readFile(opts.archivePath) : await downloadArchive(target.url)
  if (sha256(archive) !== target.archiveSha256) throw new Error(`archive SHA-256 mismatch for ${targetKey}`)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-rg-'))
  try {
    const archivePath = path.join(temp, target.archiveType === 'zip' ? 'rg.zip' : 'rg.tar.gz')
    const extract = path.join(temp, 'extract')
    await fs.mkdir(extract)
    await fs.writeFile(archivePath, archive, { flag: 'wx' })
    if (target.archiveType === 'zip') {
      const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath])
      validateArchiveEntries(stdout.split(/\r?\n/).filter(Boolean))
      await execFileAsync('unzip', ['-q', archivePath, '-d', extract])
    } else {
      const { stdout } = await execFileAsync('tar', ['-tzf', archivePath])
      validateArchiveEntries(stdout.split(/\r?\n/).filter(Boolean))
      await execFileAsync('tar', ['-xzf', archivePath, '-C', extract])
    }
    await assertNoLinks(extract)
    await assertArchiveLimits(extract)
    const binary = safeJoin(extract, target.binaryPath)
    const content = await fs.readFile(binary)
    if (sha256(content) !== target.binarySha256) throw new Error(`binary SHA-256 mismatch for ${targetKey}`)
    const destinationDir = path.join(stagingRoot, targetKey)
    const destination = path.join(destinationDir, sourceName)
    await fs.mkdir(destinationDir, { recursive: true })
    const newFile = `${destination}.new-${process.pid}`
    await fs.writeFile(newFile, content, { flag: 'wx', mode: 0o755 })
    if (!targetKey.startsWith('win32')) await fs.chmod(newFile, 0o755)
    await fs.rename(newFile, destination)
    const licenseDir = path.join(root, 'resources', 'licenses', 'ripgrep')
    await fs.mkdir(licenseDir, { recursive: true })
    for (const license of ['COPYING', 'UNLICENSE', 'LICENSE-MIT']) {
      const sourceLicense = safeJoin(extract, `${target.binaryPath.split('/')[0]}/${license}`)
      await fs.copyFile(sourceLicense, path.join(licenseDir, license))
    }
    return destination
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const targets = process.argv.slice(2).filter((arg) => arg.startsWith('--target=')).map((arg) => arg.slice(9))
  const selected = targets.length ? targets : ['darwin-x64', 'darwin-arm64', 'win32-x64']
  for (const target of selected) await prepareTarget(target)
}
