const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')

function waitForRenderer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000
    const poll = () => {
      const request = http.get('http://127.0.0.1:9240/', (response) => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) return resolve()
        retry()
      })
      request.on('error', retry)
      request.setTimeout(500, () => { request.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error('renderer did not become ready'))
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function launch(userDataDir) {
  return electron.launch({
    args: [`--user-data-dir=${userDataDir}`, path.join(root, 'dist-electron/electron/main.js')],
    cwd: root,
    env: { ...process.env, SPACEASSISTANT_DEV: '1', FORCE_COLOR: '0' }
  })
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-electron-parent-restart-'))
  let first
  let second
  let childPid
  const renderer = spawn('npm', ['run', 'dev:renderer'], { cwd: root, stdio: 'ignore', env: { ...process.env, FORCE_COLOR: '0' } })
  try {
    await waitForRenderer()
    first = await launch(userDataDir)
    const firstPage = await first.firstWindow()
    await firstPage.waitForLoadState('domcontentloaded')

    const prepared = await first.evaluate(({ BrowserWindow }, payload) => {
      const createRequire = process.getBuiltinModule('module').createRequire
      const mainRequire = createRequire(payload.mainEntry)
      const { spawn } = mainRequire('node:child_process')
      const { randomUUID } = mainRequire('node:crypto')
      const { openDatabase, getDefaultDbPath, createSession } = mainRequire(payload.databaseModule)
      const { createTurnCoordinatorStorage } = mainRequire(payload.storageModule)
      const { TurnRuntime } = mainRequire(payload.runtimeModule)
      const userData = mainRequire('electron').app.getPath('userData')
      const db = openDatabase(getDefaultDbPath(userData))
      const session = createSession(db, { name: 'electron-parent-restart-probe' })
      const token = `electron-parent-owner-${process.pid}-${Date.now()}`
      const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)', token], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      })
      child.unref()
      const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: Date.now, id: randomUUID } })
      const turn = runtime.prepare({ mode: 'create-user', requestId: 'electron-parent-restart-request', sessionId: session.id, input: { text: 'electron parent restart' }, config: {} })
      runtime.consume(turn.turnId, { type: 'tool-use', id: 'electron-parent-shell', toolName: 'run_shell', input: { command: 'sleep 30' }, eventSeq: 1 })
      runtime.consume(turn.turnId, { type: 'tool-progress', id: 'electron-parent-shell', seq: 1, text: 'started', processPid: child.pid, processGroupId: process.platform === 'darwin' ? child.pid : undefined, processOwnerToken: token })
      const current = runtime.coordinator.getTurn(turn.turnId)
      if (!current || !current.assistantMessage.toolCalls?.[0]?.processPid) throw new Error('electron main did not persist shell identity')
      const storage = createTurnCoordinatorStorage(db)
      if (!storage.checkpoint(turn.turnId, current.version, current.assistantMessage)) throw new Error('electron main checkpoint rejected shell snapshot')
      const result = { userData, sessionId: session.id, turnId: turn.turnId, childPid: child.pid, token, dbPath: getDefaultDbPath(userData) }
      db.close()
      return result
    }, {
      databaseModule: path.join(root, 'dist-electron/electron/database/index.js'),
      storageModule: path.join(root, 'dist-electron/electron/turnCoordinatorStorage.js'),
      runtimeModule: path.join(root, 'dist-electron/electron/turnRuntime.js'),
      mainEntry: path.join(root, 'dist-electron/electron/main.js')
    })
    childPid = prepared.childPid
    const firstProcess = first.process()
    await new Promise((resolve) => {
      firstProcess.once('exit', resolve)
      firstProcess.kill('SIGKILL')
    })
    first = undefined

    second = await launch(userDataDir)
    await second.firstWindow()
    const deadline = Date.now() + 5_000
    let exited = false
    while (Date.now() < deadline) {
      try { process.kill(childPid, 0) } catch { exited = true; break }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!exited) throw new Error(`startup cleanup did not terminate shell child ${childPid}`)
    const result = { userDataDir, childPid, parentKilled: true, startupCleanupVerified: true }
    console.log(`[chat-electron-parent-restart] ${JSON.stringify(result)}`)
  } finally {
    if (second) await second.close().catch(() => {})
    if (first) first.process().kill('SIGKILL')
    renderer.kill('SIGTERM')
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}

main().catch((error) => {
  console.error('[chat-electron-parent-restart] failed:', error)
  process.exitCode = 1
})
