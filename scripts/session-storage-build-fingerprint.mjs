#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hashTree = (entries) => {
  const hash = createHash('sha256')
  const visit = (relative) => {
    if (relative === 'dist-electron/session-storage-build-manifest.json') return
    if (/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(relative) || relative.split(path.sep).includes('__tests__')) return
    const absolute = path.join(root, relative)
    const stat = fs.statSync(absolute)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name))
      return
    }
    hash.update(relative.replaceAll(path.sep, '/')).update('\0').update(fs.readFileSync(absolute)).update('\0')
  }
  for (const entry of entries) if (fs.existsSync(path.join(root, entry))) visit(entry)
  return hash.digest('hex')
}
const sourceEntries = ['electron', 'packages', 'src', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.electron.json', 'tsconfig.renderer.json', 'vite.config.ts']
const manifest = {
  sourceSha256: hashTree(sourceEntries),
  electronSha256: hashTree(['dist-electron']),
  rendererSha256: hashTree(['dist/renderer'])
}
fs.writeFileSync(path.join(root, 'dist-electron/session-storage-build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`[session-storage-build-fingerprint] ${JSON.stringify(manifest)}\n`)
