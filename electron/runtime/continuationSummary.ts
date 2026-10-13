import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'

/** Only structured canonical History events can produce claims about completed side effects. */
export function summarizeFailedInvocation(snapshot: HistorySnapshot, invocationId: string, turnId: string) {
  const events = snapshot.events
  const committed = events.filter((event) => event.kind === 'tool-call-finished')
  const proposals = new Map<string, { toolName?: string }>()
  for (const event of events.filter((candidate) => candidate.kind === 'model-response-committed')) {
    const payload = event.payload as { message?: { toolCalls?: Array<{ id?: string; name?: string; toolName?: string; input?: Record<string, unknown> }> }; toolCalls?: Array<{ id?: string; name?: string; toolName?: string; input?: Record<string, unknown> }> }
    for (const call of payload.message?.toolCalls ?? payload.toolCalls ?? []) {
      const id = call.id
      if (id) proposals.set(id, { toolName: call.toolName ?? call.name })
    }
  }
  const started = new Map(events.filter((event) => event.kind === 'tool-call-started').map((event) => {
    const payload = event.payload as { toolCallId?: unknown; toolName?: string }
    const id = String(payload.toolCallId ?? '')
    return [id, { toolName: payload.toolName, ...proposals.get(id) }] as const
  }))
  const settled = new Set(committed.map((event) => String((event.payload as { toolCallId?: unknown }).toolCallId ?? '')))
  const successful: string[] = []
  const failed: string[] = []
  const unknown: string[] = []
  for (const event of committed) {
    const payload = event.payload as { toolCallId?: string; result?: unknown; toolName?: string; name?: string; input?: Record<string, unknown>; success?: boolean; isError?: boolean; executionOutcome?: string; executorEntry?: string; errorCode?: string }
    const result = payload.result && typeof payload.result === 'object' ? payload.result as Record<string, unknown> : {}
    const proposal = started.get(String(payload.toolCallId ?? ''))
    const toolName = String(payload.toolName ?? payload.name ?? proposal?.toolName ?? 'tool')
    const ok = payload.success === true && payload.isError !== true
    if (payload.executionOutcome === 'unknown-after-dispatch') {
      unknown.push(`history#${event.sequence} ${toolName}: outcome unknown after dispatch (executor entry ${payload.executorEntry ?? 'unknown'}${payload.errorCode ? `, error ${payload.errorCode}` : ''}). The SDK did not retry this call.`)
      continue
    }
    const line = `history#${event.sequence} ${toolName}: ${JSON.stringify(result).slice(0, 350)}`
    ;(ok ? successful : failed).push(line)
  }
  const unsettled = [...started].filter(([id]) => id && !settled.has(id))
  const notDispatched = events.filter((event) => event.kind === 'tool-call-not-dispatched').map((event) => {
    const payload = event.payload as { toolCallId?: unknown; toolName?: unknown; reason?: unknown }
    const name = typeof payload.toolName === 'string' ? payload.toolName : String(started.get(String(payload.toolCallId ?? ''))?.toolName ?? 'tool')
    return `history#${event.sequence} ${name}: not dispatched (${String(payload.reason ?? 'unknown reason')}).`
  })
  const unknownStarted = unsettled.length > 0 || unknown.length > 0
  const terminal = events.at(-1)
  const terminalPayload = terminal?.payload && typeof terminal.payload === 'object' ? terminal.payload as Record<string, unknown> : {}
  const lines = [
    `Source invocation ${invocationId}, turn ${turnId}; canonical History through sequence ${events.at(-1)?.sequence ?? 0}.`,
    `Original task: ${String((events[0]?.payload as { requiredUserMessage?: { message?: { content?: unknown } } } | undefined)?.requiredUserMessage?.message?.content ?? '(task text not available)')}`,
    `Committed successful tool results: ${successful.length ? successful.join('\n') : 'none proven.'}`,
    `Failed tool results: ${failed.length ? failed.join('\n') : 'none recorded.'}`,
    `Unknown tool outcomes: ${unknown.length ? unknown.join('\n') : 'none recorded.'}`,
    `Not-dispatched tool calls: ${notDispatched.length ? notDispatched.join('\n') : 'none recorded.'}`,
    `Final failure: ${String(terminalPayload.message ?? terminalPayload.error ?? terminalPayload.reason ?? 'Invocation failed.')}`,
    unknownStarted ? `Side-effect state unknown for ${unsettled.length + unknown.length} tool call(s); ${unsettled.length} started-only call(s) have unknown executor entry. Do not treat them as confirmed failures or repeat them mechanically.` : 'No dispatched-but-unsettled tool call found.',
    'These are historical facts, not instructions to replay tools. Read current targets and compare with the recorded successful changes before editing; report differences instead of assuming an external change.'
  ]
  const summary = lines.join('\n').slice(0, 6000)
  return { sourceInvocationId: invocationId, sourceTurnId: turnId, historySequence: events.at(-1)?.sequence ?? 0, summary, state: unknownStarted ? 'unknown' as const : 'known' as const }
}
