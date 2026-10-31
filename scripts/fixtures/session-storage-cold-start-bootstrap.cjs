const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { app, BrowserWindow } = require('electron')
const Module = require('node:module')

const started = performance.now()
const phases = {}
let mainModuleLoadMs
const moduleLoadStack = []
const moduleLoadSelfMs = new Map()
const originalModuleLoad = Module._load
Module._load = function (request, parent, isMain) {
  const startedAt = performance.now()
  let filename = request
  try { filename = Module._resolveFilename(request, parent, isMain) } catch { /* preserve the original request if resolution itself fails */ }
  const frame = { filename, childMs: 0 }
  const parentFrame = moduleLoadStack.at(-1)
  moduleLoadStack.push(frame)
  try {
    return originalModuleLoad.call(this, request, parent, isMain)
  } finally {
    moduleLoadStack.pop()
    const elapsedMs = performance.now() - startedAt
    if (parentFrame) parentFrame.childMs += elapsedMs
    const selfMs = Math.max(0, elapsedMs - frame.childMs)
    moduleLoadSelfMs.set(frame.filename, (moduleLoadSelfMs.get(frame.filename) ?? 0) + selfMs)
  }
}
const originalInfo = console.info.bind(console)

// Keep the real app startup hidden while measuring the exact ready-to-show and
// renderer first-contentful-paint signals used by production code.
BrowserWindow.prototype.show = function () { return this }
console.info = (...args) => {
  originalInfo(...args)
  const payload = args[0] === '[startup]' && typeof args[1] === 'string'
    ? args[1]
    : typeof args[0] === 'string' && args[0].startsWith('[startup]') ? args[0].slice('[startup]'.length).trim() : undefined
  if (!payload) return
  try {
    const phase = JSON.parse(payload)
    phases[phase.phase] = phase
  } catch { return }
  const ready = phases['app.start-to-window-ready-to-show']
  const firstPaint = phases['renderer.start-to-first-paint']
  const loaded = phases['app.start-to-renderer-loaded']
  if (!ready || !firstPaint || !loaded || process.stdout.writableEnded) return
  process.stdout.write(`\n@@COLD_START_RESULT@@${JSON.stringify({
    bootstrapToFirstPaintMs: +(performance.now() - started).toFixed(3),
    bootstrapToWindowReadyMs: ready.durationMs,
    rendererStartToFirstPaintMs: firstPaint.durationMs,
    rendererOutcome: loaded.outcome,
    appVersion: loaded.appVersion,
    electronVersion: loaded.electronVersion,
    sqliteVersion: loaded.sqliteVersion,
    mainModuleLoadMs,
    totalModuleLoadSelfMs: +[...moduleLoadSelfMs.values()].reduce((sum, durationMs) => sum + durationMs, 0).toFixed(3),
    topModuleLoadSelfMs: [...moduleLoadSelfMs].map(([filename, durationMs]) => ({ filename, durationMs: +durationMs.toFixed(3) }))
      .sort((a, b) => b.durationMs - a.durationMs).slice(0, 100),
    startupPhases: Object.values(phases)
  })}\n`)
  setTimeout(() => app.quit(), 50)
}

const timeout = setTimeout(() => {
  process.stderr.write('cold-start probe timed out before first paint\n')
  app.exit(2)
}, 90_000)
app.once('will-quit', () => clearTimeout(timeout))
const mainModuleStartedAt = performance.now()
require(path.resolve(__dirname, '../../dist-electron/electron/main.js'))
mainModuleLoadMs = +(performance.now() - mainModuleStartedAt).toFixed(3)
