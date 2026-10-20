import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'

export type TaskPathFactEntry = {
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'special'
  relativePath: string
}

export type TaskPathCandidate = {
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'special' | 'missing' | 'unavailable'
  isGitRepository: boolean
}

export type TaskPathFacts = {
  roots: string[]
  /** Write-only destination root; intentionally excluded from entries and roots. */
  outputRoot?: string
  /** Metadata-only signal for offering outputRoot as a separately authorized read candidate; never grants read access. */
  outputRootIsGitRepository?: boolean
  /** Exact paths proposed by Mock tool calls and checked by the host; candidates never grant access. */
  proposedPathCandidates?: TaskPathCandidate[]
  /** Local repository roots discovered from .git markers; facts only, never a permission decision. */
  gitRepositories: string[]
  entries: TaskPathFactEntry[]
  coverage: { complete: boolean; truncated: boolean; roots: number; visited: number; errors: number }
  digest: string
}

export class TaskPathFactsError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'TaskPathFactsError'; this.code = code }
}

type TaskPathFactsLimits = { maxDepth: number; maxEntriesPerRoot: number; maxEntriesTotal: number }

const DEFAULT_LIMITS: TaskPathFactsLimits = { maxDepth: 3, maxEntriesPerRoot: 10_000, maxEntriesTotal: 50_000 }

/** Facts phase only: enumerate metadata under already-authorized roots; never follows symlinks or decides policy. */
export class TaskPathFactsProvider {
  private readonly limits: TaskPathFactsLimits

  constructor(limits: Partial<TaskPathFactsLimits> = {}) { this.limits = { ...DEFAULT_LIMITS, ...limits } }

  /** facts: checks only exact paths proposed in the Mock trace; does not read contents, enumerate, or authorize them. */
  async inspectPaths(inputPaths: readonly string[]): Promise<TaskPathCandidate[]> {
    const candidates: TaskPathCandidate[] = []
    for (const rawPath of [...new Set(inputPaths)].slice(0, 32)) {
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || !path.isAbsolute(rawPath) || path.normalize(rawPath) !== rawPath) continue
      try {
        const info = await lstat(rawPath)
        if (info.isSymbolicLink()) {
          candidates.push({ path: rawPath, kind: 'symlink', isGitRepository: false })
          continue
        }
        const canonical = await realpath(rawPath)
        if (canonical !== rawPath) {
          // A path that crosses a symlink is observable but is not a safe permission candidate.
          candidates.push({ path: rawPath, kind: 'symlink', isGitRepository: false })
          continue
        }
        const kind: TaskPathCandidate['kind'] = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'special'
        let isGitRepository = false
        if (kind === 'directory') {
          try {
            const marker = await lstat(path.join(rawPath, '.git'))
            isGitRepository = !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())
          } catch { isGitRepository = false }
        }
        candidates.push({ path: rawPath, kind, isGitRepository })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
          candidates.push({ path: rawPath, kind: 'missing', isGitRepository: false })
        } else {
          candidates.push({ path: rawPath, kind: 'unavailable', isGitRepository: false })
        }
      }
    }
    return candidates
  }

  async collect(inputRoots: readonly string[], inputOutputRoot?: string): Promise<TaskPathFacts> {
    if (!Array.isArray(inputRoots) || (inputRoots.length === 0 && !inputOutputRoot)) throw new TaskPathFactsError('NO_ROOTS', '任务工作目录不能为空')
    const roots: string[] = []
    for (const input of inputRoots) {
      if (typeof input !== 'string' || input.trim().length === 0 || !path.isAbsolute(input)) throw new TaskPathFactsError('INVALID_ROOT', '任务工作目录无效')
      const canonical = await realpath(input)
      await access(canonical, constants.R_OK | constants.X_OK)
      const rootInfo = await lstat(canonical)
      if (!rootInfo.isDirectory()) throw new TaskPathFactsError('INVALID_ROOT', '任务工作目录必须是目录')
      roots.push(canonical)
    }
    let outputRoot: string | undefined
    let outputRootIsGitRepository = false
    if (inputOutputRoot !== undefined) {
      if (typeof inputOutputRoot !== 'string' || inputOutputRoot.trim().length === 0 || !path.isAbsolute(inputOutputRoot)) throw new TaskPathFactsError('INVALID_OUTPUT_ROOT', '结果输出目录无效')
      outputRoot = await realpath(inputOutputRoot)
      await access(outputRoot, constants.W_OK | constants.X_OK)
      const outputInfo = await lstat(outputRoot)
      if (!outputInfo.isDirectory()) throw new TaskPathFactsError('INVALID_OUTPUT_ROOT', '结果输出目录必须是目录')
      // A known-name marker check can identify a repo candidate without enumerating output contents
      // or adding the output path to read roots. The user must separately authorize it for reads.
      try {
        const marker = await lstat(path.join(outputRoot, '.git'))
        outputRootIsGitRepository = !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())
      } catch {
        outputRootIsGitRepository = false
      }
    }
    const canonicalRoots = [...new Set(roots)].sort()
    const entries: TaskPathFactEntry[] = canonicalRoots.map((root) => ({ path: root, relativePath: '', kind: 'directory' }))
    const gitRepositories = new Set<string>()
    let truncated = false
    let errors = 0
    for (const root of canonicalRoots) {
      let rootVisited = 0
      const recordGitMarker = async (directory: string) => {
        try {
          const marker = await lstat(path.join(directory, '.git'))
          if (!marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) gitRepositories.add(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors += 1
        }
      }
      const walk = async (directory: string, depth: number): Promise<void> => {
        await recordGitMarker(directory)
        if (truncated) return
        if (depth > this.limits.maxDepth) {
          try {
            if ((await readdir(directory)).length > 0) truncated = true
          } catch { errors += 1 }
          return
        }
        let names: string[]
        try { names = await readdir(directory) } catch { errors += 1; return }
        names.sort((a, b) => a.localeCompare(b, 'en'))
        for (const name of names) {
          // .git is repository metadata, not a task target. Detect it via lstat above and never enumerate it.
          if (name === '.git') continue
          if (rootVisited >= this.limits.maxEntriesPerRoot || entries.length >= this.limits.maxEntriesTotal) { truncated = true; return }
          const fullPath = path.join(directory, name)
          let info
          try { info = await lstat(fullPath) } catch { errors += 1; continue }
          rootVisited += 1
          const kind: TaskPathFactEntry['kind'] = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'special'
          entries.push({ path: fullPath, relativePath: path.relative(root, fullPath).split(path.sep).join('/'), kind })
          if (kind === 'directory' && depth < this.limits.maxDepth) await walk(fullPath, depth + 1)
          else if (kind === 'directory' && depth === this.limits.maxDepth) {
            try {
              if ((await readdir(fullPath)).length > 0) truncated = true
            } catch { errors += 1 }
          }
        }
      }
      await walk(root, 1)
    }
    const uniqueEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()]
    uniqueEntries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const complete = !truncated && errors === 0
    const sortedGitRepositories = [...gitRepositories].sort((a, b) => a.localeCompare(b, 'en'))
    const digestInput = JSON.stringify({ authorizedRoots: canonicalRoots, outputRoot: outputRoot ?? null, outputRootIsGitRepository, gitRepositories: sortedGitRepositories, entries: uniqueEntries, coverage: { complete, truncated, errors, visited: uniqueEntries.length } })
    return {
      roots: canonicalRoots,
      ...(outputRoot ? { outputRoot } : {}),
      ...(outputRoot ? { outputRootIsGitRepository } : {}),
      gitRepositories: sortedGitRepositories,
      entries: uniqueEntries,
      coverage: { complete, truncated, roots: canonicalRoots.length, visited: uniqueEntries.length, errors },
      digest: createHash('sha256').update(digestInput).digest('hex')
    }
  }
}
