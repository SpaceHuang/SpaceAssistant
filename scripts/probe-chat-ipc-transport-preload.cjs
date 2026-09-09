const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ipcTransportProbe', {
  async run(sampleCount) {
    const samples = []
    for (let i = 0; i < sampleCount; i += 1) {
      const start = performance.now()
      await ipcRenderer.invoke('probe:ipc-roundtrip', i)
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]
    return {
      sampleCount: samples.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      minMs: samples[0],
      maxMs: samples[samples.length - 1]
    }
  }
})
