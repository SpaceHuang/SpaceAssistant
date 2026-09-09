const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { registerAppIpcHandlers } = require('../dist-electron/electron/appIpc.js')
const { openDatabase } = require('../dist-electron/electron/database/index.js')
const { createSession } = require('../dist-electron/electron/database/index.js')
const { getPersistedTurn, getMessages } = require('../dist-electron/electron/database/index.js')
const { createTurnCoordinatorStorage } = require('../dist-electron/electron/turnCoordinatorStorage.js')
const { TurnRuntime } = require('../dist-electron/electron/turnRuntime.js')

const sampleCount = Number(process.env.SPACEASSISTANT_IPC_SAMPLES || 1000)
const preload = path.join(__dirname, 'probe-chat-business-ipc-preload.cjs')
let probeWindow

app.disableHardwareAcceleration()

const db = openDatabase(':memory:')
const session = createSession(db, { name: 'business-ipc-probe' })
const metrics = []
const turnRuntime = new TurnRuntime({
  storage: createTurnCoordinatorStorage(db),
  deps: { now: Date.now, id: () => require('node:crypto').randomUUID(), onMetric: (metric) => metrics.push(metric) },
  source: async () => ({ outcome: 'completed' }),
  onEvent: (turn, event) => probeWindow?.webContents.send('chat:turn-projection', { turn, event, probeSentAtMs: Date.now() })
})
let prepared

// 只替身隔离模型/存储副作用；IPC 注册本身走生产 registerAppIpcHandlers。
const ctx = {
  db,
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

registerAppIpcHandlers(ipcMain, ctx)
prepared = turnRuntime.prepare({ mode: 'create-user', requestId: 'probe-request', sessionId: session.id, input: { text: 'probe' }, config: {} })
ipcMain.handle('probe:complete-turn', async () => {
  turnRuntime.bindRequest(prepared.requestId, prepared.turnId)
  return turnRuntime.executeWithSource(prepared.turnId, prepared.startToken, async () => {
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
    console.log(`[chat-business-ipc] ${JSON.stringify({ ...result, activeTurnCount: turnRuntime.listActive(session.id).length, metricCount: metrics.length, metricKinds: metrics.map((metric) => metric.kind), metrics, persistedState: persisted?.state ?? null, persistedVersion: persisted?.version ?? null, persistedAssistantStatus: persistedAssistant?.status ?? null })}`)
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
