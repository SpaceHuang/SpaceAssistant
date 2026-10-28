export type RendererLongTaskKind = 'longtask' | 'long-animation-frame'

export type RendererLongTaskRecord = Readonly<{
  kind: RendererLongTaskKind
  startTimeMs: number
  durationMs: number
  blockingDurationMs?: number
  scriptAttributionStatus?: 'unavailable' | 'filtered' | 'present'
  scriptCandidateCount?: number
  scriptAttributions?: readonly RendererScriptAttribution[]
}>

export type RendererScriptAttribution = Readonly<{
  file: string
  functionName?: string
  durationMs: number
}>

type ScriptEntry = Readonly<{ sourceURL?: unknown; sourceFunctionName?: unknown; duration?: unknown }>
type TimingEntry = Readonly<{ startTime?: unknown; duration?: unknown; blockingDuration?: unknown; scripts?: unknown }>
type ObserverEntryList = Readonly<{ getEntries: () => readonly unknown[] }>
type ObserverInstance = Readonly<{
  observe: (options: { type: RendererLongTaskKind; buffered: boolean }) => void
  disconnect: () => void
}>
type ObserverConstructor = (new (callback: (list: ObserverEntryList) => void) => ObserverInstance) & Readonly<{
  supportedEntryTypes?: readonly string[]
}>

const OBSERVED_KINDS: readonly RendererLongTaskKind[] = ['longtask', 'long-animation-frame']
const MIN_REPORTED_DURATION_MS = 50
const MAX_REPORTED_DURATION_MS = 600_000
const MAX_REPORTED_EVENTS = 200

export function projectRendererLongTask(entry: unknown, kind: RendererLongTaskKind): RendererLongTaskRecord | undefined {
  if (!entry || typeof entry !== 'object' || !OBSERVED_KINDS.includes(kind)) return undefined
  const timing = entry as TimingEntry
  if (typeof timing.startTime !== 'number' || !Number.isFinite(timing.startTime) || timing.startTime < 0 || timing.startTime > 1_000_000_000 ||
    typeof timing.duration !== 'number' || !Number.isFinite(timing.duration) || timing.duration < MIN_REPORTED_DURATION_MS || timing.duration > MAX_REPORTED_DURATION_MS) {
    return undefined
  }

  const record: {
    kind: RendererLongTaskKind
    startTimeMs: number
    durationMs: number
    blockingDurationMs?: number
    scriptAttributionStatus?: 'unavailable' | 'filtered' | 'present'
    scriptCandidateCount?: number
    scriptAttributions?: readonly RendererScriptAttribution[]
  } = {
    kind,
    startTimeMs: round(timing.startTime),
    durationMs: round(timing.duration)
  }
  if (kind === 'long-animation-frame' && typeof timing.blockingDuration === 'number' && Number.isFinite(timing.blockingDuration) &&
    timing.blockingDuration >= 0 && timing.blockingDuration <= timing.duration) {
    record.blockingDurationMs = round(timing.blockingDuration)
  }
  if (kind === 'long-animation-frame') {
    const projection = projectScriptAttributions(timing.scripts, timing.duration)
    record.scriptAttributionStatus = projection.status
    record.scriptCandidateCount = projection.candidateCount
    if (projection.attributions.length > 0) record.scriptAttributions = projection.attributions
  }
  return record
}

export function startRendererLongTaskObserver(options: Readonly<{
  Observer?: ObserverConstructor
  emit?: (record: RendererLongTaskRecord) => void
}> = {}): () => void {
  const Observer = options.Observer ?? getNativeObserver()
  if (!Observer) return () => undefined

  const supported = Observer.supportedEntryTypes
  let reportedCount = 0
  const observers: ObserverInstance[] = []
  const emit = options.emit ?? ((record: RendererLongTaskRecord) => {
    console.info(`[renderer.performance.long-task] ${JSON.stringify(record)}`)
  })

  for (const kind of OBSERVED_KINDS) {
    if (supported && !supported.includes(kind)) continue
    let observer: ObserverInstance | undefined
    try {
      observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          if (reportedCount >= MAX_REPORTED_EVENTS) return
          const record = projectRendererLongTask(entry, kind)
          if (!record) continue
          reportedCount += 1
          try { emit(record) } catch { /* Observation must not affect rendering. */ }
        }
      })
      observer.observe({ type: kind, buffered: false })
      observers.push(observer)
    } catch {
      try { observer?.disconnect() } catch { /* A partial observer setup is best-effort. */ }
    }
  }

  return () => {
    for (const observer of observers) {
      try { observer.disconnect() } catch { /* Observer teardown is best-effort. */ }
    }
  }
}

function getNativeObserver(): ObserverConstructor | undefined {
  if (typeof PerformanceObserver === 'undefined') return undefined
  return PerformanceObserver as unknown as ObserverConstructor
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function projectScriptAttributions(value: unknown, taskDurationMs: number): Readonly<{
  status: 'unavailable' | 'filtered' | 'present'
  candidateCount: number
  attributions: readonly RendererScriptAttribution[]
}> {
  if (!Array.isArray(value) || value.length === 0) return { status: 'unavailable', candidateCount: 0, attributions: [] }
  const projected = value.slice(0, 20).flatMap((entry): RendererScriptAttribution[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const script = entry as ScriptEntry
    if (typeof script.sourceURL !== 'string' || typeof script.duration !== 'number' || !Number.isFinite(script.duration) ||
      script.duration <= 0 || script.duration > taskDurationMs) return []
    let url: URL
    try { url = new URL(script.sourceURL) } catch { return [] }
    const assetPrefix = '/app.asar/dist/renderer/assets/'
    if (url.protocol !== 'file:' || !url.pathname.includes(assetPrefix)) return []
    const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.m?js$/.test(file)) return []
    const attribution: { file: string; functionName?: string; durationMs: number } = {
      file,
      durationMs: round(script.duration)
    }
    if (typeof script.sourceFunctionName === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(script.sourceFunctionName)) {
      attribution.functionName = script.sourceFunctionName
    }
    return [attribution]
  })
  const attributions = projected.sort((a, b) => b.durationMs - a.durationMs).slice(0, 3)
  return {
    status: attributions.length > 0 ? 'present' : 'filtered',
    candidateCount: Math.min(100, value.length),
    attributions
  }
}
