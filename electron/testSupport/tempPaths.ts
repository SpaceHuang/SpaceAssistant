import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'

// Fixture temp paths follow CI reliability INV-04: use OS-managed unique roots, independent of host-specific paths.
const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  roots.clear()
})

export function mkdtempRoot(prefix = 'spaceassistant-test-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.add(root)
  return root
}

export function uniqueFilePath(prefix = 'spaceassistant-test-', extension = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.add(root)
  return path.join(root, `fixture${extension}`)
}
