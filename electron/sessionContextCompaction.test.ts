import { describe, expect, it, vi } from 'vitest'
import { compactSessionContext, createSessionContextCheckpointMessage, createLostCompactionRepairId, lostCompactionRepairFallback, isSessionContextCheckpointWorthCompacting } from './sessionContextCompaction'
import { appendCompactionTransaction, type SessionEventSink } from './sessionEvents'
import { computeReplaySurfaceFingerprint, projectReplaySurface, surfaceItemIdentities } from '../src/shared/surfaceReplay'
import { createContextRegistrar, createSessionContextAdapter, type ContextPort } from '../packages/agent-sdk/src/context'
import { safeSummaryContentText } from '../src/shared/safeSummaryText'
import { foldCompactionEvents } from '../src/shared/compactionEvents'

function makeSink() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  let seq = 0
  const sink = {
    eventsPath: '/tmp/test-events', indexPath: '/tmp/test-index',
    appendCritical: vi.fn(async (event: { type: string; payload: Record<string, unknown> }) => {
      const committed = { seq: ++seq, time: seq, type: event.type, payload: event.payload }
      events.push(committed)
      return committed
    }),
    appendChunk: vi.fn(), waitForCapacity: vi.fn(async () => {}), flush: vi.fn(async () => ({ committedEvents: 0, seq, pendingEvents: 0, pendingBytes: 0, failed: false, lostEvents: 0, lostBytes: 0, indexStale: false })),
    close: vi.fn(async () => ({ committedEvents: 0, seq, pendingEvents: 0, pendingBytes: 0, failed: false, lostEvents: 0, lostBytes: 0, indexStale: false }))
  }
  return { sink: sink as unknown as SessionEventSink, events }
}
const messages = [
  { id: 'u1', role: 'user' as const, content: 'Earlier question '.repeat(120) },
  { id: 'a1', role: 'assistant' as const, content: 'Earlier answer '.repeat(120) },
  { id: 'u2', role: 'user' as const, content: 'Recent question '.repeat(120) },
  { id: 'a2', role: 'assistant' as const, content: 'Recent answer '.repeat(120) }
]
const fingerprint = computeReplaySurfaceFingerprint('', projectReplaySurface(messages))
const summarizeFixture = async () => ({ task: 'Prior task', completed: 'Earlier tasks', decisions: 'Prior decision', constraints: 'Keep exact IDs', pending: 'Next step', blockers: 'None', nextStep: 'Continue' })

describe('safe summary text projection', () => {
  it('falls back to full expansion only after a new-split repair itself fails', () => {
    expect(lostCompactionRepairFallback('new-split', { status: 'failed' })).toEqual({ status: 'context-too-large', fallback: 'full-expand' })
    expect(lostCompactionRepairFallback('new-split', { status: 'uncompressible' })).toEqual({ status: 'context-too-large', fallback: 'full-expand' })
    expect(lostCompactionRepairFallback('new-split', { status: 'busy' })).toEqual({ status: 'busy' })
    expect(lostCompactionRepairFallback('new-split', { status: 'stale' })).toEqual({ status: 'stale' })
    expect(lostCompactionRepairFallback('new-split', { status: 'commit-uncertain' })).toEqual({ status: 'commit-uncertain' })
    expect(lostCompactionRepairFallback('replay-original', { status: 'failed' })).toEqual({ status: 'failed' })
  })

  it('derives a stable repair identity from the source snapshot, lost window, and repair branch', () => {
    const input = { sessionId: 's1', sourceVersion: 'watermark:42', lostWindow: { start: 'm1', end: 'm8' }, branch: 'replay-original' as const }
    const first = createLostCompactionRepairId(input)
    expect(createLostCompactionRepairId(input)).toBe(first)
    expect(first).toMatch(/^lost-compaction-repair:s1:[a-f0-9]{64}$/)
    expect(createLostCompactionRepairId({ ...input, sourceVersion: 'watermark:43' })).not.toBe(first)
    expect(createLostCompactionRepairId({ ...input, branch: 'new-split' })).not.toBe(first)
  })

  it('omits image and nested binary payloads while retaining readable text', () => {
    const imagePayload = 'aGVsbG8='.repeat(100)
    const projected = safeSummaryContentText([
      { type: 'text', text: 'please inspect this' },
      { type: 'image', mimeType: 'image/png', data: imagePayload },
      { type: 'file', metadata: { bytes: imagePayload, label: 'attachment' } }
    ])
    expect(projected).toContain('please inspect this')
    expect(projected).toContain('image payload omitted from text summary')
    expect(projected).toContain('attachment')
    expect(projected).not.toContain(imagePayload)
  })
})
function makeAdapter(sink: SessionEventSink, inputMessages: typeof messages, fp: () => Promise<string> = async () => computeReplaySurfaceFingerprint('', projectReplaySurface(inputMessages)), busy: () => boolean = () => false) {
  const registrar = createContextRegistrar()
  const surfaceMessages = projectReplaySurface(inputMessages)
  const identities = surfaceItemIdentities(surfaceMessages)
  const items = surfaceMessages.map((message, index) => ({ replayIdentity: identities[index]!, sourceMessageIds: [inputMessages[index]!.id!], message, sourceData: {} }))
  const frame = { items, system: '', windowId: 'window-1', pendingTools: [] }
  return createSessionContextAdapter({
    scope: { kind: 'session', sessionId: 's1' }, registrar,
    capture: async () => ({ frame, surfaceFingerprint: await fp() }),
    persist: async ({ historyPayload }) => {
      if (busy()) return { status: 'busy' as const }
      const tx = historyPayload as { start: Record<string, unknown>; summary: Record<string, unknown> }
      await appendCompactionTransaction(sink, tx.start, tx.summary)
      return { status: 'committed' as const }
    }
  })
}

describe('manual session context compaction', () => {
  it('reuses only the model summary while rebuilding current system facts and rejects checkpoints without token savings', () => {
    const summary = { task: 'Task', completed: 'Done', decisions: 'Decision', constraints: 'Constraint', pending: 'Pending', blockers: 'None', nextStep: 'Continue' }
    const firstFacts = { unresolvedEffects: [{ id: 'effect-old', originInvocationId: 'i1', toolCallId: 't1' }], toolOutcomes: [] }
    const currentFacts = { unresolvedEffects: [{ id: 'effect-new', originInvocationId: 'i2', toolCallId: 't2' }], toolOutcomes: [{ id: 'i2:t2', outcome: 'unknown-after-dispatch' as const }] }
    const first = createSessionContextCheckpointMessage('checkpoint', summary, firstFacts)
    const reused = createSessionContextCheckpointMessage('checkpoint', summary, currentFacts)
    expect(JSON.parse(reused.content)).toMatchObject({ task: 'Task', unresolvedEffectIds: ['effect-new'], toolOutcomes: [{ id: 'i2:t2', outcome: 'unknown-after-dispatch' }] })
    expect(reused.content).not.toContain('effect-old')
    expect(isSessionContextCheckpointWorthCompacting(first, 1)).toBe(false)
    expect(isSessionContextCheckpointWorthCompacting(first, 100_000)).toBe(true)
  })

  it('keeps recovery IDs and outcomes as host facts in the checkpoint without asking the summarizer to author them', async () => {
    const recoveryFacts = { unresolvedEffects: [{ id: 'origin:call-1', originInvocationId: 'origin', toolCallId: 'call-1' }], toolOutcomes: [{ id: 'origin:call-1', outcome: 'unknown-after-dispatch' as const }] }
    const summarize = vi.fn(async () => ({ task: 'Prior task', completed: 'Earlier tasks', decisions: 'Prior decision', constraints: 'Keep exact IDs', pending: 'Next step', blockers: 'None', nextStep: 'Continue' }))
    const { sink, events } = makeSink()
    await compactSessionContext({ sessionId: 's1', requestId: 'recovery-facts', windowId: 'window-1', messages, totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, messages), recoveryFacts, summarize })
    expect(summarize).toHaveBeenCalledWith(expect.any(Array), 'en-US', recoveryFacts, undefined)
    const candidate = events[1]?.payload.candidate as { checkpointMessage: { content: string } }
    expect(JSON.parse(candidate.checkpointMessage.content)).toMatchObject({ unresolvedEffectIds: ['origin:call-1'], toolOutcomes: [{ id: 'origin:call-1', outcome: 'unknown-after-dispatch' }] })
  })
  it('submits a registered candidate through ContextPort instead of owning a sink', async () => {
    const commits: unknown[] = []
    const registrar = createContextRegistrar()
    const surfaceMessages = projectReplaySurface(messages)
    const identities = surfaceItemIdentities(surfaceMessages)
    const base = registrar.captureFrame({ scope: { kind: 'session', sessionId: 's1' }, frame: { items: surfaceMessages.map((message, index) => ({ replayIdentity: identities[index]!, sourceMessageIds: [messages[index]!.id!], message, sourceData: {} })), system: '', windowId: 'window-1', pendingTools: [] }, binding: { kind: 'session', surfaceFingerprint: fingerprint } })
    const contextPort = {
      readCurrent: vi.fn(async () => base),
      registerTransformation: vi.fn(({ base: candidateBase, output }) => ({ base: candidateBase, output, evidence: { token: 'proof' } })),
      commitReplacement: vi.fn(async (input) => { commits.push(input); return { status: 'committed' as const, snapshot: {} as never, receipt: { operationId: input.operationId, windowId: 'window-1', inputFingerprint: fingerprint, outputFingerprint: 'out' } } })
    }
    const result = await compactSessionContext({
      sessionId: 's1', requestId: 'port-1', windowId: 'window-1', messages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: { port: contextPort, registerTransformation: (input) => registrar.registerTransformation(input) },
      summarize: summarizeFixture
    })
    expect(result.status).toBe('committed')
    expect(contextPort.commitReplacement).toHaveBeenCalledOnce()
    expect(commits[0]).toMatchObject({ reason: 'manual-compact', candidate: { output: { items: expect.any(Array) } } })
  })

  it('reuses a canonical repair commit after restart without summarizing again', async () => {
    const { sink, events } = makeSink()
    const repair = { sourceVersion: 'watermark:42', lostWindow: { start: 'lost-start', end: 'lost-end' }, branch: 'new-split' as const,
      replay: { committed: [], rejected: [] } }
    const summarize = vi.fn(summarizeFixture)
    const first = await compactSessionContext({ sessionId: 's1', requestId: 'repair', windowId: 'window-1', messages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, messages), repair, summarize })
    expect(first.status).toBe('committed')
    expect(summarize).toHaveBeenCalledOnce()
    const replay = foldCompactionEvents(events.map(({ type, payload }, index) => ({ type: type as 'compaction_start' | 'compaction_summary' | 'compaction_end', payload, seq: index + 1 })))
    const restartRepair = { ...repair, replay }
    const changedAfterCommit = [...messages, { id: 'u3', role: 'user' as const, content: 'later message' }]
    const resumed = await compactSessionContext({ sessionId: 's1', requestId: 'repair', windowId: 'window-1', messages: changedAfterCommit,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, changedAfterCommit), repair: restartRepair, summarize })
    expect(resumed).toEqual(first)
    expect(summarize).toHaveBeenCalledOnce()
    expect(events.filter(({ type }) => type === 'compaction_summary')).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ compactionId: first.compactionId, reason: 'lost_compaction_repair', repairIdentity: { branch: 'new-split', sourceVersion: 'watermark:42' } })
  })

  it('replays the exact verified source window when repair metadata is complete', async () => {
    const { sink, events } = makeSink()
    const identities = surfaceItemIdentities(projectReplaySurface(messages))
    const summarize = vi.fn(async () => summarizeFixture())
    const replay = await compactSessionContext({ sessionId: 's1', requestId: 'repair-original', windowId: 'window-1', messages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, messages), summarize,
      repair: { sourceVersion: 'watermark:42', lostWindow: { start: identities[0]!, end: identities[1]! }, lostRanges: [{ start: identities[0]!, end: identities[1]! }], branch: 'replay-original', replay: { committed: [], rejected: [] } } })
    expect(replay.status).toBe('committed')
    expect(events[1]?.payload.shadowedRanges).toEqual([{ start: identities[0], end: identities[1] }])
    expect(summarize).toHaveBeenCalledOnce()
    expect(summarize.mock.calls[0]?.[0].map(({ content }) => content.trim())).toEqual(messages.slice(0, 2).map(({ content }) => content.trim()))
  })

  it('commits one user_compact transaction without creating a message, turn, or tool event', async () => {
    const { sink, events } = makeSink()
    const result = await compactSessionContext({
      sessionId: 's1', requestId: 'compact-1', windowId: 'window-1', messages,
      totalInputBudget: 10_000, locale: 'zh-CN', contextAdapter: makeAdapter(sink, messages),
      summarize: summarizeFixture,
    })
    expect(result.status).toBe('committed')
    expect(events.map((event) => event.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect(events[0]?.payload).toMatchObject({ reason: 'user_compact', windowId: 'window-1' })
    expect(events[0]?.payload.turnId).toBeUndefined()
    expect(events[1]?.payload.candidate).toMatchObject({ kind: 'summary', checkpointMessage: { role: 'user' } })
    expect(JSON.stringify(events)).not.toContain('tool_call')
  })

  it('returns busy, no-op, stale and failed without reporting a commit', async () => {
    const busy = makeSink()
    await expect(compactSessionContext({ sessionId: 's1', requestId: 'r', windowId: 'window-1', messages, totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(busy.sink, messages, async () => fingerprint, () => true), summarize: summarizeFixture })).resolves.toMatchObject({ status: 'busy' })
    const short = makeSink()
    await expect(compactSessionContext({ sessionId: 's1', requestId: 'r', windowId: 'window-1', messages: messages.slice(-2), totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(short.sink, messages.slice(-2)), summarize: summarizeFixture })).resolves.toMatchObject({ status: 'no-op' })
    const stale = makeSink()
    const changedSurface = [...messages.slice(0, 3), { id: 'u3', role: 'user' as const, content: 'arrived' }]
    await expect(compactSessionContext({ sessionId: 's1', requestId: 'r', windowId: 'window-1', messages, totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(stale.sink, changedSurface), summarize: summarizeFixture })).resolves.toMatchObject({ status: 'stale' })
    expect(stale.events).toHaveLength(0)
    const failedSink = makeSink()
    failedSink.sink.appendCritical = vi.fn(async () => { throw new Error('disk failed') }) as never
    await expect(compactSessionContext({ sessionId: 's1', requestId: 'r', windowId: 'window-1', messages, totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(failedSink.sink, messages), summarize: summarizeFixture })).resolves.toMatchObject({ status: 'commit-uncertain' })
  })

  it('returns explicit cancel and commit-uncertain repair exits', async () => {
    const canceled = new AbortController()
    const canceledSink = makeSink()
    const repair = { sourceVersion: 'watermark:42', lostWindow: { start: 'lost-start', end: 'lost-end' }, branch: 'new-split' as const,
      replay: { committed: [], rejected: [] } }
    const cancelResult = await compactSessionContext({ sessionId: 's1', requestId: 'cancel', windowId: 'window-1', messages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(canceledSink.sink, messages), signal: canceled.signal, repair,
      summarize: async () => { canceled.abort(); return summarizeFixture() } })
    expect(cancelResult).toEqual({ status: 'cancel' })
    expect(canceledSink.events).toHaveLength(0)

    const registrar = createContextRegistrar()
    const surfaceMessages = projectReplaySurface(messages)
    const identities = surfaceItemIdentities(surfaceMessages)
    const base = registrar.captureFrame({ scope: { kind: 'session', sessionId: 's1' }, frame: { items: surfaceMessages.map((message, index) => ({ replayIdentity: identities[index]!, sourceMessageIds: [messages[index]!.id!], message, sourceData: {} })), system: '', windowId: 'window-1', pendingTools: [] }, binding: { kind: 'session', surfaceFingerprint: fingerprint } })
    const port = {
      readCurrent: async () => base,
      commitReplacement: async () => ({ status: 'commit-uncertain' as const, error: new Error('lost acknowledgement') }),
    }
    const uncertain = await compactSessionContext({ sessionId: 's1', requestId: 'uncertain', windowId: 'window-1', messages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: { port, registerTransformation: (input) => registrar.registerTransformation(input) }, repair,
      summarize: summarizeFixture })
    expect(uncertain).toEqual({ status: 'commit-uncertain' })
  })

  it('binds the prepared fingerprint to the complete current surface, including a new tail message', async () => {
    const { sink, events } = makeSink()
    const changedSurface = [messages[0]!, messages[1]!, messages[2]!, { id: 'u3', role: 'user' as const, content: 'arrived during compaction' }]
    const result = await compactSessionContext({
      sessionId: 's1', requestId: 'changed-tail', windowId: 'window-1', messages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, changedSurface),
      summarize: async (source) => {
        const ending = source.map((message) => message.content).join('\n').slice(-120)
        return { task: 'Earlier task', completed: 'Earlier work', decisions: ending, constraints: 'Keep IDs', pending: 'Continue the current task', blockers: 'None', nextStep: 'Continue' }
      },
    })
    expect(result).toEqual({ status: 'stale' })
    expect(events).toHaveLength(0)
  })

  it('preserves late historical decisions beyond the former 1200-character prefix', async () => {
    const { sink, events } = makeSink()
    const longMessages = [
      { id: 'u1', role: 'user' as const, content: `${'background '.repeat(180)}LATE_DECISION_KEEP_THIS` },
      { id: 'a1', role: 'assistant' as const, content: 'ack '.repeat(100) },
      ...messages.slice(2)
    ]
    const result = await compactSessionContext({
      sessionId: 's1', requestId: 'late-decision', windowId: 'window-1', messages: longMessages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, longMessages),
      summarize: async (source) => ({
        task: source.map((message) => message.content).join('\n').includes('LATE_DECISION_KEEP_THIS') ? 'LATE_DECISION_KEEP_THIS' : 'Prior task',
        completed: 'Earlier work', decisions: 'Prior decision', constraints: 'Keep IDs', pending: 'Next step', blockers: 'None', nextStep: 'Continue'
      }),
      currentFingerprint: async () => computeReplaySurfaceFingerprint('', projectReplaySurface(longMessages)), isBusy: () => false
    })
    expect(result.status).toBe('committed')
    const checkpoint = events[1]?.payload.candidate as { checkpointMessage?: { content?: string } }
    expect(checkpoint.checkpointMessage?.content).toContain('LATE_DECISION_KEEP_THIS')
  })

  it('returns no-op without events when the concrete checkpoint would not reduce shadowed tokens', async () => {
    const { sink, events } = makeSink()
    const summarize = vi.fn(summarizeFixture)
    const shortHistory = [
      { id: 'short-u1', role: 'user' as const, content: 'x' },
      { id: 'short-a1', role: 'assistant' as const, content: 'y' },
      { id: 'short-u2', role: 'user' as const, content: 'z' }
    ]
    const result = await compactSessionContext({
      sessionId: 's1', requestId: 'no-savings', windowId: 'window-1', messages: shortHistory,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, shortHistory),
      summarize,
      currentFingerprint: async () => computeReplaySurfaceFingerprint('', projectReplaySurface(shortHistory)), isBusy: () => false
    })
    expect(result).toEqual({ status: 'no-op' })
    expect(events).toHaveLength(0)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('uses a semantic summary for decisions in the middle of the shadowed history', async () => {
    const { sink, events } = makeSink()
    const middleDecision = 'MIDDLE_DECISION_MUST_SURVIVE'
    const middleMessages = [
      { id: 'middle-u1', role: 'user' as const, content: `${'background '.repeat(40)}${middleDecision}${'closing discussion '.repeat(40)}` },
      { id: 'middle-a1', role: 'assistant' as const, content: 'routine response '.repeat(100) },
      ...messages.slice(2)
    ]
    const summarize = vi.fn(async (source: readonly { role: string; content: unknown }[]) => {
      const transcript = source.map((message) => String(message.content)).join('\n')
      return { task: transcript.includes(middleDecision) ? middleDecision : '', completed: 'Earlier work', decisions: 'Routine decision', constraints: 'Keep IDs', pending: 'Continue current task', blockers: 'None', nextStep: 'Continue' }
    })
    const result = await compactSessionContext({
      sessionId: 's1', requestId: 'middle-decision', windowId: 'window-1', messages: middleMessages,
      totalInputBudget: 10_000, locale: 'en-US', contextAdapter: makeAdapter(sink, middleMessages), summarize,
      currentFingerprint: async () => computeReplaySurfaceFingerprint('', projectReplaySurface(middleMessages)), isBusy: () => false
    })
    expect(summarize).toHaveBeenCalledOnce()
    expect(result.status).toBe('committed')
    const candidate = events[1]?.payload.candidate as { checkpointMessage?: { content?: string } }
    expect(candidate.checkpointMessage?.content).toContain(middleDecision)
  })
})
