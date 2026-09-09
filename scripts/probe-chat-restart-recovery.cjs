const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { openDatabase, createSession, appendMessage, createPersistedTurn, getMessages, listPersistedTurns } = require('../dist-electron/electron/database/index.js')
const { createTurnCoordinatorStorage } = require('../dist-electron/electron/turnCoordinatorStorage.js')
const { TurnRuntime } = require('../dist-electron/electron/turnRuntime.js')

if (process.argv[2] === 'writer') {
  const db = openDatabase(process.argv[3])
  const session = createSession(db, { name: 'restart-probe' })
  appendMessage(db, { id: 'restart-user', sessionId: session.id, role: 'user', content: 'restart', timestamp: 1, status: 'sent' })
  appendMessage(db, { id: 'restart-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 2, status: 'streaming', toolCalls: [{ id: 'restart-shell', toolName: 'run_shell', input: { command: 'sleep 30' }, status: 'executing', riskLevel: 'high' }] })
  createPersistedTurn(db, { turnId: 'restart-turn', requestId: 'restart-request', sessionId: session.id, userMessageId: 'restart-user', assistantMessageId: 'restart-assistant', state: 'executing', version: 2, startToken: 'restart-token' })
  db.close()
  process.stdout.write(session.id)
  process.exit(0)
}
if (process.argv[2] === 'reader') {
  const db = openDatabase(process.argv[3])
  const turns = listPersistedTurns(db, 'executing')
  const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: Date.now, id: () => require('node:crypto').randomUUID() } })
  const recoveredCount = runtime.recover()
  const recoveredTurns = listPersistedTurns(db)
  const assistant = turns[0] && getMessages(db, turns[0].sessionId).find((message) => message.id === turns[0].assistantMessageId)
  const recovered = recoveredTurns.find((turn) => turn.turnId === 'restart-turn')
  const afterRecoveryAssistant = turns[0] && getMessages(db, turns[0].sessionId).find((message) => message.id === turns[0].assistantMessageId)
  const result = { turnCount: turns.length, recoveredCount, requestId: turns[0]?.requestId, version: turns[0]?.version, assistantStatus: afterRecoveryAssistant?.status ?? assistant?.status, toolStatus: afterRecoveryAssistant?.toolCalls?.[0]?.status ?? assistant?.toolCalls?.[0]?.status, recoveredState: recovered?.state, recoveredOutcome: recovered?.outcome }
  db.close()
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-restart-process-'))
const dbPath = path.join(dir, 'restart.db')
try {
  const writer = spawnSync(process.execPath, [__filename, 'writer', dbPath], { encoding: 'utf8' })
  if (writer.status !== 0) throw new Error(writer.stderr || 'writer failed')
  const reader = spawnSync(process.execPath, [__filename, 'reader', dbPath], { encoding: 'utf8' })
  if (reader.status !== 0) throw new Error(reader.stderr || 'reader failed')
  const result = JSON.parse(reader.stdout)
  if (result.turnCount !== 1 || result.recoveredCount !== 1 || result.requestId !== 'restart-request' || result.version !== 2 || result.toolStatus !== 'failed' || result.recoveredState !== 'terminal') throw new Error(`unexpected recovery: ${reader.stdout}`)
  console.log(`[chat-restart-recovery] ${JSON.stringify({ writerPid: writer.pid, readerPid: reader.pid, ...result })}`)
} finally {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix) } catch {} }
  fs.rmSync(dir, { recursive: true, force: true })
}
