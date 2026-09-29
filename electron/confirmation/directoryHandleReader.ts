import { spawn } from 'node:child_process'
import type { Stats } from 'node:fs'

export type DirectoryIdentity = Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'mtimeMs'>
export type BoundDirectoryEntry = Readonly<{ name: string; isDirectory: boolean; size?: number; mtimeMs?: number }>
export type BoundDirectoryRead =
  | Readonly<{ ok: true; entries: readonly BoundDirectoryEntry[] }>
  | Readonly<{ ok: false; caseId: 'read-directory-identity-changed' | 'read-directory-cancelled' | 'read-directory-unavailable' }>

// The child cwd is a kernel-held directory reference. Both readdir('.') and child lstat
// happen relative to it, so renaming/replacing the original path cannot redirect enumeration.
const DIRECTORY_READER_SOURCE = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const expected = JSON.parse(process.argv[1])
const identity = (s) => ({ dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs })
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
try {
  const actualPath = path.resolve(process.cwd())
  const expectedPath = path.resolve(expected.path)
  const normalizePath = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  if (normalizePath(actualPath) !== normalizePath(expectedPath)) {
    process.stdout.write(JSON.stringify({ ok: false, caseId: 'read-directory-identity-changed' }))
    process.exit(0)
  }
  const opened = fs.statSync('.')
  const actual = identity(opened)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mode !== expected.mode || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    process.stdout.write(JSON.stringify({ ok: false, caseId: 'read-directory-identity-changed' }))
    process.exit(0)
  }
  const entries = fs.readdirSync('.', { withFileTypes: true }).map((entry) => {
    let size
    let mtimeMs
    try {
      const stat = fs.lstatSync(path.join('.', entry.name))
      mtimeMs = stat.mtimeMs
      if (stat.isFile()) size = stat.size
    } catch {}
    return { name: entry.name, isDirectory: entry.isDirectory(), ...(size === undefined ? {} : { size }), ...(mtimeMs === undefined ? {} : { mtimeMs }) }
  })
  const after = fs.statSync('.')
  if (!same(opened, after)) {
    process.stdout.write(JSON.stringify({ ok: false, caseId: 'read-directory-identity-changed' }))
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({ ok: true, entries }))
} catch {
  process.stdout.write(JSON.stringify({ ok: false, caseId: 'read-directory-unavailable' }))
}
`

function minimalWorkerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' }
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export function readDirectoryBoundToIdentity(directory: string, expected: DirectoryIdentity, signal?: AbortSignal): Promise<BoundDirectoryRead> {
  if (signal?.aborted) return Promise.resolve({ ok: false, caseId: 'read-directory-cancelled' })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: BoundDirectoryRead) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    let stdout = ''
    let aborting = false
    const child = spawn(process.execPath, ['-e', DIRECTORY_READER_SOURCE, JSON.stringify({ ...expected, path: directory })], {
      cwd: directory,
      env: minimalWorkerEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const abort = () => {
      aborting = true
      if (!child.kill()) finish({ ok: false, caseId: 'read-directory-cancelled' })
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.once('error', () => finish({ ok: false, caseId: 'read-directory-unavailable' }))
    child.once('close', (code) => {
      if (aborting) { finish({ ok: false, caseId: 'read-directory-cancelled' }); return }
      if (settled) return
      try {
        const result = JSON.parse(stdout) as BoundDirectoryRead
        if (result.ok === true || result.ok === false) finish(result)
        else finish({ ok: false, caseId: 'read-directory-unavailable' })
      } catch {
        finish({ ok: false, caseId: code === null ? 'read-directory-cancelled' : 'read-directory-unavailable' })
      }
    })
  })
}
