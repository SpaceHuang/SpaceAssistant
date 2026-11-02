const { contextBridge, ipcRenderer } = require('electron')
const projections = []
const projectionDispatchMs = []
const projectionDomCommitMs = []
const projectionWaitTimeoutMs = 3000
const failureMode = process.env.SPACEASSISTANT_IPC_PROBE_FAILURE_MODE || ''
ipcRenderer.on('chat:turn-projection', (_event, payload) => {
  const eventType = payload?.event?.type
  if (failureMode === 'drop-projection' && ['source-completed', 'source-failed'].includes(eventType)) return
  const receivedAt = performance.now()
  projections.push(payload)
  if (typeof payload?.probeSentAtMs === 'number') projectionDispatchMs.push(Math.max(0, Date.now() - payload.probeSentAtMs))
  const marker = document.createElement('div')
  marker.dataset.probeProjectionVersion = String(payload?.turn?.version ?? '')
  marker.textContent = payload?.turn?.assistantMessage?.content ?? ''
  document.body.appendChild(marker)
  requestAnimationFrame(() => projectionDomCommitMs.push(Math.max(0, performance.now() - receivedAt)))
})

contextBridge.exposeInMainWorld('ipcBusinessProbe', {
  async run(sampleCount, sessionId) {
    const waitForProjection = async (predicate, label) => {
      const deadline = Date.now() + projectionWaitTimeoutMs
      while (Date.now() < deadline) {
        const match = projections.find(predicate)
        if (match) return match
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`CHAT_IPC_PROJECTION_TIMEOUT:${label}`)
    }
    const initialProjection = await waitForProjection((payload) => payload?.event?.type === 'content-delta', 'initial')
    const samples = []
    for (let i = 0; i < sampleCount; i += 1) {
      const start = performance.now()
      const result = await ipcRenderer.invoke('chat:list-active-turns', { sessionId })
      if (!Array.isArray(result) || result.length !== 1 || result[0].sessionId !== sessionId) throw new Error('chat:list-active-turns returned an unexpected active snapshot')
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]
    await ipcRenderer.invoke('probe:complete-turn')
    const terminalProjection = await waitForProjection((payload) => payload?.turn?.turnId === initialProjection.turn.turnId &&
      ['source-completed', 'source-failed'].includes(payload?.event?.type), 'terminal')
    const terminal = await ipcRenderer.invoke('chat:list-active-turns', { sessionId })
    return { sampleCount: samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), minMs: samples[0], maxMs: samples[samples.length - 1],
      projectionCount: projections.length, initialProjectionVersion: initialProjection.turn.version, terminalProjectionVersion: terminalProjection.turn.version,
      terminalProjectionEvent: terminalProjection.event.type, terminalAssistantStatus: terminalProjection.turn.assistantMessage?.status ?? null,
      projectionDispatchMs: projectionDispatchMs.slice(), projectionDomCommitMs: projectionDomCommitMs.slice(), activeAfterTerminal: terminal.length }
  }
})
