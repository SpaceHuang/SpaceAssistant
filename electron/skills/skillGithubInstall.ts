import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { spawnCommandSafe } from '../spawnUtil'
import { installSkillToUserDir } from './skillInstall'

export type ParsedGithubSource = {
  owner: string
  repo: string
  branch: string
  subPath: string
}

const GITHUB_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/i

export function parseGithubSkillUrl(url: string): ParsedGithubSource | null {
  const trimmed = url.trim().replace(/\/$/, '')
  const match = trimmed.match(GITHUB_URL_RE)
  if (!match) return null
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ''),
    branch: match[3] || 'main',
    subPath: match[4] ? decodeURIComponent(match[4]) : ''
  }
}

export function resolveSkillSourceDirs(
  extractedRepoRoot: string,
  subPath: string,
  installAll: boolean
): string[] {
  const base = subPath ? path.join(extractedRepoRoot, ...subPath.split('/')) : extractedRepoRoot
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`仓库中未找到目录：${subPath || '根目录'}`)
  }

  if (fs.existsSync(path.join(base, 'SKILL.md'))) {
    return [base]
  }

  if (installAll) {
    const dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => path.join(base, ent.name))
      .filter((dir) => fs.existsSync(path.join(dir, 'SKILL.md')))
    if (dirs.length === 0) throw new Error('目录下未找到可安装的 Skill')
    return dirs.sort()
  }

  throw new Error('所选路径不是有效的 Skill 目录')
}

async function downloadGithubArchive(owner: string, repo: string, branch: string, destDir: string): Promise<string> {
  const branches = branch === 'main' ? [branch, 'master'] : [branch]
  let lastError = '下载失败'

  for (const ref of branches) {
    const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`
    try {
      const resp = await fetch(archiveUrl)
      if (!resp.ok) {
        lastError = `下载失败（HTTP ${resp.status}）`
        continue
      }
      const buffer = Buffer.from(await resp.arrayBuffer())
      const archivePath = path.join(destDir, `${repo}-${ref}.tar.gz`)
      fs.writeFileSync(archivePath, buffer)

      const extractDir = path.join(destDir, 'extract')
      fs.mkdirSync(extractDir, { recursive: true })
      await extractTarGz(archivePath, extractDir)

      const entries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((ent) => ent.isDirectory())
      if (entries.length !== 1) throw new Error('解压后的仓库结构异常')
      return path.join(extractDir, entries[0].name)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  throw new Error(lastError)
}

function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const spawned = spawnCommandSafe('tar', ['-xzf', archivePath, '-C', destDir])
    if ('error' in spawned) {
      reject(new Error(`无法解压仓库：${spawned.error}`))
      return
    }
    spawned.proc.on('error', (err) => reject(new Error(`无法解压仓库：${err.message}`)))
    spawned.proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压仓库失败（退出码 ${code ?? 'unknown'}）`))
    })
  })
}

function rmDirSafe(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

export async function installSkillsFromGithub(
  userDataPath: string,
  sourceUrl: string,
  options: { subPath?: string; installAll?: boolean; overwrite?: boolean } = {}
): Promise<SkillDefinition[]> {
  const parsed = parseGithubSkillUrl(sourceUrl)
  if (!parsed) throw new Error('无效的 GitHub 地址')

  const subPath = options.subPath ?? parsed.subPath
  const installAll = options.installAll === true
  const overwrite = options.overwrite === true
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-skill-github-'))

  try {
    const extractedRepoRoot = await downloadGithubArchive(parsed.owner, parsed.repo, parsed.branch, tempRoot)
    const sourceDirs = resolveSkillSourceDirs(extractedRepoRoot, subPath, installAll)
    const installed: SkillDefinition[] = []

    for (const sourceDir of sourceDirs) {
      installed.push(await installSkillToUserDir(userDataPath, sourceDir, overwrite))
    }

    return installed
  } finally {
    rmDirSafe(tempRoot)
  }
}
