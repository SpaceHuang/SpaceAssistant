import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const sourceDbPath = process.argv[2]
if (!sourceDbPath) throw new Error('Usage: node --import tsx scripts/session-storage-cold-start-profile.ts <db-path>')

async function main(): Promise<void> {
const requiredPhases = [
  'database.open-and-migrations',
  'canonical-history.classification',
  'canonical-history.recovery',
  'session-ledger.reconcile'
]
const root = process.cwd()
const mainEntry = path.join(root, 'dist-electron/electron/main.js')
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-cold-start-'))
const userDataArg = path.join(temporaryRoot, 'user-data')
const userDataPath = `${userDataArg}-dev`
const isolatedWorkDir = path.join(temporaryRoot, 'workspace')
const testDbPath = path.join(userDataPath, 'spaceassistant-data.db')
let child: ReturnType<typeof spawn> | undefined

try {
  await fs.mkdir(userDataPath, { recursive: true })
  await fs.mkdir(isolatedWorkDir, { recursive: true })
  const source = new DatabaseSync(sourceDbPath, { readOnly: true })
  try {
    const image = source.serialize()
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
    setConfig.run('config.workDir', isolatedWorkDir, now, now)
    setConfig.run('config.workDirProfiles', '[]', now, now)
    clone.prepare("DELETE FROM configs WHERE key NOT IN ('config.workDir','config.workDirProfiles')").run()
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
    ELECTRON_START_URL: 'http://127.0.0.1:1'
  }
  child = spawn(electronExecutable, [`--user-data-dir=${userDataArg}`, mainEntry], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  let errorOutput = ''
  child.stdout?.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-2_000_000) })
  child.stderr?.on('data', (data: Buffer) => { errorOutput = (errorOutput + data.toString()).slice(-2_000_000) })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const found = requiredPhases.filter((phase) => output.includes(phase))
    if (found.length === requiredPhases.length) break
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}; phases: ${found.join(', ')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const missing = requiredPhases.filter((phase) => !output.includes(phase))
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
  console.log(JSON.stringify({ phases: startupLines, databaseBytes: (await fs.stat(testDbPath)).size }, null, 2))
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
