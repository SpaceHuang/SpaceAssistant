const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '../..')
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const resultPath = process.argv[3]
const quantiles = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50Ms: +s[Math.floor((s.length - 1) * .5)].toFixed(3), p95Ms: +s[Math.floor((s.length - 1) * .95)].toFixed(3), maxMs: +s.at(-1).toFixed(3) } }
const byteQuantiles = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50Bytes: s[Math.floor((s.length - 1) * .5)], p95Bytes: s[Math.floor((s.length - 1) * .95)], maxBytes: s.at(-1) } }

app.whenReady().then(async () => {
  try {
    const { openDatabase, getDbConnection } = require(path.join(root, 'dist-electron/electron/database/index.js'))
    const { createSession, appendMessage } = require(path.join(root, 'dist-electron/electron/database/operations.js'))
    const { SqliteAgentHistory } = require(path.join(root, 'dist-electron/electron/runtime/sqliteAgentHistory.js'))
    const { rebuildClaudeMessagesFromHistory } = require(path.join(root, 'dist-electron/electron/runtime/canonicalHistory.js'))
    const { InvocationHistoryWriter } = require(path.join(root, 'dist-electron/packages/agent-sdk/src/history.js'))
    const { runInTransaction } = require(path.join(root, 'dist-electron/electron/database/transaction.js'))
    const { encodeProjectionScopeKey } = require(path.join(root, 'dist-electron/electron/sessionStorage/domain/scopeKey.js'))
    const { createProjectionScopeHistoryReducer } = require(path.join(root, 'dist-electron/electron/sessionStorage/infrastructure/sqlite/projectionScopeHistoryReducer.js'))
    const { reduceProjectionHistoryChunkInWorker } = require(path.join(root, 'dist-electron/electron/sessionStorage/infrastructure/sqlite/projectionHistoryReducerWorkerClient.js'))
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-session-bench-db-'))
    const db = openDatabase(path.join(tempDir, 'bench.db'))
    const conn = getDbConnection(db)
    const measurements = []
    const transactionBoundarySamples = []
    for (let sample = 0; sample < fixture.samples; sample += 1) {
      const started = performance.now()
      runInTransaction(conn, () => conn.prepare('SELECT 1 AS value').get())
      transactionBoundarySamples.push(performance.now() - started)
    }
    measurements.push({ kind: 'sqlite-transaction-boundary', samples: transactionBoundarySamples.length,
      work: 'SELECT 1 inside production runInTransaction', ...quantiles(transactionBoundarySamples) })

    const workerRoundTrips = []
    const workerScopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const workerReducer = createProjectionScopeHistoryReducer()
    for (const messageCount of [1, 100]) {
      const roundTrips = []; const workerDurations = []; const inputBytes = []; const resultBytes = []
      for (let sample = 0; sample < fixture.samples; sample += 1) {
        const invocationId = `worker-roundtrip-${messageCount}-${sample}`
        const messages = Array.from({ length: messageCount }, (_, index) => ({ id: `${invocationId}-message-${index}`, role: 'user', content: 'x'.repeat(1024), timestamp: index + 1 }))
        const messageFacts = messages.map((message, sequence) => ({ id: message.id, role: message.role, timestamp: message.timestamp,
          sequence, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: message.content }))
        const events = [
          { invocationId, sequence: 1, eventId: `${invocationId}-context`, idempotencyKey: `${invocationId}-context`, turnId: `${invocationId}-turn`,
            schemaVersion: 1, kind: 'invocation-context-committed', payloadJson: JSON.stringify({ messages }), sessionSequence: 1, commitOrder: 1, createdAt: 1 },
          { invocationId, sequence: 2, eventId: `${invocationId}-terminal`, idempotencyKey: `${invocationId}-terminal`, turnId: `${invocationId}-turn`,
            schemaVersion: 1, kind: 'invocation-completed', payloadJson: JSON.stringify({ status: 'completed' }), sessionSequence: 2, commitOrder: 2, createdAt: 2 }
        ]
        inputBytes.push(Buffer.byteLength(JSON.stringify({ events, messageFacts })))
        const started = performance.now()
        const result = await reduceProjectionHistoryChunkInWorker(workerReducer.createState(workerScopeKey), events, messageFacts, workerScopeKey, true)
        roundTrips.push(performance.now() - started)
        workerDurations.push(result.workerSample.durationMs)
        resultBytes.push(Buffer.byteLength(JSON.stringify({ stateJson: result.stateJson, outputOperations: result.outputOperations, finalizedOutputOperations: result.finalizedOutputOperations })))
      }
      workerRoundTrips.push({ kind: 'production-projection-worker-roundtrip', messageCount, samples: roundTrips.length,
        inputBytes: byteQuantiles(inputBytes), resultBytes: byteQuantiles(resultBytes), roundTrip: quantiles(roundTrips), workerDuration: quantiles(workerDurations) })
    }
    measurements.push(...workerRoundTrips)
    for (const scenario of fixture.scenarios) {
      const durations = []
      let historyRowsRead = 0
      let historyReadCalls = 0
      let historyBytesRead = 0
      let historyReadDurationMs = 0
      let historyAppendCalls = 0
      let historyAppendDurationMs = 0
      let historyBytesWritten = 0
      if (scenario.kind === 'cold-history') {
        const readMs = []; const parseMs = []; const hydrateMs = []; const reduceMs = []; const blockMs = []; let observedBytes = 0
        const invocationId = `cold-history-${scenario.count}mib-seed`
        const event = { invocationId, turnId: `cold-turn-seed`, sequence: 1, schemaVersion: 1,
            eventId: `${invocationId}-context`, idempotencyKey: `${invocationId}-context`, kind: 'model-response-committed',
            payload: { message: { role: 'assistant', id: `cold-message-seed`, content: 'x'.repeat(scenario.bodyBytes) } } }
        await new SqliteAgentHistory(conn, 1, Date.now).appendBatch([event], 0)
        for (let sample = 0; sample < fixture.samples; sample += 1) {
          const blockStarted = performance.now()
          const readStarted = performance.now()
          const row = conn.prepare(`SELECT invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at
            FROM agent_history_events WHERE invocation_id=? AND sequence=1`).get(invocationId)
          readMs.push(performance.now() - readStarted)
          observedBytes += Buffer.byteLength(row.payload_json)
          const parseStarted = performance.now()
          JSON.parse(row.payload_json)
          parseMs.push(performance.now() - parseStarted)
          const hydrateStarted = performance.now()
          const snapshot = await new SqliteAgentHistory(conn, 1, Date.now).read(invocationId)
          const eventForReducer = snapshot.events[0]
          hydrateMs.push(performance.now() - hydrateStarted)
          const reduceStarted = performance.now()
          const messages = rebuildClaudeMessagesFromHistory([eventForReducer])
          reduceMs.push(performance.now() - reduceStarted)
          blockMs.push(performance.now() - blockStarted)
          const restoredContent = messages[0]?.content
          const restoredBytes = typeof restoredContent === 'string' ? Buffer.byteLength(restoredContent) : Array.isArray(restoredContent)
            ? restoredContent.reduce((sum, block) => sum + (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? Buffer.byteLength(block.text) : 0), 0)
            : -1
          if (messages.length !== 1 || messages[0]?.role !== 'assistant' || restoredBytes !== scenario.bodyBytes) {
            throw new Error(`cold restore mismatch for ${scenario.count}MiB sample ${sample}: count=${messages.length}, role=${messages[0]?.role}, contentBytes=${restoredBytes}`)
          }
        }
        const summarize = (values) => ({ ...quantiles(values), totalMs: +values.reduce((sum, value) => sum + value, 0).toFixed(3) })
        measurements.push({ ...scenario, samples: fixture.samples, descriptorJsonBytes: observedBytes, sourceTruthSpillBytes: scenario.bodyBytes, sqlRowRead: summarize(readMs), jsonParse: summarize(parseMs), sourceReadAndHydrate: summarize(hydrateMs),
          historyReduction: summarize(reduceMs), maxContiguousMainThreadBlock: quantiles(blockMs) })
        continue
      }
      for (let sample = 0; sample < fixture.samples; sample += 1) {
        const invocationId = `${scenario.kind}-${scenario.count}-${sample}`
        const turnId = `synthetic-turn-${sample}`
        const sqliteHistory = new SqliteAgentHistory(conn, 1, Date.now)
        const history = {
          read: async (id) => {
            const started = performance.now()
            historyReadCalls += 1
            const snapshot = await sqliteHistory.read(id)
            historyReadDurationMs += performance.now() - started
            historyRowsRead += snapshot.events.length
            historyBytesRead += Buffer.byteLength(JSON.stringify(snapshot.events))
            return snapshot
          },
          appendBatch: async (...args) => {
            const started = performance.now()
            historyAppendCalls += 1
            historyBytesWritten += Buffer.byteLength(JSON.stringify(args[0]))
            const result = await sqliteHistory.appendBatch(...args)
            historyAppendDurationMs += performance.now() - started
            return result
          }
        }
        const writer = new InvocationHistoryWriter(history, { invocationId, turnId })
        const bytes = scenario.kind === 'large-tool-results' ? 1024 * 1024 : 4096
        const body = 'x'.repeat(bytes)
        if (scenario.kind === 'events') {
          const started = performance.now()
          for (let offset = 0; offset < scenario.count; offset += scenario.batchSize ?? 10) {
            const events = Array.from({ length: Math.min(scenario.batchSize ?? 10, scenario.count - offset) }, (_, j) => {
              const sequence = offset + j + 1
              return sequence <= (scenario.pendingCount ?? 0)
                ? { kind: 'tool-call-started', payload: { toolCallId: `${invocationId}-pending-${sequence}`, toolName: 'synthetic', probe: body } }
                : { kind: 'approval-updated', payload: { probe: body, sampleSeed: fixture.seed + sample + sequence } }
            })
            await writer.append(events)
          }
          durations.push(performance.now() - started)
        } else {
          const session = createSession(db, { name: `synthetic-${scenario.kind}-${sample}` })
          if (scenario.kind === 'turns') {
            const startedSeed = performance.now()
            runInTransaction(conn, () => { for (let i = 0; i < scenario.count; i += 1) appendMessage(db, { id: `${invocationId}-${i}`, sessionId: session.id,
              role: 'user', content: body, timestamp: i + 1, status: 'sent' }) })
            const seededMs = performance.now() - startedSeed
            const started = performance.now()
            conn.prepare('SELECT id,role,content,timestamp,status FROM messages WHERE session_id=? ORDER BY timestamp DESC LIMIT 20').all(session.id)
            durations.push(performance.now() - started)
            historyRowsRead += 0
            measurements.push({ kind: 'turns-seed', count: scenario.count, sample, durationMs: +seededMs.toFixed(3), bodyBytes: scenario.count * bytes })
          } else if (scenario.kind === 'large-tool-results') {
            const started = performance.now()
            const batchSize = scenario.batchSize ?? 10
            for (let offset = 0; offset < scenario.count; offset += batchSize) {
              const events = Array.from({ length: Math.min(batchSize, scenario.count - offset) }, (_, index) => ({
                kind: 'approval-updated', payload: { toolCallId: `tool-${offset + index}`, result: body }
              }))
              await writer.append(events)
            }
            durations.push(performance.now() - started)
          } else {
            const started = performance.now()
            for (let i = 0; i < scenario.count; i += 1) {
              await writer.append([{ kind: 'approval-updated', payload: { toolCallId: `tool-${i}`, result: body } }])
            }
            durations.push(performance.now() - started)
          }
        }
      }
      measurements.push({ ...scenario, samples: durations.length, historyReadCalls, historyRowsRead, historyBytesRead,
        historyReadDurationMs: +historyReadDurationMs.toFixed(3), historyAppendCalls, historyAppendDurationMs: +historyAppendDurationMs.toFixed(3),
        historyBytesWritten, ...quantiles(durations) })
    }
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false,
      preload: path.join(root, 'dist-electron/electron/preload.js') } })
    window.webContents.setBackgroundThrottling(false)
    const rendererErrors = []
    window.webContents.on('console-message', (_event, details) => { if (details.level >= 2) rendererErrors.push(String(details.message).slice(0, 300)) })
    window.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(`render-process-gone:${details.reason}`))
    const rendererStarted = performance.now()
    await window.loadFile(path.join(root, 'dist/renderer/index.html'))
    const rendererLoadedMs = performance.now() - rendererStarted
    const renderObservation = await window.webContents.executeJavaScript(`new Promise(resolve=>{const start=performance.now(); const check=()=>{const root=document.querySelector('#root'); if((root?.childElementCount??0)>0||performance.now()-start>10000){requestAnimationFrame(()=>resolve({rootPresent:!!root,childCount:root?.childElementCount??0,nodeCount:root?.querySelectorAll('*').length??0,waitForRootMs:performance.now()-start}));return} setTimeout(check,25)};check()})`, true)
    window.destroy()
    fs.writeFileSync(resultPath, JSON.stringify({ runtime: { electron: process.versions.electron, node: process.versions.node,
      sqlite: conn.prepare('select sqlite_version() as v').get().v, platform: process.platform, arch: process.arch, checkpoints: 'disabled' },
      measurements, builtRenderer: { entry: 'dist/renderer/index.html', loadToDidFinishLoadMs: +rendererLoadedMs.toFixed(3), consoleErrors: rendererErrors, ...renderObservation } }))
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
