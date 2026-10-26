import { attachSessionSwitchTraceMetadata, type SessionSwitchTraceMetadata } from '../../shared/sessionSwitchTraceMetadata'

export type RendererSessionSwitchStage = Readonly<{ name: string; durationMs: number; outcome: 'ok' | 'error' }>

const ALLOWED_RENDERER_STAGES = new Set([
  'renderer-page-request', 'failure-reason-hydration', 'store-commit', 'render-commit', 'next-paint'
])

let rendererPageRequestOrdinal = 0

/** Attach correlation in the renderer world, after contextBridge has copied the IPC result. */
export async function requestChatMessagePageWithTraceMetadata<T extends object>(request: () => Promise<T>): Promise<T> {
  rendererPageRequestOrdinal += 1
  const metadata: SessionSwitchTraceMetadata = { requestOrdinal: rendererPageRequestOrdinal }
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
    outcome: input.outcome, pageSize: Math.min(200, Math.max(0, Math.trunc(input.pageSize))), stages })
  try { (input.emit ?? ((value) => console.info(`[session.switch.trace.renderer] ${value}`)))(line) } catch { /* Diagnostics never affect message rendering. */ }
}
