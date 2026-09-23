#!/usr/bin/env node
/**
 * Shared IPC/config type gate (WP7 companion).
 * Real renderer typecheck is `npm run typecheck:renderer` → tsc -p tsconfig.renderer.json.
 * This script only typechecks the shared surface via tsconfig.renderer.gate.json.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tscCandidates = [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  // Git worktrees commonly share the parent repository's dependencies. Keep the
  // gate runnable without copying a second node_modules tree into every worktree.
  path.resolve(root, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc')
]
const tsc = tscCandidates.find((candidate) => fs.existsSync(candidate))
if (!tsc) {
  console.error(`[typecheck:shared] TypeScript compiler not found. Checked:\n${tscCandidates.join('\n')}`)
  process.exit(1)
}
const project = path.join(root, 'tsconfig.renderer.gate.json')

const result = spawnSync(process.execPath, [tsc, '-p', project, '--noEmit'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit'
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

console.log('[typecheck:shared] ok — tsc -p tsconfig.renderer.gate.json --noEmit')
