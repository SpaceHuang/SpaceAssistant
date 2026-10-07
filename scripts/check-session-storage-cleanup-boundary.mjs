import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'electron')
const allowedFiles = new Set([
  path.join(sourceRoot, 'sessionStorage', 'internal', 'sqliteCleanup.ts'),
  path.join(sourceRoot, 'sessionStorage', 'maintenance.ts'),
  path.join(sourceRoot, 'runtime', 'sessionStorageCleanupProduction.ts'),
])
const guardedNames = [
  'markSessionMessageContentWriteStopped',
  'beginSessionMessageContentCleanup',
  'clearNextSessionMessageContentBatch',
  'verifyAndCompleteSessionMessageContentCleanup',
]
const violations = []

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      visit(absolutePath)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || allowedFiles.has(absolutePath)) continue
    const source = fs.readFileSync(absolutePath, 'utf8')
    for (const name of guardedNames) {
      if (new RegExp(`\\b${name}\\b`).test(source)) violations.push(`${path.relative(root, absolutePath)} references ${name}`)
    }
  }
}

visit(sourceRoot)
if (violations.length) {
  console.error('[check:session-storage-cleanup-boundary] 生产代码必须经过受发布门禁保护的清理边界：')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('[check:session-storage-cleanup-boundary] 通过：清理原语仅由受门禁保护的边界和隔离测试调用')
