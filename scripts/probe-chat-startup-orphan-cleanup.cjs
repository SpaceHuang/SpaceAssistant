const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { openDatabase, createSession, getMessage, listPersistedTurns } = require('../dist-electron/electron/database/index.js')
const { createTurnCoordinatorStorage } = require('../dist-electron/electron/turnCoordinatorStorage.js')
const { TurnRuntime } = require('../dist-electron/electron/turnRuntime.js')
const { cleanupPersistedOrphansOnStartup } = require('../dist-electron/electron/shell/startupOrphanCleanup.js')
const { cleanupOrphanProcess } = require('../dist-electron/electron/shell/orphanProcessCleanup.js')

;(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-startup-orphan-'))
const dbPath = path.join(dir, 'spaceassistant-data.db')
const token = `startup-owner-${process.pid}-${Date.now()}`
let child
try {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', token], { detached: true, stdio: 'ignore' })
  child.unref()
  const db = openDatabase(dbPath)
  const session = createSession(db, { name: 'startup-orphan-probe' })
  const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: Date.now, id: randomUUID } })
  const prepared = runtime.prepare({ mode: 'create-user', requestId: 'startup-orphan-request', sessionId: session.id, input: { text: 'startup orphan' }, config: {} })
  runtime.consume(prepared.turnId, { type: 'tool-use', id: 'startup-shell', toolName: 'run_shell', input: { command: 'sleep 30' }, eventSeq: 1 })
  runtime.consume(prepared.turnId, { type: 'tool-progress', id: 'startup-shell', seq: 1, text: 'started', processPid: child.pid, processGroupId: process.platform === 'darwin' ? child.pid : undefined, processOwnerToken: token })
  const current = runtime.coordinator.getTurn(prepared.turnId)
  if (!current || !current.assistantMessage.toolCalls?.[0]?.processPid) throw new Error('runtime did not retain shell identity')
  const storage = createTurnCoordinatorStorage(db)
  if (!storage.checkpoint(prepared.turnId, current.version, current.assistantMessage)) throw new Error('formal checkpoint rejected startup probe snapshot')
  const audited = []
  const count = cleanupPersistedOrphansOnStartup({ listTurns: () => listPersistedTurns(db), getMessage: (id) => getMessage(db, id), cleanup: cleanupOrphanProcess, audit: (entry) => audited.push(entry) })
  Promise.resolve(count).then((cleaned) => {
    let exited = false
    try { process.kill(child.pid, 0) } catch { exited = true }
    console.log(`[chat-startup-orphan-cleanup] ${JSON.stringify({ cleaned, audited, childPid: child.pid, exited })}`)
    db.close()
    process.exit(cleaned === 1 && exited && audited[0]?.result === 'cleaned' ? 0 : 1)
  })
} catch (error) {
  console.error('[chat-startup-orphan-cleanup] failed:', error)
  try { if (child?.pid) process.kill(child.pid, 'SIGTERM') } catch {}
  process.exitCode = 1
} finally {
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, 100)
}
})().catch((error) => { console.error('[chat-startup-orphan-cleanup] failed:', error); process.exitCode = 1 })
