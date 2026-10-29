import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import path from 'node:path'

export type DirectoryWriteIdentity = Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'mtimeMs' | 'nlink'>
export type DirectoryWriteParentIdentity = Pick<Stats, 'dev' | 'ino' | 'mode' | 'size' | 'mtimeMs'>
export type DirectoryWriteFileIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'nlink'>
export type DirectoryWriteResult =
  | Readonly<{ ok: true; identity: DirectoryWriteIdentity; receipt?: Readonly<{ dev: number; ino: number; mode: number; size: number; nlink: number; sha256: string }> }>
  | Readonly<{ ok: false; caseId: 'write-directory-identity-changed' | 'write-file-identity-changed' | 'write-target-exists' | 'write-directory-cancelled' | 'write-directory-unavailable' | 'write-committed-receipt-invalid' }>

type Input = {
  directory: string
  expectedDirectoryIdentity: DirectoryWriteParentIdentity
  targetName: string
  tempName?: string
  body: Buffer | string
  expectedFileIdentity: DirectoryWriteFileIdentity | null
  mode?: number
  signal?: AbortSignal
  captureReceipt?: boolean
}

export const DIRECTORY_WRITER_SOURCE = String.raw`
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const identity = (s) => ({ dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, mtimeMs: s.mtimeMs, nlink: s.nlink })
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.nlink === b.nlink
const fail = (caseId) => { process.stdout.write(JSON.stringify({ ok: false, caseId })) }
const retryTransient = (operation) => {
  for (let attempt = 0; ; attempt++) {
    try { return operation() } catch (error) {
      if ((error.code !== 'EPERM' && error.code !== 'EACCES') || attempt >= 3) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** attempt)
    }
  }
}
const target = path.join('.', input.targetName)
const temp = path.join('.', input.tempName)
let tempCreated = false
let tempFd = null
let committed = false
const failCommitted = () => fail('write-committed-receipt-invalid')
try {
  if (path.basename(input.targetName) !== input.targetName || path.basename(input.tempName) !== input.tempName) throw new Error('invalid basename')
  const directoryBefore = identity(fs.statSync('.'))
  if (!sameDirectory(directoryBefore, input.expectedDirectoryIdentity)) { fail('write-directory-identity-changed'); process.exit(0) }
  let currentTarget = null
  try { currentTarget = identity(fs.lstatSync(target)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (input.expectedFileIdentity === null) {
    if (currentTarget !== null) { fail('write-target-exists'); process.exit(0) }
  } else if (currentTarget === null || !sameFile(currentTarget, input.expectedFileIdentity)) {
    fail('write-file-identity-changed'); process.exit(0)
  }
  const body = Buffer.from(input.bodyBase64, 'base64')
  const approvedSha256 = crypto.createHash('sha256').update(body).digest('hex')
  const fd = fs.openSync(temp, (input.captureReceipt ? fs.constants.O_RDWR : fs.constants.O_WRONLY) | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), input.mode)
  tempCreated = true
  tempFd = fd
  let offset = 0
  while (offset < body.length) {
    const written = fs.writeSync(fd, body, offset, body.length - offset, offset)
    if (written <= 0) throw new Error('zero-byte write')
    offset += written
  }
  fs.fsyncSync(fd)
  let receiptIdentity = null
  if (input.captureReceipt) {
    receiptIdentity = identity(fs.fstatSync(fd))
    if ((receiptIdentity.mode & 0o170000) !== 0o100000 || receiptIdentity.size !== body.length || receiptIdentity.nlink !== 1) {
      fail('write-file-identity-changed'); process.exit(0)
    }
    const preCommitHash = crypto.createHash('sha256')
    const preCommitBuffer = Buffer.alloc(64 * 1024)
    let preCommitOffset = 0
    while (preCommitOffset < receiptIdentity.size) {
      const bytesRead = fs.readSync(fd, preCommitBuffer, 0, Math.min(preCommitBuffer.length, receiptIdentity.size - preCommitOffset), preCommitOffset)
      if (bytesRead <= 0) { fail('write-file-identity-changed'); process.exit(0) }
      preCommitHash.update(preCommitBuffer.subarray(0, bytesRead))
      preCommitOffset += bytesRead
    }
    if (preCommitHash.digest('hex') !== approvedSha256) { fail('write-file-identity-changed'); process.exit(0) }
  }
  const directoryAfterWrite = identity(fs.statSync('.'))
  if (!sameDirectory(directoryAfterWrite, input.expectedDirectoryIdentity)) { fail('write-directory-identity-changed'); process.exit(0) }
  let latestTarget = null
  try { latestTarget = identity(fs.lstatSync(target)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (input.expectedFileIdentity === null) {
    if (latestTarget !== null) { fail('write-target-exists'); process.exit(0) }
    retryTransient(() => fs.linkSync(temp, target))
    committed = true
    fs.unlinkSync(temp)
    tempCreated = false
  } else {
    if (latestTarget === null || !sameFile(latestTarget, input.expectedFileIdentity)) { fail('write-file-identity-changed'); process.exit(0) }
    retryTransient(() => fs.renameSync(temp, target))
    committed = true
    tempCreated = false
  }
  const final = identity(fs.lstatSync(target))
  if (final.nlink !== 1) { failCommitted(); process.exit(0) }
  if (input.captureReceipt) {
    const hash = crypto.createHash('sha256')
    const readBuffer = Buffer.alloc(64 * 1024)
    let readOffset = 0
    while (readOffset < receiptIdentity.size) {
      const bytesRead = fs.readSync(fd, readBuffer, 0, Math.min(readBuffer.length, receiptIdentity.size - readOffset), readOffset)
      if (bytesRead <= 0) { failCommitted(); process.exit(0) }
      hash.update(readBuffer.subarray(0, bytesRead))
      readOffset += bytesRead
    }
    const opened = identity(fs.fstatSync(fd))
    const check = identity(fs.lstatSync(target))
    if (opened.dev !== receiptIdentity.dev || opened.ino !== receiptIdentity.ino || opened.mode !== receiptIdentity.mode || opened.size !== receiptIdentity.size || opened.mtimeMs !== receiptIdentity.mtimeMs || hash.copy().digest('hex') !== approvedSha256 ||
      opened.dev !== check.dev || opened.ino !== check.ino || opened.mode !== check.mode || opened.size !== check.size || opened.mtimeMs !== check.mtimeMs ||
      opened.nlink !== 1 || check.nlink !== 1 || (check.mode & 0o170000) !== 0o100000) { failCommitted(); process.exit(0) }
    process.stdout.write(JSON.stringify({ ok: true, identity: final, receipt: { dev: opened.dev, ino: opened.ino, mode: opened.mode, size: opened.size, nlink: opened.nlink, sha256: hash.digest('hex') } }))
  } else process.stdout.write(JSON.stringify({ ok: true, identity: final }))
} catch {
  fail(committed ? 'write-committed-receipt-invalid' : 'write-directory-unavailable')
} finally {
  if (tempFd !== null) { try { fs.closeSync(tempFd) } catch {} }
  if (tempCreated) { try { fs.unlinkSync(temp) } catch {} }
}
`

const DIRECTORY_TEMP_CLEANER_SOURCE = String.raw`
const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
try {
  const directory = fs.statSync('.')
  if (directory.dev !== input.expectedDirectoryIdentity.dev || directory.ino !== input.expectedDirectoryIdentity.ino || directory.mode !== input.expectedDirectoryIdentity.mode) {
    process.stdout.write(JSON.stringify({ ok: false }))
    process.exit(0)
  }
  for (const entry of fs.readdirSync('.', { withFileTypes: true })) {
    if (!entry.name.startsWith(input.tempPrefix) || !entry.isFile()) continue
    try {
      const file = fs.lstatSync(entry.name)
      if (file.isFile() && !file.isSymbolicLink() && file.nlink <= 1) fs.unlinkSync(entry.name)
    } catch {}
  }
  process.stdout.write(JSON.stringify({ ok: true }))
} catch {
  process.stdout.write(JSON.stringify({ ok: false }))
}
`

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' }
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export function writeFileAtomicallyBoundToDirectory(input: Input): Promise<DirectoryWriteResult> {
  if (input.signal?.aborted) return Promise.resolve({ ok: false, caseId: 'write-directory-cancelled' })
  if (path.basename(input.targetName) !== input.targetName || !input.targetName || (input.tempName && path.basename(input.tempName) !== input.tempName)) {
    return Promise.resolve({ ok: false, caseId: 'write-directory-unavailable' })
  }
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8')
  const tempName = input.tempName ?? `.sa-wtmp-${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`
  const { signal: _signal, ...serializable } = input
  const payload = JSON.stringify({ ...serializable, mode: input.mode ?? 0o600, tempName, bodyBase64: body.toString('base64') })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: DirectoryWriteResult) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    let stdout = ''
    let aborting = false
    const child = spawn(process.execPath, ['-e', DIRECTORY_WRITER_SOURCE], {
      cwd: input.directory,
      env: workerEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    child.stdin.end(payload)
    const abort = () => {
      aborting = true
      if (!child.kill()) finish({ ok: false, caseId: 'write-directory-cancelled' })
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.once('error', () => finish({ ok: false, caseId: 'write-directory-unavailable' }))
    child.once('close', (code) => {
      if (aborting) { finish({ ok: false, caseId: 'write-directory-cancelled' }); return }
      if (settled) return
      try {
        const result = JSON.parse(stdout) as DirectoryWriteResult
        if (result.ok === true || result.ok === false) finish(result)
        else finish({ ok: false, caseId: code === null ? 'write-directory-cancelled' : 'write-directory-unavailable' })
      } catch {
        finish({ ok: false, caseId: code === null ? 'write-directory-cancelled' : 'write-directory-unavailable' })
      }
    })
  })
}

export async function cleanupDirectoryTempsBoundToIdentity(input: {
  directory: string
  expectedDirectoryIdentity: DirectoryWriteParentIdentity
  tempPrefix: string
}): Promise<boolean> {
  const payload = JSON.stringify(input)
  return new Promise((resolve) => {
    let stdout = ''
    const child = spawn(process.execPath, ['-e', DIRECTORY_TEMP_CLEANER_SOURCE], {
      cwd: input.directory,
      env: workerEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    child.stdin.end(payload)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.once('error', () => resolve(false))
    child.once('close', () => {
      try { resolve((JSON.parse(stdout) as { ok?: unknown }).ok === true) }
      catch { resolve(false) }
    })
  })
}
