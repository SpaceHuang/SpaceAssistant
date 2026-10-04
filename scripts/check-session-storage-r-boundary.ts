import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const sessionStorageCleanupEntryPoints = [
  'markSessionMessageContentWriteStopped',
  'beginSessionMessageContentCleanup',
  'clearNextSessionMessageContentBatch',
  'verifyAndCompleteSessionMessageContentCleanup',
] as const

export type SessionStorageCleanupReference = {
  path: string
  symbol: (typeof sessionStorageCleanupEntryPoints)[number]
}

export function findForbiddenSessionStorageCleanupReferences(
  files: Array<{ path: string; source: string }>,
): SessionStorageCleanupReference[] {
  const violations: SessionStorageCleanupReference[] = []
  for (const file of files) {
    if (file.path.endsWith('/sessionStorageCutover.ts') || /\.test\.[cm]?tsx?$/.test(file.path)) continue
    for (const symbol of sessionStorageCleanupEntryPoints) {
      if (new RegExp(`\\b${symbol}\\b`).test(file.source)) violations.push({ path: file.path, symbol })
    }
  }
  return violations
}

function collectTypeScriptFiles(directory: string, root: string): Array<{ path: string; source: string }> {
  const files: Array<{ path: string; source: string }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(absolutePath, root))
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push({
        path: path.relative(root, absolutePath).split(path.sep).join('/'),
        source: readFileSync(absolutePath, 'utf8'),
      })
    }
  }
  return files
}

export function inspectSessionStorageReleaseBoundary(root: string): SessionStorageCleanupReference[] {
  return findForbiddenSessionStorageCleanupReferences(collectTypeScriptFiles(path.join(root, 'electron'), root))
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(currentFile).href) {
  const root = path.resolve(path.dirname(currentFile), '..')
  const violations = inspectSessionStorageReleaseBoundary(root)
  if (violations.length > 0) {
    console.error('[check:session-storage-r-boundary] FAIL: cleanup entry points must not be wired into the R runtime')
    for (const violation of violations) console.error(`  - ${violation.path}: ${violation.symbol}`)
    process.exitCode = 1
  } else {
    console.log('[check:session-storage-r-boundary] OK: cleanup protocol APIs have no production TypeScript callers')
  }
}
