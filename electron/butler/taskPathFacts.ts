import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, realpath, readdir } from 'node:fs/promises'
import path from 'node:path'

export type TaskPathFactEntry = {
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'special'
  relativePath: string
}

export type TaskPathFacts = {
  roots: string[]
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

  async collect(inputRoots: readonly string[]): Promise<TaskPathFacts> {
    if (!Array.isArray(inputRoots) || inputRoots.length === 0) throw new TaskPathFactsError('NO_ROOTS', '任务工作目录不能为空')
    const roots: string[] = []
    for (const input of inputRoots) {
      if (typeof input !== 'string' || input.trim().length === 0 || !path.isAbsolute(input)) throw new TaskPathFactsError('INVALID_ROOT', '任务工作目录无效')
      const canonical = await realpath(input)
      await access(canonical, constants.R_OK | constants.X_OK)
      const rootInfo = await lstat(canonical)
      if (!rootInfo.isDirectory()) throw new TaskPathFactsError('INVALID_ROOT', '任务工作目录必须是目录')
      roots.push(canonical)
    }
    const canonicalRoots = [...new Set(roots)].sort()
    const entries: TaskPathFactEntry[] = []
    let truncated = false
    let errors = 0
    for (const root of canonicalRoots) {
      let rootVisited = 0
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > this.limits.maxDepth || truncated) return
        let names: string[]
        try { names = await readdir(directory) } catch { errors += 1; return }
        names.sort((a, b) => a.localeCompare(b, 'en'))
        for (const name of names) {
          if (rootVisited >= this.limits.maxEntriesPerRoot || entries.length >= this.limits.maxEntriesTotal) { truncated = true; return }
          const fullPath = path.join(directory, name)
          let info
          try { info = await lstat(fullPath) } catch { errors += 1; continue }
          rootVisited += 1
          const kind: TaskPathFactEntry['kind'] = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'special'
          entries.push({ path: fullPath, relativePath: path.relative(root, fullPath).split(path.sep).join('/'), kind })
          if (kind === 'directory' && depth < this.limits.maxDepth) await walk(fullPath, depth + 1)
        }
      }
      await walk(root, 1)
    }
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const complete = !truncated && errors === 0
    const digestInput = JSON.stringify({ roots: canonicalRoots, entries, coverage: { complete, truncated, errors, visited: entries.length } })
    return {
      roots: canonicalRoots,
      entries,
      coverage: { complete, truncated, roots: canonicalRoots.length, visited: entries.length, errors },
      digest: createHash('sha256').update(digestInput).digest('hex')
    }
  }
}
