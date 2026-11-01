const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const renderer = spawn('npm', ['run', 'dev:renderer'], { cwd: root, stdio: 'ignore', env: { ...process.env, FORCE_COLOR: '0' } })

async function waitForAppRenderer(app) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const page = app.windows().find((candidate) => candidate.url().startsWith('http://127.0.0.1:9240/'))
    if (page) {
      await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, { timeout: 15_000 })
      return page
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('main renderer window did not become ready')
}

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

async function main() {
  let app
  let originalMainSource
  let originalProtocolSource
  const mainPath = path.join(root, 'dist-electron/electron/main.js')
  const protocolPath = path.join(root, 'dist-electron/electron/ipc/agentProtocolIpc.js')
  const mockProvider = http.createServer((_request, response) => { setTimeout(() => { response.writeHead(500, { 'content-type': 'text/plain' }); response.end('probe provider failure') }, 100) })
  await new Promise((resolve) => mockProvider.listen(0, '127.0.0.1', resolve))
  const mockProviderUrl = `http://127.0.0.1:${mockProvider.address().port}`
  const userDataDir = fs.mkdtempSync('/tmp/spaceassistant-dom-probe-')
  try {
    await waitForRenderer()
    originalMainSource = fs.readFileSync(mainPath, 'utf8')
    const dispatchExpression = "send('chat:turn-display', { display })"
    if (!originalMainSource.includes(dispatchExpression)) throw new Error('could not locate the compiled turn-display dispatch for diagnostic instrumentation')
    fs.writeFileSync(mainPath, originalMainSource.replace(dispatchExpression, "send('chat:turn-display', { display, __probeDispatchAt: Date.now() })"), 'utf8')
    originalProtocolSource = fs.readFileSync(protocolPath, 'utf8')
    const summaryHandler = "ipcMain.handle('chat:get-context-history-summary-baseline', (_e, payload) => sessionQueries.readContextHistorySummaryBaseline(payload.sessionId));"
    const delayedSummaryHandler = "ipcMain.handle('chat:get-context-history-summary-baseline', async (_e, payload) => { const result = await sessionQueries.readContextHistorySummaryBaseline(payload.sessionId); if (Number.isSafeInteger(payload.__probeDelayMs) && payload.__probeDelayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(payload.__probeDelayMs, 1000))); return result; });"
    if (!originalProtocolSource.includes(summaryHandler)) throw new Error('could not locate the compiled summary IPC handler for diagnostic instrumentation')
    fs.writeFileSync(protocolPath, originalProtocolSource.replace(summaryHandler, delayedSummaryHandler), 'utf8')
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, mainPath],
      cwd: root,
      env: { ...process.env, SPACEASSISTANT_DEV: '1', SPACEASSISTANT_DEV_USER_DATA_DIR: userDataDir, FORCE_COLOR: '0' }
    })
    let page = await waitForAppRenderer(app)
    const sessionSwitchTraceLines = []
    page.on('console', (message) => {
      const text = message.text()
      const prefix = '[session.switch.trace.renderer] '
      if (!text.startsWith(prefix)) return
      try { sessionSwitchTraceLines.push(JSON.parse(text.slice(prefix.length))) } catch { /* Ignore unrelated malformed diagnostics. */ }
    })
    const session = await page.evaluate(() => window.api.sessionCreate({ name: 'DOM projection probe' }))
    if (!session?.id) throw new Error('session:create did not return an isolated session')
    const sessionButton = page.locator('.session-item-select').filter({ hasText: 'DOM projection probe' }).last()
    await sessionButton.waitFor({ state: 'visible', timeout: 10_000 })
    await sessionButton.click()
    const sessionId = session.id
    const diagnosticSampleCount = Number(process.env.SPACEASSISTANT_DOM_PROBE_SAMPLES)
    const sampleCount = Number.isInteger(diagnosticSampleCount) && diagnosticSampleCount > 0 ? diagnosticSampleCount : 30
    await page.evaluate(async ({ mockProviderUrl }) => {
      await window.api.configSet({
        models: [{ id: 'probe-model', name: 'probe-model', maximumContext: 100000, maxTokens: 4096, isDefault: true, isFast: false, isVision: false, enabled: true }],
        preferredLanguageModelId: 'probe-model',
        llmServices: [{ id: 'probe-service', name: 'Probe Service', baseUrl: mockProviderUrl, apiKeyPresent: true, supportedModelIds: ['probe-model'] }],
        activeLlmServiceId: 'probe-service', llmServiceKeys: { 'probe-service': 'probe-only-not-a-secret' }
      })
    }, { mockProviderUrl })
    const contextSummaryProbe = await page.evaluate(async ({ sessionId, sampleCount }) => {
      const roundTrips = []
      let entryCount = 0
      let resultBytes = 0
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const startedAt = performance.now()
        const result = await window.api.chatGetContextHistorySummaryBaseline({ sessionId })
        roundTrips.push(performance.now() - startedAt)
        entryCount = result.entries.length
        resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
      }
      const sorted = [...roundTrips].sort((a, b) => a - b)
      const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]
      return { samples: roundTrips.length, rendererIpcRoundTripMs: { p50: quantile(.5), p95: quantile(.95), max: sorted.at(-1) }, entryCount, resultBytes }
    }, { sessionId, sampleCount })
    await page.evaluate((sessionId) => {
      window.__probePendingSummarySettled = false
      window.__probePendingSummary = window.api.chatGetContextHistorySummaryBaseline({ sessionId, __probeDelayMs: 300 })
        .finally(() => { window.__probePendingSummarySettled = true })
    }, sessionId)
    await page.waitForTimeout(20)
    await page.evaluate(() => {
      window.__turnDisplayFrameSamples = []
      window.__turnDisplayPaintSamples = []
      window.__submitStartedAt = new Map()
      window.__acceptedAssistantIdsByRequestId = new Map()
      const seenTurnIds = new Set()
      window.api.chatOnTurnDisplay((envelope) => {
        const { display } = envelope
        if (display.lifecycle !== 'failed' && display.lifecycle !== 'completed') return
        if (seenTurnIds.has(display.turnId)) return
        seenTurnIds.add(display.turnId)
        const receivedAt = performance.now()
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__turnDisplayFrameSamples.push({
            turnId: display.turnId,
            lifecycle: display.lifecycle,
            displayMessageId: display.message.id,
            acceptedAssistantMessageId: window.__acceptedAssistantIdsByRequestId.get(display.requestId) ?? null,
            rendererReceiveToTwoFramesMs: performance.now() - receivedAt,
            displayMessageMatchesAccepted: window.__acceptedAssistantIdsByRequestId.get(display.requestId) === display.message.id,
            displayAssistantBubblePresent: Boolean(document.querySelector(`[data-message-id="${display.message.id}"]`)),
            acceptedAssistantBubblePresent: Boolean(window.__acceptedAssistantIdsByRequestId.get(display.requestId) &&
              document.querySelector(`[data-message-id="${window.__acceptedAssistantIdsByRequestId.get(display.requestId)}"]`))
          })
        }))
        const dispatchAt = envelope.__probeDispatchAt
        const rowSelector = `[data-message-id="${display.message.id}"]`
        const rowSignature = () => {
          const row = document.querySelector(rowSelector)
          return row ? `${row.className}\n${row.innerText}\n${row.innerHTML}` : ''
        }
        const before = rowSignature()
        let finished = false
        const observer = new MutationObserver(() => {
          const after = rowSignature()
          if (finished || !after || after === before) return
          finished = true
          observer.disconnect()
          requestAnimationFrame(() => requestAnimationFrame(() => window.__turnDisplayPaintSamples.push({
            turnId: display.turnId,
            requestId: display.requestId,
            targetMessageId: display.message.id,
            targetRowChanged: true,
            dispatchToNextPaintMs: typeof dispatchAt === 'number' ? Date.now() - dispatchAt : undefined
          })))
        })
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
        window.setTimeout(() => {
          if (finished) return
          finished = true
          observer.disconnect()
          window.__turnDisplayPaintSamples.push({ turnId: display.turnId, requestId: display.requestId, targetMessageId: display.message.id, targetRowChanged: false })
        }, 5000)
      })
    })
    const submitReplySamplesMs = []
    const acceptedToDomSamplesMs = []
    let submitWhileContextSummaryPendingMs
    let lastContent = ''
    let lastAssistantMessageId = ''
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const content = `dom-probe-${sample}-${Date.now()}`
      const requestId = `dom-request-${sample}-${Date.now()}`
      const submittedAt = Date.now()
      const accepted = await page.evaluate(async ({ sessionId, content, requestId }) => {
        const start = performance.now()
        const result = await window.api.chatSubmitOutbound({ sessionId, text: content, requestId })
        if (window.__probePendingSummary) {
          window.__submitWhileContextSummaryPendingMs = performance.now() - start
          window.__summaryWasPendingAtSubmitReply = !window.__probePendingSummarySettled
        }
        if (result?.accepted === 'turn-started' && result.assistantMessage?.id) {
          window.__acceptedAssistantIdsByRequestId.set(requestId, result.assistantMessage.id)
        }
        return result
      }, { sessionId, content, requestId })
      const acceptedAt = Date.now()
      submitReplySamplesMs.push(acceptedAt - submittedAt)
      if (sample === 0) submitWhileContextSummaryPendingMs = await page.evaluate(() => window.__submitWhileContextSummaryPendingMs)
      if (sample === 0) {
        const pendingState = await page.evaluate(async () => {
          const wasPendingAtSubmitReply = window.__summaryWasPendingAtSubmitReply
          await window.__probePendingSummary
          return { wasPendingAtSubmitReply, settledAfterward: window.__probePendingSummarySettled }
        })
        if (!pendingState.wasPendingAtSubmitReply || !pendingState.settledAfterward) {
          throw new Error('submit did not complete independently while the delayed summary IPC was pending')
        }
      }
      if (accepted?.accepted !== 'turn-started' || !accepted.assistantMessage?.id) {
        throw new Error(`production outbound acceptance failed: ${accepted?.rejected?.reason ?? accepted?.accepted}`)
      }
      await page.waitForFunction(({ content, assistantMessageId }) => document.body.innerText.includes(content) && Boolean(document.querySelector(`[data-message-id="${assistantMessageId}"]`)), {
        content, assistantMessageId: accepted.assistantMessage.id
      }, { timeout: 15_000 })
      acceptedToDomSamplesMs.push(Date.now() - acceptedAt)
      await page.waitForFunction(async ({ sessionId, turnId }) => {
        const active = await window.api.chatListActiveTurns({ sessionId })
        return !active.some((turn) => turn.turnId === turnId)
      }, { sessionId, turnId: accepted.turnId }, { timeout: 30_000 })
      lastContent = content
      lastAssistantMessageId = accepted.assistantMessage.id
    }
    await page.waitForFunction((count) => (window.__turnDisplayFrameSamples ?? []).length >= count, sampleCount, { timeout: 15_000 })
    await page.waitForFunction((count) => (window.__turnDisplayPaintSamples ?? []).length >= count, sampleCount, { timeout: 15_000 })
    const turnDisplayFrameSamples = await page.evaluate(() => window.__turnDisplayFrameSamples)
    const turnDisplayPaintSamples = await page.evaluate(() => window.__turnDisplayPaintSamples.map((sample) => {
      const acceptedAssistantMessageId = window.__acceptedAssistantIdsByRequestId.get(sample.requestId) ?? null
      return { ...sample, acceptedAssistantMessageId, displayMessageMatchesAccepted: acceptedAssistantMessageId === sample.targetMessageId }
    }))
    const successfulPaintSamples = turnDisplayPaintSamples.filter(({ targetRowChanged, dispatchToNextPaintMs }) => targetRowChanged && typeof dispatchToNextPaintMs === 'number').map(({ dispatchToNextPaintMs }) => dispatchToNextPaintMs).sort((a, b) => a - b)
    const dispatchToTargetPaintP50Ms = successfulPaintSamples.length ? successfulPaintSamples[Math.ceil(successfulPaintSamples.length * 0.5) - 1] : undefined
    const dispatchToTargetPaintP95Ms = successfulPaintSamples.length ? successfulPaintSamples[Math.ceil(successfulPaintSamples.length * 0.95) - 1] : undefined
    const sortedRendererFrame = turnDisplayFrameSamples.map(({ rendererReceiveToTwoFramesMs }) => rendererReceiveToTwoFramesMs).sort((a, b) => a - b)
    const rendererReceiveToTwoFramesP50Ms = sortedRendererFrame[Math.min(sortedRendererFrame.length - 1, Math.ceil(sortedRendererFrame.length * 0.5) - 1)]
    const rendererReceiveToTwoFramesP95Ms = sortedRendererFrame[Math.min(sortedRendererFrame.length - 1, Math.ceil(sortedRendererFrame.length * 0.95) - 1)]
    const rendererReceiveToTwoFramesMaxMs = sortedRendererFrame.at(-1)
    const sortedReply = [...submitReplySamplesMs].sort((a, b) => a - b)
    const sortedDom = [...acceptedToDomSamplesMs].sort((a, b) => a - b)
    const submitReplyP50Ms = sortedReply[Math.min(sortedReply.length - 1, Math.ceil(sortedReply.length * 0.5) - 1)]
    const submitReplyP95Ms = sortedReply[Math.min(sortedReply.length - 1, Math.ceil(sortedReply.length * 0.95) - 1)]
    const acceptedToDomP50Ms = sortedDom[Math.min(sortedDom.length - 1, Math.ceil(sortedDom.length * 0.5) - 1)]
    const acceptedToDomP95Ms = sortedDom[Math.min(sortedDom.length - 1, Math.ceil(sortedDom.length * 0.95) - 1)]
    const acceptedToDomMaxMs = sortedDom.at(-1)
    await page.reload()
    page = await waitForAppRenderer(app)
    await page.waitForFunction(({ content, assistantMessageId }) => document.body.innerText.includes(content) && Boolean(document.querySelector(`[data-message-id="${assistantMessageId}"]`)), { content: lastContent, assistantMessageId: lastAssistantMessageId }, { timeout: 15_000 })
    const persistedAfterReload = true
    const oldPage = page
    await oldPage.evaluate(() => window.close())
    await app.evaluate(async (_electron, mainPath) => {
      const createRequire = process.getBuiltinModule('module').createRequire
      const main = createRequire(mainPath)(mainPath)
      await main.createMainWindow()
    }, mainPath)
    const reconnectedPage = await waitForAppRenderer(app)
    reconnectedPage.on('console', (message) => {
      const text = message.text()
      const prefix = '[session.switch.trace.renderer] '
      if (!text.startsWith(prefix)) return
      try { sessionSwitchTraceLines.push(JSON.parse(text.slice(prefix.length))) } catch { /* Ignore unrelated malformed diagnostics. */ }
    })
    await reconnectedPage.waitForFunction(({ content, assistantMessageId }) => document.body.innerText.includes(content) && Boolean(document.querySelector(`[data-message-id="${assistantMessageId}"]`)), { content: lastContent, assistantMessageId: lastAssistantMessageId }, { timeout: 15_000 })
    const reconnectedPersistence = true
    const alternateSession = await reconnectedPage.evaluate(() => window.api.sessionCreate({ name: 'DOM projection probe alternate' }))
    const alternateSessionButton = reconnectedPage.locator('.session-item-select').filter({ hasText: 'DOM projection probe alternate' }).last()
    const populatedSessionButton = reconnectedPage.locator('.session-item-select').filter({ hasText: /^DOM projection probe$/ }).last()
    await alternateSessionButton.waitFor({ state: 'visible', timeout: 10_000 })
    for (let sample = 0; sample < 30; sample += 1) {
      await alternateSessionButton.click()
      await reconnectedPage.waitForFunction(() => Boolean(document.querySelector('.chat-empty')), null, { timeout: 10_000 })
      await reconnectedPage.waitForTimeout(20)
      await populatedSessionButton.click()
      await reconnectedPage.waitForFunction((content) => document.body.innerText.includes(content) && document.querySelectorAll('[data-message-id]').length > 0,
        lastContent, { timeout: 10_000 })
      await reconnectedPage.waitForTimeout(40)
    }
    const queuedEditSamplesMs = []
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const requestId = `dom-edit-request-${sample}-${Date.now()}`
      const queued = await reconnectedPage.evaluate(async ({ sessionId, requestId, content }) => window.api.chatEnqueueQueuedMessage({ sessionId, requestId, content }), {
        sessionId, requestId, content: `queued-before-${sample}`
      })
      if (!queued?.persisted?.message?.id) throw new Error('queued message fixture did not persist')
      const originalContent = `queued-before-${sample}`
      const editedContent = `queued-after-${sample}`
      await reconnectedPage.getByRole('button', { name: `编辑排队消息：${originalContent}` }).click()
      const editor = reconnectedPage.getByRole('textbox', { name: `编辑排队消息：${originalContent}` })
      await editor.fill(editedContent)
      const editStartedAt = Date.now()
      await reconnectedPage.locator('.queued-task-bar__save').click()
      await reconnectedPage.getByRole('button', { name: `编辑排队消息：${editedContent}` }).waitFor({ state: 'visible', timeout: 5_000 })
      queuedEditSamplesMs.push(Date.now() - editStartedAt)
      const persistedEdit = await reconnectedPage.evaluate(async ({ sessionId, messageId }) => {
        const page = await window.api.chatGetMessagePage({ sessionId, limit: 60 })
        return page.entries.find((entry) => entry.message.id === messageId)?.message.content
      }, { sessionId, messageId: queued.persisted.message.id })
      if (persistedEdit !== editedContent) throw new Error('visible generic message edit did not round-trip through the canonical message page')
    }
    const sortedEdit = [...queuedEditSamplesMs].sort((a, b) => a - b)
    const queuedEditP50Ms = sortedEdit[Math.min(sortedEdit.length - 1, Math.ceil(sortedEdit.length * 0.5) - 1)]
    const queuedEditP95Ms = sortedEdit[Math.min(sortedEdit.length - 1, Math.ceil(sortedEdit.length * 0.95) - 1)]
    const queuedEditMaxMs = sortedEdit.at(-1)
    const result = await reconnectedPage.evaluate(({ content, persistedAfterReload, reconnectedPersistence, submitReplySamplesMs, acceptedToDomSamplesMs, queuedEditSamplesMs, queuedEditP50Ms, queuedEditP95Ms, queuedEditMaxMs, turnDisplayFrameSamples, turnDisplayPaintSamples, dispatchToTargetPaintP50Ms, dispatchToTargetPaintP95Ms, rendererReceiveToTwoFramesP50Ms, rendererReceiveToTwoFramesP95Ms, rendererReceiveToTwoFramesMaxMs, submitReplyP50Ms, submitReplyP95Ms, acceptedToDomP50Ms, acceptedToDomP95Ms, acceptedToDomMaxMs, contextSummaryProbe, submitWhileContextSummaryPendingMs, sessionSwitchTraceLines }) => ({
      title: document.title,
      messageCount: document.querySelectorAll('[data-message-id], [class*="message"]').length,
      hasComposer: Boolean(document.querySelector('textarea, input[placeholder*="输入消息"]')),
      hasModelSelector: Boolean(document.querySelector('[aria-label*="模型"], [title*="模型"]')),
      bodyTextLength: document.body.innerText.length,
      persistedContentVisible: document.body.innerText.includes(content),
      reloadPersistenceVerified: persistedAfterReload,
      windowReconnectionPersistenceVerified: reconnectedPersistence,
      sampleCount: submitReplySamplesMs.length,
      submitReplyP50Ms,
      submitReplyP95Ms,
      acceptedToDomP50Ms,
      acceptedToDomP95Ms,
      acceptedToDomMaxMs,
      queuedEditSamples: queuedEditSamplesMs.length,
      queuedEditP50Ms,
      queuedEditP95Ms,
      queuedEditMaxMs,
      queuedEditSamplesMs,
      turnDisplayFrameSamples: turnDisplayFrameSamples.length,
      rendererReceiveToTwoFramesP50Ms,
      rendererReceiveToTwoFramesP95Ms,
      rendererReceiveToTwoFramesMaxMs,
      turnDisplayTargetRowChangedCount: turnDisplayPaintSamples.filter(({ targetRowChanged }) => targetRowChanged).length,
      dispatchToTargetPaintP50Ms,
      dispatchToTargetPaintP95Ms,
      contextSummary: contextSummaryProbe,
      submitWhileContextSummaryPendingMs,
      sessionSwitchTraceLines,
      turnDisplayPaintDiagnostic: turnDisplayPaintSamples,
      displayAssistantBubblePresentAtFrameCount: turnDisplayFrameSamples.filter(({ displayAssistantBubblePresent }) => displayAssistantBubblePresent).length,
      acceptedAssistantBubblePresentAtFrameCount: turnDisplayFrameSamples.filter(({ acceptedAssistantBubblePresent }) => acceptedAssistantBubblePresent).length,
      displayMessageMatchesAcceptedCount: turnDisplayFrameSamples.filter(({ displayMessageMatchesAccepted }) => displayMessageMatchesAccepted).length,
      turnDisplayFrameDiagnostic: turnDisplayFrameSamples,
      submitReplySamplesMs,
      acceptedToDomSamplesMs
    }), { content: lastContent, persistedAfterReload, reconnectedPersistence, submitReplySamplesMs, acceptedToDomSamplesMs, queuedEditSamplesMs, queuedEditP50Ms, queuedEditP95Ms, queuedEditMaxMs, turnDisplayFrameSamples, turnDisplayPaintSamples, dispatchToTargetPaintP50Ms, dispatchToTargetPaintP95Ms, rendererReceiveToTwoFramesP50Ms, rendererReceiveToTwoFramesP95Ms, rendererReceiveToTwoFramesMaxMs, submitReplyP50Ms, submitReplyP95Ms, acceptedToDomP50Ms, acceptedToDomP95Ms, acceptedToDomMaxMs, contextSummaryProbe, submitWhileContextSummaryPendingMs, sessionSwitchTraceLines })
    console.log(`[chat-renderer-dom] ${JSON.stringify(result)}`)
    const outputPath = process.env.SPACEASSISTANT_DOM_PROBE_OUTPUT?.trim()
    if (outputPath) {
      const resolvedOutputPath = path.resolve(root, outputPath)
      fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true })
      fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    }
  } finally {
    if (app) await app.close().catch(() => {})
    if (originalMainSource !== undefined) fs.writeFileSync(mainPath, originalMainSource, 'utf8')
    if (originalProtocolSource !== undefined) fs.writeFileSync(protocolPath, originalProtocolSource, 'utf8')
    renderer.kill('SIGTERM')
    mockProvider.close()
  }
}

main().catch((error) => {
  console.error('[chat-renderer-dom] failed:', error)
  process.exitCode = 1
})
