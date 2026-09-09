const { contextBridge, ipcRenderer } = require('electron')
const projections = []
const projectionDispatchMs = []
const projectionDomCommitMs = []
ipcRenderer.on('chat:turn-projection', (_event, payload) => {
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
    const samples = []
    for (let i = 0; i < sampleCount; i += 1) {
      const start = performance.now()
      const result = await ipcRenderer.invoke('chat:list-active-turns', { sessionId })
      if (!Array.isArray(result) || result.length !== 1 || result[0].sessionId !== sessionId) throw new Error('chat:list-active-turns returned an unexpected active snapshot')
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]
    const beforeTerminalProjectionCount = projections.length
    await ipcRenderer.invoke('probe:complete-turn')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const terminal = await ipcRenderer.invoke('chat:list-active-turns', { sessionId })
    return { sampleCount: samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), minMs: samples[0], maxMs: samples[samples.length - 1], projectionCount: projections.length, projectionVersion: projections[0]?.turn?.version ?? null, terminalProjectionCount: projections.length - beforeTerminalProjectionCount, projectionDispatchMs: projectionDispatchMs.slice(), projectionDomCommitMs: projectionDomCommitMs.slice(), activeAfterTerminal: terminal.length }
  }
})
