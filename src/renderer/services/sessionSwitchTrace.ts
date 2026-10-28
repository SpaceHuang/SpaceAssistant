import { attachSessionSwitchTraceMetadata, type SessionSwitchTraceMetadata } from '../../shared/sessionSwitchTraceMetadata'

export type RendererSessionSwitchStage = Readonly<{ name: string; durationMs: number; outcome: 'ok' | 'error' }>

const ALLOWED_RENDERER_STAGES = new Set([
  'selection-to-page-request', 'renderer-page-request', 'failure-reason-hydration', 'store-commit', 'render-commit', 'next-paint'
])

let rendererPageRequestOrdinal = 0
let pendingSessionSelection: Readonly<{ sessionId: string; startedAt: number }> | undefined

/** Keep the selection start in renderer memory only; session IDs are never emitted. */
export function recordRendererSessionSelection(sessionId: string | null, previousSessionId: string | null, now = performance.now()): void {
  if (!sessionId || sessionId === previousSessionId || !Number.isFinite(now)) return
  pendingSessionSelection = { sessionId, startedAt: now }
}

/** Consume one selection marker when ChatView begins the corresponding page request. */
export function takeRendererSessionSelectionDuration(sessionId: string, now = performance.now()): number | undefined {
  const pending = pendingSessionSelection
  if (!pending || pending.sessionId !== sessionId) return undefined
  pendingSessionSelection = undefined
  const durationMs = now - pending.startedAt
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 600_000) return undefined
  return Math.round(durationMs * 100) / 100
}

/** Attach correlation in the renderer world, after contextBridge has copied the IPC result. */
export async function requestChatMessagePageWithTraceMetadata<T extends object>(request: () => Promise<T>, nowEpochMs: () => number = Date.now): Promise<T> {
  rendererPageRequestOrdinal += 1
  const initiatedAt = nowEpochMs()
  const metadata: SessionSwitchTraceMetadata = { requestOrdinal: rendererPageRequestOrdinal,
    ...(Number.isSafeInteger(initiatedAt) && initiatedAt >= 1_000_000_000_000 && initiatedAt <= 10_000_000_000_000
      ? { requestInitiatedAtEpochMs: initiatedAt } : {}) }
  try {
    return attachSessionSwitchTraceMetadata(await request(), metadata)
  } catch (error) {
    if (error && typeof error === 'object') attachSessionSwitchTraceMetadata(error, metadata)
    throw error
  }
}

export function emitRendererSessionSwitchTrace(input: Readonly<{
  metadata: SessionSwitchTraceMetadata
  outcome: 'ok' | 'error'
  pageSize: number
  stages: readonly RendererSessionSwitchStage[]
  emit?: (line: string) => void
}>): void {
  const stages = input.stages.filter((stage) => ALLOWED_RENDERER_STAGES.has(stage.name) &&
    Number.isFinite(stage.durationMs) && stage.durationMs >= 0 && stage.durationMs <= 600_000)
    .slice(0, 20).map((stage) => ({ name: stage.name, durationMs: Math.round(stage.durationMs * 100) / 100, outcome: stage.outcome }))
  const line = JSON.stringify({ event: 'session.switch.trace', instance: 'renderer',
    ...(input.metadata.processId === undefined ? {} : { rendererProcessId: input.metadata.processId }), requestOrdinal: input.metadata.requestOrdinal,
    ...(input.metadata.requestInitiatedAtEpochMs === undefined ? {} : { requestInitiatedAtEpochMs: input.metadata.requestInitiatedAtEpochMs }),
    outcome: input.outcome, pageSize: Math.min(200, Math.max(0, Math.trunc(input.pageSize))), stages })
  try { (input.emit ?? ((value) => console.info(`[session.switch.trace.renderer] ${value}`)))(line) } catch { /* Diagnostics never affect message rendering. */ }
}
