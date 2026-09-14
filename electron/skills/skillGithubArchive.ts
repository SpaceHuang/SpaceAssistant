import fs from 'fs'
import path from 'path'
import { spawnCommandSafe } from '../spawnUtil'
import { computeSkillDirSize, SKILL_DIR_HARD_MAX_BYTES } from './skillParser'

export type ArchiveProgress = { phase: string; completed?: number; total?: number }

/** GitHub codeload 归档解压后的顶层目录名，如 superpowers-main */
export function githubArchiveRootFolder(repo: string, branch: string): string {
  return `${repo}-${branch}`
}

/**
 * 仅解压归档中需要的成员，避免整仓解压时因根目录符号链接（如 AGENTS.md）在 Windows 上失败。
 */
export function buildGithubArchiveExtractMembers(repo: string, branch: string, subPath?: string): string[] {
  const root = githubArchiveRootFolder(repo, branch)
  const normalized = subPath?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (normalized) return [`${root}/${normalized}`]
  return [root]
}

export async function downloadGithubArchive(
  owner: string,
  repo: string,
  branch: string,
  destDir: string,
  subPath?: string,
  onProgress?: (progress: ArchiveProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const branches = branch === 'main' ? [branch, 'master'] : [branch]
  let lastError = '下载失败'

  for (const ref of branches) {
    const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120_000)
      const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
      const resp = await fetch(archiveUrl, { signal: combinedSignal })
      clearTimeout(timeout)
      if (!resp.ok) {
        lastError = `下载失败（HTTP ${resp.status}）`
        continue
      }
      const archivePath = path.join(destDir, `${repo}-${ref}.tar.gz`)
      const file = fs.createWriteStream(archivePath)
      let bytes = 0
      if (!resp.body) throw new Error('SKILL_NETWORK_FAILED: 响应没有数据')
      const reader = resp.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value
        bytes += chunk.byteLength
        onProgress?.({ phase: 'download', completed: bytes, total: Number(resp.headers.get('content-length')) || undefined })
        if (bytes > 512 * 1024 * 1024) { file.destroy(); throw new Error('SKILL_ARCHIVE_TOO_LARGE: GitHub 归档超过 512 MB') }
        if (!file.write(Buffer.from(chunk))) await new Promise<void>((resolve) => file.once('drain', resolve))
      }
      await new Promise<void>((resolve, reject) => { file.end(() => resolve()); file.on('error', reject) })

      const extractDir = path.join(destDir, 'extract')
      fs.mkdirSync(extractDir, { recursive: true })
      const members = buildGithubArchiveExtractMembers(repo, ref, subPath)
      onProgress?.({ phase: 'extract', completed: 0, total: 1 })
      await extractTarGz(archivePath, extractDir, members)
      onProgress?.({ phase: 'extract', completed: 1, total: 1 })

      const extractedRepoRoot = resolveExtractedRepoRoot(extractDir, repo, ref)
      validateExtractedTree(extractedRepoRoot)
      return extractedRepoRoot
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  throw new Error(lastError)
}

function resolveExtractedRepoRoot(extractDir: string, repo: string, ref: string): string {
  const expected = path.join(extractDir, githubArchiveRootFolder(repo, ref))
  if (fs.existsSync(expected) && fs.statSync(expected).isDirectory()) {
    return expected
  }
  const entries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((ent) => ent.isDirectory())
  if (entries.length === 1) return path.join(extractDir, entries[0].name)
  throw new Error('解压后的仓库结构异常')
}

function validateExtractedTree(root: string): void {
  const rootReal = fs.realpathSync(root)
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, ent.name)
      const real = fs.realpathSync(full)
      const rel = path.relative(rootReal, real)
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('SKILL_PATH_NOT_FOUND: 解压结果包含目录外路径')
      if (ent.isDirectory()) stack.push(full)
    }
  }
  const size = computeSkillDirSize(root, SKILL_DIR_HARD_MAX_BYTES)
  if (size.exceeded) throw new Error(`SKILL_DIR_TOO_LARGE: 解压后的 Skill 目录超过 ${SKILL_DIR_HARD_MAX_BYTES} 字节`)
}

export function validateTarListing(listing: string): void {
  for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
    const type = entry[0]
    const name = entry.replace(/^[-dlcbps][rwx-]{9}\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, '').trim()
    if (path.posix.isAbsolute(name) || name.split('/').includes('..') || type === 'l' || type === 'h') {
      throw new Error('SKILL_PATH_NOT_FOUND: 归档包含不安全路径')
    }
  }
}

function extractTarGz(archivePath: string, destDir: string, members?: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-tvzf', archivePath]
    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar'
    const spawned = spawnCommandSafe(tarBin, args)
    if ('error' in spawned) {
      reject(new Error(`无法解压仓库：${spawned.error}`))
      return
    }
    spawned.proc.on('error', (err) => reject(new Error(`无法解压仓库：${err.message}`)))
    let listing = ''
    spawned.proc.stdout?.on('data', (chunk) => { listing += String(chunk) })
    spawned.proc.on('close', (code) => {
      if (code === 0) {
        try { validateTarListing(listing) } catch (error) { return reject(error) }
        const extractArgs = ['-xzf', archivePath, '-C', destDir, ...(members ?? [])]
        const extraction = spawnCommandSafe(tarBin, extractArgs)
        if ('error' in extraction) return reject(new Error(extraction.error))
        extraction.proc.on('close', (extractCode) => extractCode === 0 ? resolve() : reject(new Error(`解压仓库失败（退出码 ${extractCode ?? 'unknown'}）`)))
        extraction.proc.on('error', reject)
        return
      }
      else reject(new Error(`解压仓库失败（退出码 ${code ?? 'unknown'}）`))
    })
  })
}
