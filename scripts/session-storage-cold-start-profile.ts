import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const sourceDbPath = process.argv[2]
if (!sourceDbPath) throw new Error('Usage: node --import tsx scripts/session-storage-cold-start-profile.ts <db-path> [--include-synthetic-sidecars]')
const includeSyntheticSidecars = process.argv[3] === '--include-synthetic-sidecars'

function directoryBytes(directory: string): number {
  let total = 0
  for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += directoryBytes(entryPath)
    else if (entry.isFile()) total += fsSync.statSync(entryPath).size
  }
  return total
}

async function main(): Promise<void> {
const requiredPhases = [
  'database.open-and-migrations',
  'canonical-history.classification',
  'canonical-history.recovery',
  'session-ledger.reconcile',
  'app.start-to-renderer-loaded'
]
const root = process.cwd()
const mainEntry = path.join(root, 'dist-electron/electron/main.js')
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-cold-start-'))
const rendererRoot = path.join(root, 'dist', 'renderer')
const userDataArg = path.join(temporaryRoot, 'user-data')
const userDataPath = `${userDataArg}-dev`
const isolatedWorkDir = path.join(temporaryRoot, 'workspace')
const testDbPath = path.join(userDataPath, 'spaceassistant-data.db')
let child: ReturnType<typeof spawn> | undefined
let rendererServer: ReturnType<typeof http.createServer> | undefined
let rendererLoadedAt: number | undefined
let configuredWorkDir: string | undefined
let configuredProfiles: Array<Record<string, unknown> & { path: string }> = []
let copiedWorkspaceRoots = 0
let copiedSpillBytes = 0

try {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.mkdir(isolatedWorkDir, { recursive: true })
  if (!fsSync.existsSync(path.join(rendererRoot, 'index.html'))) {
    throw new Error('Built renderer missing at dist/renderer; run the renderer build before profiling')
  }
  rendererServer = http.createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
      const filePath = path.resolve(rendererRoot, relativePath)
      if (!filePath.startsWith(`${path.resolve(rendererRoot)}${path.sep}`) && filePath !== path.join(rendererRoot, 'index.html')) {
        response.writeHead(403).end()
        return
      }
      const body = await fs.readFile(filePath)
      const extension = path.extname(filePath)
      const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' } as Record<string, string>)[extension] ?? 'application/octet-stream'
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' }).end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    rendererServer?.once('error', reject)
    rendererServer?.listen(0, '127.0.0.1', resolve)
  })
  const address = rendererServer.address()
  if (!address || typeof address === 'string') throw new Error('Unable to bind local renderer server')
  const source = new DatabaseSync(sourceDbPath, { readOnly: true })
  try {
    if (includeSyntheticSidecars) {
      const marker = source.prepare("SELECT value FROM configs WHERE key='sessionStorage.syntheticProfileFixture'").get() as { value: string } | undefined
      if (!marker?.value.startsWith('synthetic-session-storage-')) {
        throw new Error('Synthetic sidecar profiling requires a marked synthetic profile database')
      }
      configuredWorkDir = (source.prepare("SELECT value FROM configs WHERE key='config.workDir'").get() as { value: string } | undefined)?.value
      const rawProfiles = (source.prepare("SELECT value FROM configs WHERE key='config.workDirProfiles'").get() as { value: string } | undefined)?.value
      if (rawProfiles) {
        const parsed: unknown = JSON.parse(rawProfiles)
        if (!Array.isArray(parsed) || parsed.some((profile) => !profile || typeof profile !== 'object' || typeof (profile as { path?: unknown }).path !== 'string')) {
          throw new Error('Synthetic profile workspace configuration is malformed')
        }
        configuredProfiles = parsed as Array<Record<string, unknown> & { path: string }>
      }
    }
    const image = (source as DatabaseSync & { serialize(): Uint8Array }).serialize()
    if (!image) throw new Error('SQLite did not return a consistent database snapshot')
    await fs.writeFile(testDbPath, image)
  } finally {
    source.close()
  }

  const clone = new DatabaseSync(testDbPath)
  try {
    const now = Date.now()
    const setConfig = clone.prepare(`INSERT INTO configs(key, value, created_at, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    clone.prepare("DELETE FROM configs WHERE key NOT IN ('config.workDir','config.workDirProfiles')").run()
    const workDirCopies = new Map<string, string>()
    if (includeSyntheticSidecars) {
      const sourceRoots = [configuredWorkDir, ...configuredProfiles.map(({ path: profilePath }) => profilePath)]
        .filter((value): value is string => Boolean(value?.trim()))
      for (const sourceRoot of [...new Set(sourceRoots.map((value) => path.resolve(value)))]) {
        const sessionsSource = path.join(sourceRoot, 'sessions')
        if (!fsSync.existsSync(sessionsSource)) continue
        const isolatedRoot = path.join(temporaryRoot, `workspace-${workDirCopies.size + 1}`)
        fsSync.cpSync(sessionsSource, path.join(isolatedRoot, 'sessions'), { recursive: true, errorOnExist: true })
        workDirCopies.set(sourceRoot, isolatedRoot)
        copiedWorkspaceRoots += 1
      }
      for (const spillName of ['spill', 'spill-degraded']) {
        const spillSource = path.join(path.dirname(path.resolve(sourceDbPath)), spillName)
        if (!fsSync.existsSync(spillSource)) continue
        const spillDestination = path.join(userDataPath, spillName)
        fsSync.cpSync(spillSource, spillDestination, { recursive: true, errorOnExist: true })
        const sourceBytes = directoryBytes(spillSource)
        if (sourceBytes !== directoryBytes(spillDestination)) throw new Error(`Synthetic ${spillName} copy verification failed`)
        copiedSpillBytes += sourceBytes
      }
    }
    const isolatedPrimary = includeSyntheticSidecars && configuredWorkDir
      ? workDirCopies.get(path.resolve(configuredWorkDir)) ?? isolatedWorkDir
      : isolatedWorkDir
    const isolatedProfiles = includeSyntheticSidecars
      ? configuredProfiles.map((profile) => ({ ...profile, path: workDirCopies.get(path.resolve(profile.path)) ?? isolatedWorkDir }))
      : []
    setConfig.run('config.workDir', isolatedPrimary, now, now)
    setConfig.run('config.workDirProfiles', JSON.stringify(isolatedProfiles), now, now)
    for (const table of ['automation_tasks', 'automation_task_runs']) {
      if (clone.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        clone.exec(`DELETE FROM "${table}"`)
      }
    }
  } finally {
    clone.close()
  }

  const require = createRequire(import.meta.url)
  const electronExecutable = require('electron') as string
  const env = {
    ...process.env,
    HOME: temporaryRoot,
    XDG_CONFIG_HOME: temporaryRoot,
    SPACEASSISTANT_DEV: '1',
    ELECTRON_START_URL: `http://127.0.0.1:${address.port}`
  }
  const childSpawnedAt = Date.now()
  child = spawn(electronExecutable, [`--user-data-dir=${userDataArg}`, mainEntry], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  let errorOutput = ''
  const recordOutput = (data: Buffer, stream: 'stdout' | 'stderr') => {
    const value = data.toString()
    if (stream === 'stdout') output = (output + value).slice(-2_000_000)
    else errorOutput = (errorOutput + value).slice(-2_000_000)
    if (rendererLoadedAt === undefined && `${output}\n${errorOutput}`.includes('"phase":"app.start-to-renderer-loaded"')) rendererLoadedAt = Date.now()
  }
  child.stdout?.on('data', (data: Buffer) => recordOutput(data, 'stdout'))
  child.stderr?.on('data', (data: Buffer) => recordOutput(data, 'stderr'))
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const found = requiredPhases.filter((phase) => `${output}\n${errorOutput}`.includes(phase))
    if (found.length === requiredPhases.length) break
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}; phases: ${found.join(', ')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const combinedOutput = `${output}\n${errorOutput}`
  const missing = requiredPhases.filter((phase) => !combinedOutput.includes(phase))
  if (missing.length) {
    const startupLines = `${output}\n${errorOutput}`.split(/\r?\n/).filter((line) => line.includes('[startup]'))
    throw new Error(`Startup profile timed out; missing phases: ${missing.join(', ')}; observed: ${startupLines.join('\n')}`)
  }

  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { child?.kill('SIGKILL'); resolve() }, 10_000)
    child?.once('exit', () => { clearTimeout(timeout); resolve() })
  })
  const startupLines = `${output}\n${errorOutput}`.split(/\r?\n/).filter((line) => line.includes('[startup]'))
  const rendererLoadLine = startupLines.find((line) => line.includes('"phase":"app.start-to-renderer-loaded"'))
  const rendererLoadMarker = rendererLoadLine ? JSON.parse(rendererLoadLine.slice(rendererLoadLine.indexOf('{'))) as {
    appVersion?: string; electronVersion?: string; nodeVersion?: string; sqliteVersion?: string
  } : undefined
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    measurementScope: { startup: 'new-process-to-renderer-load', osFilesystemCacheControlled: false, sampleCount: 1,
      syntheticSidecarsIncluded: includeSyntheticSidecars, copiedWorkspaceRoots, copiedSpillBytes },
    environment: { platform: process.platform, arch: process.arch, osRelease: os.release(), nodeVersion: rendererLoadMarker?.nodeVersion ?? process.versions.node,
      electronVersion: rendererLoadMarker?.electronVersion ?? null, appVersion: rendererLoadMarker?.appVersion ?? null,
      sqliteVersion: rendererLoadMarker?.sqliteVersion ?? null },
    coldStartWallMs: rendererLoadedAt === undefined ? null : rendererLoadedAt - childSpawnedAt,
    phases: startupLines,
    databaseBytes: (await fs.stat(testDbPath)).size
  }, null, 2))
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  if (rendererServer?.listening) await new Promise<void>((resolve) => rendererServer?.close(() => resolve()))
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
