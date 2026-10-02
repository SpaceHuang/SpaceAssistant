const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { registerAppIpcHandlers } = require('../dist-electron/electron/appIpc.js')
const {
  appendMessage, createPersistedTurn, createSession, getDbConnection, getPersistedTurn,
  openDatabase, updatePersistedTurnState
} = require('../dist-electron/electron/database/index.js')
const { SqliteAgentHistory } = require('../dist-electron/electron/runtime/sqliteAgentHistory.js')
const { resolveContinuationSafetySnapshot } = require('../dist-electron/electron/ipc/agentProtocolIpc.js')
const { createAgentRuntime } = require('../dist-electron/electron/runtime/agentRuntime.js')
const { setDefaultAgentRuntime } = require('../dist-electron/electron/runtime/agentRuntimeDefaults.js')

app.disableHardwareAcceleration()
let probeWindow
let db
let profilePath
let workDir

async function main() {
  console.log('[agent-continuation-ipc] preparing isolated profile')
  profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-agent-continuation-profile-'))
  app.setPath('userData', profilePath)
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-agent-continuation-workdir-'))
  db = openDatabase(':memory:')
  console.log('[agent-continuation-ipc] creating source checkpoint')
  const session = createSession(db, { name: 'agent-continuation-ipc-probe' })
  const user = appendMessage(db, { id: 'probe-user', sessionId: session.id, role: 'user', content: 'continue probe', timestamp: 1, status: 'sent' })
  const assistant = appendMessage(db, { id: 'probe-assistant', sessionId: session.id, role: 'assistant', content: 'provider failure', timestamp: 2, status: 'failed' })
  const workDirManager = {
    listProfiles: () => [], getActiveProfileId: () => 'probe-profile', getActiveWorkDir: () => workDir,
    getActiveProfile: () => undefined, addProfile: () => undefined, updateProfile: () => undefined,
    removeProfile: () => undefined, switchProfile: async () => ({ success: true, sessions: [] }),
    validateProfilesForSave: () => ({ valid: true }), validateProfileInput: () => ({ valid: true }),
    checkDirectoryWritable: () => ({ ok: true }), migrateFromLegacy: () => undefined, persistProfiles: () => undefined
  }
  const ctx = {
    db,
    backup: { schedule: () => undefined, flush: async () => undefined, backupImmediate: async () => undefined, deleteBackup: async () => undefined },
    workDirManager, getWorkDir: () => workDir, setWorkDir: () => undefined,
    getUserDataPath: () => profilePath, getApiKey: async () => null, setApiKey: async () => undefined,
    getBrowserDetectContext: () => ({ isPackaged: false, appPath: app.getAppPath(), devRoot: process.cwd() }),
    executeTurn: async (_sender, payload) => { updatePersistedTurnState(db, payload.turnId, 'terminal', { outcome: 'completed' }) }
  }
  // Production main.ts installs this before IPC registration; the probe only needs its no-op audit sink.
  setDefaultAgentRuntime(createAgentRuntime())
  const safetySnapshot = resolveContinuationSafetySnapshot(ctx, session.id, 'desktop')
  createPersistedTurn(db, {
    turnId: 'probe-source-turn', requestId: 'probe-source-invocation', sessionId: session.id,
    userMessageId: user.message.id, assistantMessageId: assistant.message.id,
    contextBoundarySequence: user.sequence - 1, state: 'terminal', outcome: 'failed', startToken: 'probe-source-token',
    executionConfig: { lane: 'desktop', model: 'probe-model', continuationSafetySnapshot: safetySnapshot }
  })
  const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 10, session.id)
  await history.appendBatch([
    { invocationId: 'probe-source-invocation', turnId: 'probe-source-turn', sequence: 1, schemaVersion: 1, eventId: 'probe-context', idempotencyKey: 'probe-context', kind: 'invocation-context-committed', payload: { messages: [{ role: 'user', content: 'continue probe' }], requiredUserMessage: { id: user.message.id, message: { role: 'user', content: 'continue probe' } } } },
    { invocationId: 'probe-source-invocation', turnId: 'probe-source-turn', sequence: 2, schemaVersion: 1, eventId: 'probe-response', idempotencyKey: 'probe-response', kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'provider failure' } } },
    { invocationId: 'probe-source-invocation', turnId: 'probe-source-turn', sequence: 3, schemaVersion: 1, eventId: 'probe-failed', idempotencyKey: 'probe-failed', kind: 'invocation-failed', payload: { status: 'failed' } }
  ], 0)

  console.log('[agent-continuation-ipc] registering production IPC handlers')
  registerAppIpcHandlers(ipcMain, ctx)
  console.log('[agent-continuation-ipc] awaiting Electron readiness')
  await app.whenReady()
  console.log('[agent-continuation-ipc] creating hidden renderer')
  probeWindow = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, 'probe-agent-continuation-ipc-preload.cjs')
  } })
  await probeWindow.loadURL('data:text/html,<html><body>continuation IPC probe</body></html>')
  console.log('[agent-continuation-ipc] invoking continuation handler')
  const response = await probeWindow.webContents.executeJavaScript(`window.agentContinuationProbe.continueFromCheckpoint(${JSON.stringify({
    sessionId: session.id, sourceInvocationId: 'probe-source-invocation', requestIdempotencyKey: 'probe-key'
  })})`, true)
  const target = response.accepted ? getPersistedTurn(db, response.targetTurnId) : undefined
  const continuation = response.accepted
    ? getDbConnection(db).prepare('SELECT status FROM agent_continuations WHERE continuation_id = ?').get(response.continuationId)
    : undefined
  if (!response.accepted || !target || target.requestId !== response.targetInvocationId || continuation?.status !== 'completed') {
    throw new Error(`continuation IPC probe failed: ${JSON.stringify({ accepted: response.accepted, reason: response.reason, targetPrepared: Boolean(target), continuationStatus: continuation?.status })}`)
  }
  console.log(`[agent-continuation-ipc] ${JSON.stringify({ accepted: response.accepted, status: continuation.status, targetTurnState: target.state, executionDispatched: true })}`)
}

main().catch((error) => {
  console.error('[agent-continuation-ipc] failed:', error)
  process.exitCode = 1
}).finally(async () => {
  probeWindow?.destroy()
  db?.close()
  if (workDir) await fs.rm(workDir, { recursive: true, force: true })
  if (profilePath) await fs.rm(profilePath, { recursive: true, force: true })
  app.quit()
})
