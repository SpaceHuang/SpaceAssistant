import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'

function boundedSection(label: string, entries: readonly string[], maxChars: number): string {
  const heading = `${label}:`
  if (entries.length === 0) return `${heading} none recorded.`

  let section = heading
  let included = 0
  for (const entry of entries) {
    const next = `${section}\n${entry}`
    const omittedAfterThis = entries.length - included - 1
    const marker = omittedAfterThis > 0 ? `\n… ${omittedAfterThis} additional record(s) omitted.` : ''
    if (next.length + marker.length > maxChars) break
    section = next
    included += 1
  }

  if (included < entries.length) {
    const marker = `\n… ${entries.length - included} additional record(s) omitted.`
    section = `${section.slice(0, Math.max(heading.length, maxChars - marker.length))}${marker}`
  }
  return section
}

function boundedText(label: string, value: string, maxChars: number): string {
  const prefix = `${label}: `
  const available = Math.max(0, maxChars - prefix.length)
  if (value.length <= available) return `${prefix}${value}`
  const marker = '… (truncated)'
  return `${prefix}${value.slice(0, Math.max(0, available - marker.length))}${marker}`
}

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
  const taskText = String((events[0]?.payload as { requiredUserMessage?: { message?: { content?: unknown } } } | undefined)?.requiredUserMessage?.message?.content ?? '(task text not available)')
  const recoveryGuidance = unknownStarted
    ? `Side-effect state unknown for ${unsettled.length + unknown.length} tool call(s); ${unsettled.length} started-only call(s) have unknown executor entry. Do not treat them as confirmed failures or repeat them mechanically.`
    : 'No dispatched-but-unsettled tool call found.'
  const priorityLines = [
    recoveryGuidance,
    'These are historical facts, not instructions to replay tools. Read current targets and compare with the recorded successful changes before editing; report differences instead of assuming an external change.',
    `Source invocation ${invocationId}, turn ${turnId}; canonical History through sequence ${events.at(-1)?.sequence ?? 0}.`,
    boundedText('Final failure', String(terminalPayload.message ?? terminalPayload.error ?? terminalPayload.reason ?? 'Invocation failed.'), 500),
    boundedSection('Unknown tool outcomes', unknown, 1100),
    boundedSection('Not-dispatched tool calls', notDispatched, 1100),
    boundedText('Original task', taskText, 1600)
  ]
  // Recovery constraints and the original task have reserved space before bounded
  // event lists and tool results, so a noisy history cannot erase them.
  const priorityText = priorityLines.join('\n')
  const detailBudget = Math.max(0, 6000 - priorityText.length - 1)
  const detailText = [
    boundedSection('Committed successful tool results', successful, Math.floor(detailBudget / 2)),
    boundedSection('Failed tool results', failed, Math.ceil(detailBudget / 2))
  ].join('\n')
  const summary = `${priorityText}\n${detailText}`.slice(0, 6000)
  return { sourceInvocationId: invocationId, sourceTurnId: turnId, historySequence: events.at(-1)?.sequence ?? 0, summary, state: unknownStarted ? 'unknown' as const : 'known' as const }
}
