const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { app, BrowserWindow } = require('electron')

const root = path.resolve(__dirname, '../..')
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const resultPath = process.argv[3]
const quantiles = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50Ms: +s[Math.floor((s.length - 1) * .5)].toFixed(3), p95Ms: +s[Math.floor((s.length - 1) * .95)].toFixed(3), maxMs: +s.at(-1).toFixed(3) } }
const byteQuantiles = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50Bytes: s[Math.floor((s.length - 1) * .5)], p95Bytes: s[Math.floor((s.length - 1) * .95)], maxBytes: s.at(-1) } }
const measureSynchronousBlock = async (work) => {
  const started = performance.now()
  const pending = work()
  const synchronousMs = performance.now() - started
  await pending
  return synchronousMs
}
const hashTree = (entries) => {
  const hash = crypto.createHash('sha256')
  const visit = (relative) => {
    if (relative === 'dist-electron/session-storage-build-manifest.json') return
    if (/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(relative) || relative.split(path.sep).includes('__tests__')) return
    const absolute = path.join(root, relative)
    const stat = fs.statSync(absolute)
    if (stat.isDirectory()) { for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name)); return }
    hash.update(relative.replaceAll(path.sep, '/')).update('\0').update(fs.readFileSync(absolute)).update('\0')
  }
  for (const entry of entries) if (fs.existsSync(path.join(root, entry))) visit(entry)
  return hash.digest('hex')
}

app.whenReady().then(async () => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist-electron/session-storage-build-manifest.json'), 'utf8'))
    const sourceSha256 = hashTree(['electron', 'packages', 'src', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.electron.json', 'tsconfig.renderer.json', 'vite.config.ts'])
    const electronSha256 = hashTree(['dist-electron'])
    const rendererSha256 = hashTree(['dist/renderer'])
    if (manifest.sourceSha256 !== sourceSha256 || manifest.electronSha256 !== electronSha256 || manifest.rendererSha256 !== rendererSha256) {
      throw new Error('measured build fingerprint is stale; run npm run build before VPERF')
    }
    const { openDatabase, getDbConnection } = require(path.join(root, 'dist-electron/electron/database/index.js'))
    const { createSession, appendMessage } = require(path.join(root, 'dist-electron/electron/database/operations.js'))
    const { createSessionQueries } = require(path.join(root, 'dist-electron/electron/sessionStorage/queries.js'))
    const { createSqliteSessionStorage } = require(path.join(root, 'dist-electron/electron/sessionStorage/sqliteSessionStorage.js'))
    const { SqliteAgentHistory } = require(path.join(root, 'dist-electron/electron/runtime/sqliteAgentHistory.js'))
    const { rebuildClaudeMessagesFromHistory } = require(path.join(root, 'dist-electron/electron/runtime/canonicalHistory.js'))
    const { InvocationHistoryWriter } = require(path.join(root, 'dist-electron/packages/agent-sdk/src/history.js'))
    const { runInTransaction } = require(path.join(root, 'dist-electron/electron/database/transaction.js'))
    const { encodeProjectionScopeKey } = require(path.join(root, 'dist-electron/electron/sessionStorage/domain/scopeKey.js'))
    const { createProjectionScopeHistoryReducer } = require(path.join(root, 'dist-electron/electron/sessionStorage/infrastructure/sqlite/projectionScopeHistoryReducer.js'))
    const { reduceProjectionHistoryChunkInWorker } = require(path.join(root, 'dist-electron/electron/sessionStorage/infrastructure/sqlite/projectionHistoryReducerWorkerClient.js'))
    const { ensureLegacyLedgerReadiness } = require(path.join(root, 'dist-electron/electron/sessionLedgerReadiness.js'))
    const { ensureSessionLedgerReady } = require(path.join(root, 'dist-electron/electron/sessionLedgerLifecycle.js'))
    const { createProductionSessionLedgerLifecycleDependencies } = require(path.join(root, 'dist-electron/electron/runtime/sessionLedgerLifecycleProduction.js'))
    const { bootstrapEmptySessionEventLedger, getSessionEventSink, readSessionEvents, resolveSessionEventPaths } = require(path.join(root, 'dist-electron/electron/sessionEvents.js'))
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
      const eventLoopBlockSamples = []
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
          let lastHeartbeat = performance.now()
          let maxEventLoopLag = 0
          const heartbeat = setInterval(() => {
            const now = performance.now()
            maxEventLoopLag = Math.max(maxEventLoopLag, now - lastHeartbeat - 1)
            lastHeartbeat = now
          }, 1)
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
          await new Promise((resolve) => setImmediate(resolve))
          clearInterval(heartbeat)
          blockMs.push(Math.max(0, maxEventLoopLag))
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
      if (scenario.kind === 'context-summary') {
        const coldMs = []; const hotMs = []; const concurrentMs = []; const dispatchBlockMs = []; const resultBytes = []
        let totalBodyBytes = 0; let totalRows = 0; let totalSummaryEntries = 0
        for (let sample = 0; sample < fixture.samples; sample += 1) {
          const session = createSession(db, { name: `synthetic-context-summary-${scenario.count}-${sample}` })
          const content = 'x'.repeat(scenario.bodyBytes)
          runInTransaction(conn, () => {
            for (let index = 0; index < scenario.count; index += 1) {
              const hasImage = index % 10 === 0
              appendMessage(db, { id: `summary-${scenario.count}-${sample}-${index}`, sessionId: session.id,
                role: index % 2 === 0 ? 'user' : 'assistant', content, timestamp: index + 1,
                status: index % 2 === 0 ? 'sent' : 'completed',
                ...(hasImage ? { attachments: [{ id: `image-${sample}-${index}`, stagingKey: `chat-attachments/${sample}-${index}.png`,
                  fileName: 'synthetic.png', mimeType: 'image/png', byteLength: 4096, width: 512, height: 512 }] } : {}),
                ...(index % 20 === 1 ? { thinking: { content: 'synthetic thinking summary sample', isVisible: true } } : {}) })
            }
          })
          totalRows += scenario.count
          totalBodyBytes += scenario.count * scenario.bodyBytes
          const queries = createSessionQueries(db)
          let started = performance.now()
          const coldPending = queries.readContextHistorySummaryBaseline(session.id)
          dispatchBlockMs.push(performance.now() - started)
          const cold = await coldPending
          coldMs.push(performance.now() - started)
          totalSummaryEntries += cold.entries.length
          resultBytes.push(Buffer.byteLength(JSON.stringify(cold)))

          started = performance.now()
          await queries.readContextHistorySummaryBaseline(session.id)
          hotMs.push(performance.now() - started)

          const concurrentQueries = createSessionQueries(db)
          started = performance.now()
          const concurrentPending = Array.from({ length: 4 }, () => concurrentQueries.readContextHistorySummaryBaseline(session.id))
          dispatchBlockMs.push(performance.now() - started)
          await Promise.all(concurrentPending)
          concurrentMs.push(performance.now() - started)
        }
        measurements.push({ ...scenario, samples: fixture.samples, totalRows, totalBodyBytes, totalSummaryEntries,
          summaryResultBytes: byteQuantiles(resultBytes), dispatchSynchronousBlock: quantiles(dispatchBlockMs),
          coldWorkerMiss: quantiles(coldMs), hotCacheHit: quantiles(hotMs), fourConcurrentMisses: quantiles(concurrentMs),
          scope: 'production SessionQueries with file-backed SQLite and production summary worker',
          limitations: ['does not include renderer page dispatch-to-paint', 'does not include IPC queue or contextBridge result-copy time', 'does not submit a model request'] })
        continue
      }
      for (let sample = 0; sample < fixture.samples; sample += 1) {
        const invocationId = `${scenario.scenarioId ?? `${scenario.kind}-${scenario.count}`}-${sample}`
        const turnId = `synthetic-turn-${sample}`
        const sqliteHistory = new SqliteAgentHistory(conn, 1, Date.now)
        const history = {
          read: async (id) => {
            const started = performance.now()
            historyReadCalls += 1
            const snapshot = await sqliteHistory.read(id)
            historyReadDurationMs += performance.now() - started
            historyRowsRead += snapshot.events.length
            historyBytesRead += Number(conn.prepare('SELECT COALESCE(SUM(length(payload_json)),0) AS bytes FROM agent_history_events WHERE invocation_id=?').get(id).bytes)
            return snapshot
          },
          appendBatch: async (...args) => {
            const started = performance.now()
            historyAppendCalls += 1
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
            eventLoopBlockSamples.push(await measureSynchronousBlock(() => writer.append(events)))
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
            eventLoopBlockSamples.push(await measureSynchronousBlock(() => {
              conn.prepare('SELECT id,role,content,timestamp,status FROM messages WHERE session_id=? ORDER BY timestamp DESC LIMIT 20').all(session.id)
            }))
            durations.push(performance.now() - started)
            historyRowsRead += 0
            measurements.push({ kind: 'turns-seed', count: scenario.count, sample, durationMs: +seededMs.toFixed(3), bodyBytes: scenario.count * bytes })
          } else if (scenario.kind === 'large-tool-results') {
            const started = performance.now()
            const batchSize = scenario.batchSize ?? 10
            for (let offset = 0; offset < scenario.count; offset += batchSize) {
              const events = Array.from({ length: Math.min(batchSize, scenario.count - offset) }, (_, index) => {
                const toolCallId = `${invocationId}-tool-${offset + index}`
                return [
                  { kind: 'tool-call-started', payload: { toolCallId, toolName: 'synthetic-large-result' } },
                  { kind: 'tool-call-finished', payload: { toolCallId, result: { success: true, data: body } } }
                ]
              }).flat()
              eventLoopBlockSamples.push(await measureSynchronousBlock(() => writer.append(events)))
            }
            durations.push(performance.now() - started)
          } else {
            const started = performance.now()
            for (let i = 0; i < scenario.count; i += 1) {
              eventLoopBlockSamples.push(await measureSynchronousBlock(() => writer.append([{ kind: 'approval-updated', payload: { toolCallId: `tool-${i}`, result: body } }])))
            }
            durations.push(performance.now() - started)
          }
        }
        historyBytesWritten += Number(conn.prepare('SELECT COALESCE(SUM(length(payload_json)),0) AS bytes FROM agent_history_events WHERE invocation_id=?').get(invocationId).bytes)
      }
      measurements.push({ ...scenario, samples: durations.length, historyReadCalls, historyRowsRead, historyBytesRead,
        historyReadDurationMs: +historyReadDurationMs.toFixed(3), historyAppendCalls, historyAppendDurationMs: +historyAppendDurationMs.toFixed(3),
        historyBytesWritten,
        maxContiguousMainThreadBlock: quantiles(eventLoopBlockSamples),
        ...quantiles(durations) })
    }
    for (const count of [100, 1000]) {
      const startupDbPath = path.join(tempDir, `startup-${count}.db`)
      const seedDb = openDatabase(startupDbPath)
      const seedConn = getDbConnection(seedDb)
      const targetSessionIds = []
      runInTransaction(seedConn, () => {
        for (let index = 0; index < count; index += 1) {
          const session = createSession(seedDb, { name: `completed-startup-${count}-${index}` })
          if (index === 0) targetSessionIds.push(session.id)
          appendMessage(seedDb, { id: `startup-${count}-${index}-user`, sessionId: session.id, role: 'user',
            content: 'completed startup fixture', timestamp: 1, status: 'sent' })
          appendMessage(seedDb, { id: `startup-${count}-${index}-assistant`, sessionId: session.id, role: 'assistant',
            content: 'completed startup response', timestamp: 2, status: 'completed' })
        }
      })
      seedDb.close()
      const dbOpenMs = []; const storageCompositionMs = []; const firstTargetPreparationMs = []; const syncBlockMs = []
      for (let sample = 0; sample < fixture.samples; sample += 1) {
        const openStarted = performance.now()
        const startupDb = openDatabase(startupDbPath)
        dbOpenMs.push(performance.now() - openStarted)
        const compositionStarted = performance.now()
        const storage = createSqliteSessionStorage(startupDb, { getWorkDirForSession: () => '/tmp/session-storage-bench' })
        storageCompositionMs.push(performance.now() - compositionStarted)
        const preparationStarted = performance.now()
        const availability = storage.availability.inspect(targetSessionIds[0])
        firstTargetPreparationMs.push(performance.now() - preparationStarted)
        if (availability.content.state !== 'readable') throw new Error(`startup target preparation failed for ${count} sessions`)
        syncBlockMs.push(storageCompositionMs.at(-1) + firstTargetPreparationMs.at(-1))
        startupDb.close()
      }
      measurements.push({ kind: 'startup-session-scale', completedSessionCount: count, samples: fixture.samples,
        completedMessages: count * 2, dbOpen: quantiles(dbOpenMs), minimumStorageBarrier: quantiles(storageCompositionMs),
        firstTargetPreparation: quantiles(firstTargetPreparationMs), maxContiguousMainThreadBlock: quantiles(syncBlockMs),
        scope: 'file-backed SQLite reopen, SessionStorage composition, and one selected target availability check',
        limitations: ['startup does not inspect unselected session messages or globally recover History',
          'availability preparation reads at most the selected session API baseline', 'Electron window load is reported separately'] })
    }
    const legacyLedgerDirectory = path.join(tempDir, 'legacy-ledger-workdir')
    fs.mkdirSync(legacyLedgerDirectory, { recursive: true })
    const legacyLedgerSamples = []; const legacyLedgerBlocks = []; const legacyLedgerBaselineScans = []; let legacyLedgerBytes = 0
    for (let sample = 0; sample < fixture.samples; sample += 1) {
      const legacySessionDb = openDatabase(':memory:')
      const legacySessionConn = getDbConnection(legacySessionDb)
      const session = createSession(legacySessionDb, { name: `legacy-baseline-${sample}` })
      const location = { workDir: path.join(legacyLedgerDirectory, `sample-${sample}`), sessionId: session.id, createdAt: session.createdAt }
      const invocationId = `legacy-baseline-invocation-${sample}`
      const messages = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', id: `legacy-${sample}-${index}`,
        content: `synthetic legacy history ${index} ${'x'.repeat(1024)}`, timestamp: index + 1 }))
      const legacyHistory = new SqliteAgentHistory(legacySessionConn, 1, Date.now, session.id)
      await legacyHistory.appendBatch([{ invocationId, turnId: `legacy-turn-${sample}`, sequence: 1, schemaVersion: 1,
        eventId: `legacy-context-${sample}`, idempotencyKey: `legacy-context-${sample}`, kind: 'invocation-context-committed',
        payload: { messages } }, { invocationId, turnId: `legacy-turn-${sample}`, sequence: 2, schemaVersion: 1,
        eventId: `legacy-proposal-${sample}`, idempotencyKey: `legacy-proposal-${sample}`, kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: `legacy-tool-${sample}`, name: 'read_file', input: { path: 'legacy.txt' } }] },
          sessionLedger: { location, stepId: `legacy-step-${sample}`, toolCalls: [{ toolUseId: `legacy-tool-${sample}`, name: 'read_file', args: { path: 'legacy.txt' } }] } } }], 0)
      const lifecycleConn = legacySessionConn
      await bootstrapEmptySessionEventLedger(location.workDir, location.sessionId, location.createdAt, `legacy-bootstrap-${sample}`)
      await getSessionEventSink(location.workDir, location.sessionId, location.createdAt).close()
      const dependencies = createProductionSessionLedgerLifecycleDependencies(lifecycleConn)
      ensureLegacyLedgerReadiness(lifecycleConn, location, session.generation)
      legacyLedgerBytes += Buffer.byteLength(JSON.stringify(messages))
      const started = performance.now()
      let firstResult
      const blockMs = await measureSynchronousBlock(() => firstResult = ensureSessionLedgerReady({ conn: lifecycleConn, location,
        sessionGeneration: session.generation, processGeneration: 1, dependencies,
        onTrace: (trace) => legacyLedgerBaselineScans.push(trace.baselineScanCount) }))
      legacyLedgerBlocks.push(blockMs)
      const elapsedMs = performance.now() - started
      const ready = await firstResult
      if (ready.status !== 'ready') throw new Error('legacy ledger baseline did not reach ready')
      const eventPath = resolveSessionEventPaths(location.workDir, location.sessionId, location.createdAt).eventsPath
      const events = await readSessionEvents(eventPath)
      if (!events.some((event) => event.type === 'tool_call' && event.payload.toolUseId === `legacy-tool-${sample}`)) {
        throw new Error('legacy ledger baseline did not project canonical tool proposal')
      }
      legacyLedgerSamples.push(elapsedMs)
      legacySessionDb.close()
    }
    measurements.push({ kind: 'legacy-ledger-first-baseline', samples: legacyLedgerSamples.length,
      canonicalMessagesPerSample: 100, canonicalPayloadBytes: legacyLedgerBytes,
      firstBaselineAndProjection: quantiles(legacyLedgerSamples), maxContiguousMainThreadBlock: quantiles(legacyLedgerBlocks),
      baselineScanCount: legacyLedgerBaselineScans, checkpoints: 'disabled',
      scope: 'production ensureSessionLedgerReady, legacy JSONL baseline scan/index rebuild and canonical tool projection',
      limitations: ['synthetic SQLite and JSONL fixtures', 'does not include model/provider execution'] })
    const rendererRoot = path.join(root, 'dist/renderer')
    const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.js': 'text/javascript',
      '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2' }
    const rendererServer = http.createServer((request, response) => {
      let requestedPath
      try { requestedPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1) }
      catch { response.writeHead(400).end(); return }
      const candidatePath = path.resolve(rendererRoot, requestedPath || 'index.html')
      if (candidatePath !== rendererRoot && !candidatePath.startsWith(`${rendererRoot}${path.sep}`)) { response.writeHead(403).end(); return }
      const filePath = fs.existsSync(candidatePath) ? candidatePath : path.join(rendererRoot, 'index.html')
      response.setHeader('content-type', contentTypes[path.extname(filePath)] ?? 'application/octet-stream')
      fs.createReadStream(filePath).on('error', () => response.writeHead(404).end()).pipe(response)
    })
    await new Promise((resolve, reject) => { rendererServer.once('error', reject); rendererServer.listen(0, '127.0.0.1', resolve) })
    const rendererPort = rendererServer.address().port
    const coldStartupSamples = []
    try {
      for (let sample = 0; sample < fixture.samples; sample += 1) {
        const started = performance.now()
        const sampleUserData = path.join(tempDir, `cold-start-userdata-${sample}`)
        const result = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(root, 'scripts/fixtures/session-storage-cold-start-bootstrap.cjs')], {
            cwd: root, env: { ...process.env, SPACEASSISTANT_DEV: '1', SPACEASSISTANT_DEV_USER_DATA_DIR: sampleUserData,
              ELECTRON_START_URL: `http://127.0.0.1:${rendererPort}/` }, stdio: ['ignore', 'pipe', 'pipe']
          })
          let stdout = ''; let stderr = ''; let parsed
          const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
          child.stdout.on('data', (chunk) => {
            stdout = (stdout + chunk.toString()).slice(-128_000)
            const marker = '@@COLD_START_RESULT@@'
            const markerIndex = stdout.lastIndexOf(marker)
            if (markerIndex >= 0 && !parsed) {
              const jsonLine = stdout.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0]
              try { parsed = JSON.parse(jsonLine); parsed.processSpawnToFirstPaintMs = +(performance.now() - started).toFixed(3) }
              catch (error) { clearTimeout(timeout); child.kill('SIGKILL'); reject(error) }
            }
          })
          child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-128_000) })
          child.once('error', (error) => { clearTimeout(timeout); reject(error) })
          child.once('close', (code) => {
            clearTimeout(timeout)
            if (parsed && code === 0) resolve(parsed)
            else reject(new Error(`isolated app startup ${sample} exited ${code}:\n${stderr}\n${stdout}`))
          })
        })
        if (result.rendererOutcome !== 'ok' || result.sqliteVersion !== conn.prepare('select sqlite_version() as v').get().v) {
          throw new Error(`isolated app startup did not reach a healthy first paint: ${JSON.stringify(result)}`)
        }
        coldStartupSamples.push(result)
      }
    } finally {
      await new Promise((resolve) => rendererServer.close(resolve))
    }
    measurements.push({ kind: 'cold-app-first-screen', samples: coldStartupSamples.length,
      processSpawnToFirstPaint: quantiles(coldStartupSamples.map((sample) => sample.processSpawnToFirstPaintMs)),
      bootstrapToFirstPaint: quantiles(coldStartupSamples.map((sample) => sample.bootstrapToFirstPaintMs)),
      bootstrapToWindowReady: quantiles(coldStartupSamples.map((sample) => sample.bootstrapToWindowReadyMs)),
      rendererStartToFirstPaint: quantiles(coldStartupSamples.map((sample) => sample.rendererStartToFirstPaintMs)),
      mainModuleLoad: quantiles(coldStartupSamples.map((sample) => sample.mainModuleLoadMs ?? 0)),
      rendererOutcome: coldStartupSamples.every((sample) => sample.rendererOutcome === 'ok') ? 'ok' : 'degraded',
      appVersion: coldStartupSamples[0]?.appVersion, electronVersion: coldStartupSamples[0]?.electronVersion,
      sqliteVersion: coldStartupSamples[0]?.sqliteVersion,
      topModuleLoadSelfMs: [...coldStartupSamples.reduce((totals, sample) => {
        for (const entry of sample.topModuleLoadSelfMs ?? []) totals.set(entry.filename, (totals.get(entry.filename) ?? 0) + entry.durationMs)
        return totals
      }, new Map())].map(([filename, totalMs]) => ({ filename, meanMs: +(totalMs / coldStartupSamples.length).toFixed(3) }))
        .sort((a, b) => b.meanMs - a.meanMs).slice(0, 100),
      startupPhaseSamples: coldStartupSamples.map((sample) => sample.startupPhases ?? []),
      scope: 'production main process, isolated empty userData per sample, production IPC handlers, built renderer over loopback HTTP; window show suppressed by probe bootstrap',
      limitations: ['OS page cache is not cleared', 'no real model request is made', 'window pixels are not captured'] })
    fs.writeFileSync(resultPath, JSON.stringify({ runtime: { electron: process.versions.electron, node: process.versions.node,
      sqlite: conn.prepare('select sqlite_version() as v').get().v, platform: process.platform, arch: process.arch, checkpoints: 'disabled' },
      measurements, buildFingerprint: manifest, builtRenderer: { entry: 'dist/renderer/index.html', samples: fixture.samples,
        coldAppFirstScreen: measurements.find((measurement) => measurement.kind === 'cold-app-first-screen') } }))
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
    app.quit()
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
