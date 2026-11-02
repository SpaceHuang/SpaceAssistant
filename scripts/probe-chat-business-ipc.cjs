const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { registerAgentIpc } = require('../dist-electron/electron/ipc/agentProtocolIpc.js')
const { openDatabase } = require('../dist-electron/electron/database/index.js')
const { createSession, getPersistedTurn, getMessages } = require('../dist-electron/electron/database/operations.js')
const { createSessionTurnRuntime, createSqliteSessionStorage } = require('../dist-electron/electron/sessionStorage/sqliteSessionStorage.js')

const sampleCount = Number(process.env.SPACEASSISTANT_IPC_SAMPLES || 1000)
const failureMode = process.env.SPACEASSISTANT_IPC_PROBE_FAILURE_MODE || ''
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 10000) throw new Error('SPACEASSISTANT_IPC_SAMPLES_INVALID')
if (failureMode && !['drop-projection', 'abnormal-terminal'].includes(failureMode)) throw new Error('SPACEASSISTANT_IPC_PROBE_FAILURE_MODE_INVALID')
const preload = path.join(__dirname, 'probe-chat-business-ipc-preload.cjs')
let probeWindow

app.disableHardwareAcceleration()

const db = openDatabase(':memory:')
const session = createSession(db, { name: 'business-ipc-probe' })
const sessionStorage = createSqliteSessionStorage(db)
const metrics = []
const turnRuntime = createSessionTurnRuntime(sessionStorage, {
  deps: { now: Date.now, id: () => require('node:crypto').randomUUID(), onMetric: (metric) => metrics.push(metric) },
  source: async () => ({ outcome: 'completed' }),
  onEvent: (turn, event) => probeWindow?.webContents.send('chat:turn-projection', { turn, event, probeSentAtMs: Date.now() })
})
let prepared

// 只替身模型与外部副作用；被测聊天通道使用生产 registerAgentIpc handler 和 SQLite session storage。
const ctx = {
  db,
  sessionStorage,
  backup: { schedule() {}, flush: async () => {}, backupImmediate: async () => {}, deleteBackup: async () => {} },
  workDirManager: {
    listProfiles: () => [], addProfile: () => undefined, updateProfile: () => undefined,
    removeProfile: () => undefined, switchProfile: async () => ({ success: true, sessions: [] }),
    getActiveProfile: () => undefined, getActiveWorkDir: () => process.cwd(),
    getActiveProfileId: () => 'probe', validateProfilesForSave: () => ({ valid: true }),
    validateProfileInput: () => ({ valid: true }), checkDirectoryWritable: () => ({ ok: true }),
    migrateFromLegacy: () => {}, persistProfiles: () => {}
  },
  getWorkDir: () => process.cwd(), setWorkDir: () => {},
  getUserDataPath: () => app.getPath('temp'), getApiKey: async () => null, setApiKey: async () => {},
  getBrowserDetectContext: () => ({ isPackaged: false, appPath: app.getAppPath(), devRoot: process.cwd() }),
  turnRuntime
}

registerAgentIpc(ipcMain, ctx)
prepared = turnRuntime.prepare({ mode: 'create-user', requestId: 'probe-request', sessionId: session.id, input: { text: 'probe' }, config: {} })
ipcMain.handle('probe:complete-turn', async () => {
  turnRuntime.bindRequest(prepared.requestId, prepared.turnId)
  return turnRuntime.executeWithSource(prepared.turnId, prepared.startToken, async () => {
    if (failureMode === 'abnormal-terminal') {
      turnRuntime.consume(prepared.turnId, { type: 'source-failed', eventSeq: 2 })
      return { outcome: 'failed' }
    }
    turnRuntime.consume(prepared.turnId, { type: 'source-completed', eventSeq: 2 })
    return { outcome: 'completed' }
  })
})

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, preload } })
  try {
    await window.loadURL('data:text/html,<html><body>business ipc probe</body></html>')
    probeWindow = window
    turnRuntime.consume(turnRuntime.listActive(session.id)[0].turnId, { type: 'content-delta', text: 'probe-event', eventSeq: 1 })
    const result = await window.webContents.executeJavaScript(`window.ipcBusinessProbe.run(${sampleCount}, ${JSON.stringify(session.id)})`, true)
    const persisted = getPersistedTurn(db, prepared.turnId)
    const persistedAssistant = persisted && getMessages(db, session.id).find((message) => message.id === persisted.assistantMessageId)
    const checks = [
      ['active-turn-projection', result.sampleCount === sampleCount],
      ['projection-version-increases', result.terminalProjectionVersion > result.initialProjectionVersion],
      ['terminal-completed-projection', result.terminalProjectionEvent === 'source-completed'],
      ['terminal-assistant-success', result.terminalAssistantStatus === 'completed'],
      ['active-turn-cleared', result.activeAfterTerminal === 0 && turnRuntime.listActive(session.id).length === 0],
      ['persisted-terminal-completed', persisted?.state === 'terminal' && persisted.outcome === 'completed'],
      ['persisted-assistant-success', persistedAssistant?.status === 'completed']
    ]
    console.log(`[chat-business-ipc] ${JSON.stringify({ ...result, checks: checks.map(([name, passed]) => ({ name, passed })), metricCount: metrics.length, metricKinds: metrics.map((metric) => metric.kind), persistedState: persisted?.state ?? null, persistedOutcome: persisted?.outcome ?? null, persistedVersion: persisted?.version ?? null, persistedAssistantStatus: persistedAssistant?.status ?? null })}`)
    const failed = checks.filter(([, passed]) => !passed)
    if (failed.length) throw new Error(`CHAT_IPC_BUSINESS_ASSERTION_FAILED:${failed.map(([name]) => name).join(',')}`)
    window.destroy()
    ctx.db.close()
    app.quit()
  } catch (error) {
    console.error('[chat-business-ipc] failed:', error)
    window.destroy()
    ctx.db.close()
    app.exit(1)
  }
})
