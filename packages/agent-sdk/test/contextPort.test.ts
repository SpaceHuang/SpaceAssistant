import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createContextRegistrar, createInvocationContextPort, type ContextFrame, type ContextScope } from '../src/context'
import { InvocationHistoryWriter, MemoryHistory } from '../src/history'
import { contextFrameFromMessages } from '../src/turn'

const scope: Extract<ContextScope, { kind: 'invocation' }> = { kind: 'invocation', sessionId: 'session-context', invocationId: 'inv-context' }
const frame: ContextFrame = {
  items: [{ replayIdentity: 'input-user', sourceMessageIds: ['user-1'], message: { role: 'user', id: 'user-1', content: 'task' }, sourceData: {} }],
  system: 'system', windowId: 'window-1', pendingTools: [],
  requiredUser: { id: 'user-1', message: { role: 'user', id: 'user-1', content: 'task' } }
}

function setup(options?: { project?: () => void | Promise<void>; frame?: ContextFrame }) {
  const initialFrame = options?.frame ?? frame
  const history = new MemoryHistory()
  const writer = new InvocationHistoryWriter(history, { invocationId: 'inv-context', turnId: 'turn-context' })
  let current = { frame: initialFrame, phase: 'preflight' as const, epoch: 4, expectedHistoryVersion: 0 }
  const applied: unknown[] = []
  const registrar = createContextRegistrar()
  const binding = {
    scope,
    capture: async () => current,
    appendReplacement: (input: { epoch: number; expectedHistoryVersion: number; payload: Record<string, unknown> }) => writer.appendAtVersion(
      [{ kind: 'transcript-compacted', payload: input.payload }], input.expectedHistoryVersion,
      undefined,
      () => { if (input.epoch !== current.epoch) throw new Error('CONTEXT_EPOCH_STALE') }
    ),
    applyCommitted: (input: { frame: ContextFrame; epoch: number; historyVersion: number }) => {
      applied.push(input)
      current = { ...current, frame: input.frame, epoch: input.epoch, expectedHistoryVersion: input.historyVersion }
    }
  }
  const port = createInvocationContextPort({ binding, registrar })
  const baseBinding = { kind: 'invocation' as const, phase: 'preflight' as const, epoch: 4, expectedHistoryVersion: 0 }
  const base = registrar.captureFrame({ scope, frame: initialFrame, binding: baseBinding })
  const output: ContextFrame = { ...initialFrame, items: [structuredClone(initialFrame.items[0]!)], windowId: 'window-2' }
  const candidate = registrar.registerTransformation({ base, output, proof: {
    historyPayload: { recoveryReason: 'preflight' }, sourceBindings: [{ outputIdentity: 'input-user', inputIdentities: ['input-user'] }], shadowedRanges: [],
    ...(options?.project ? { commitProjection: options.project } : {})
  } })
  return { history, writer, current: () => current, setCurrent: (next: typeof current) => { current = next }, applied, registrar, binding, port, base, candidate }
}

describe('invocation ContextPort', () => {
  it('retains stable source identity, sourceData, and rich canonical blocks when rebuilding a frame', () => {
    const message: ContextFrame['items'][number]['message'] = {
      role: 'user', id: 'user-1', content: [
        { type: 'text', text: 'inspect the attached image' },
        { type: 'image', mimeType: 'image/png', data: 'image-data' }
      ]
    }
    const sourceData = { attachment: { stagingKey: 'stage-1', contentBlockIndex: 1 } }
    const base: ContextFrame = {
      ...frame,
      items: [{ replayIdentity: 'stable-surface-id', sourceMessageIds: ['user-1'], message, sourceData }]
    }
    const rebuilt = contextFrameFromMessages([structuredClone(message)], 'window-2', base.requiredUser, [], base)

    expect(rebuilt.items).toEqual([{ replayIdentity: 'stable-surface-id', sourceMessageIds: ['user-1'], message, sourceData }])
  })

  it('preserves source data, image blocks, and pending tools across a committed replacement', async () => {
    const imageMessage = {
      role: 'user' as const, id: 'user-1',
      content: [
        { type: 'text' as const, text: 'inspect this image' },
        { type: 'image' as const, mimeType: 'image/png' as const, data: 'base64-image-data' }
      ]
    }
    const sourceData = { attachment: { stagingKey: 'attachment-stage-1', ordinal: 0 } }
    const richFrame: ContextFrame = {
      ...frame,
      items: [{ replayIdentity: 'input-user', sourceMessageIds: ['user-1'], message: imageMessage, sourceData }],
      requiredUser: { id: 'user-1', message: imageMessage },
      pendingTools: [{ id: 'tool-1', name: 'inspect', input: { imageId: 'image-1' } }]
    }
    const state = setup({ frame: richFrame })
    const result = await state.port.commitReplacement({ operationId: 'rich-material-op', reason: 'window-transition', candidate: state.candidate })

    expect(result.status).toBe('committed')
    if (result.status !== 'committed') return
    expect(result.snapshot.frame.items).toEqual(richFrame.items)
    expect(result.snapshot.frame.requiredUser).toEqual(richFrame.requiredUser)
    expect(result.snapshot.frame.pendingTools).toEqual(richFrame.pendingTools)
  })

  it('persists and projects one replacement before adopting the new frame', async () => {
    const order: string[] = []
    const state = setup({ project: () => { order.push('projection') } })
    const originalApply = state.binding.applyCommitted
    state.binding.applyCommitted = (input) => { order.push('apply'); originalApply(input) }
    const payload = {
      messages: frame.items.map((item) => item.message),
      inputFingerprint: createHash('sha256').update(JSON.stringify(frame.items.map((item) => item.message))).digest('hex'),
      outputFingerprint: createHash('sha256').update(JSON.stringify(state.candidate.output.items.map((item) => item.message))).digest('hex'),
      requiredUserMessage: frame.requiredUser
    }
    const result = await state.port.commitReplacement({ operationId: 'compact-op', reason: 'auto-compact', candidate: state.candidate })

    expect(result).toMatchObject({ status: 'committed', receipt: { operationId: 'compact-op', windowId: 'window-2', historyVersion: 1 } })
    expect(order).toEqual(['projection', 'apply'])
    expect(await state.history.read('inv-context')).toMatchObject({ version: 1, events: [{ kind: 'transcript-compacted', payload }] })
    expect(state.current()).toMatchObject({ frame: state.candidate.output, expectedHistoryVersion: 1, epoch: 5 })
  })

  it('rejects a substituted candidate output before writing History or applying runtime state', async () => {
    const state = setup()
    const substituted = {
      ...state.candidate,
      output: { ...state.candidate.output, items: [], requiredUser: undefined }
    }

    await expect(state.port.commitReplacement({ operationId: 'substituted-output', reason: 'window-transition', candidate: substituted }))
      .rejects.toThrow('CONTEXT_EVIDENCE_CANDIDATE_MISMATCH')
    expect(state.applied).toHaveLength(0)
    await expect(state.history.read('inv-context')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('uses the registered output if the caller mutates its candidate while capture is pending', async () => {
    const state = setup()
    let releaseCapture!: () => void
    let captureStarted!: () => void
    const started = new Promise<void>((resolve) => { captureStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseCapture = resolve })
    state.binding.capture = async () => { captureStarted(); await gate; return state.current() }
    const submitted = structuredClone(state.candidate)
    const expectedOutput = structuredClone(state.candidate.output)
    const committing = state.port.commitReplacement({ operationId: 'mutated-during-capture', reason: 'auto-compact', candidate: submitted })
    await started
    Object.assign(submitted.output, { items: [], requiredUser: undefined })
    releaseCapture()

    await expect(committing).resolves.toMatchObject({ status: 'committed', snapshot: { frame: expectedOutput } })
    expect(state.applied).toEqual([expect.objectContaining({ frame: expectedOutput })])
    await expect(state.history.read('inv-context')).resolves.toMatchObject({
      version: 1,
      events: [{ kind: 'transcript-compacted', payload: { messages: expectedOutput.items.map((item) => item.message), requiredUserMessage: expectedOutput.requiredUser } }]
    })
  })

  it('keeps History and runtime output stable when the caller mutates its candidate while append is pending', async () => {
    const state = setup()
    let releaseAppend!: () => void
    let appendStarted!: () => void
    const started = new Promise<void>((resolve) => { appendStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseAppend = resolve })
    const append = state.binding.appendReplacement
    state.binding.appendReplacement = async (input) => { appendStarted(); await gate; return append(input) }
    const submitted = structuredClone(state.candidate)
    const expectedOutput = structuredClone(state.candidate.output)
    const committing = state.port.commitReplacement({ operationId: 'mutated-during-append', reason: 'auto-compact', candidate: submitted })
    await started
    Object.assign(submitted.output, { items: [], requiredUser: undefined })
    releaseAppend()

    await expect(committing).resolves.toMatchObject({ status: 'committed', snapshot: { frame: expectedOutput } })
    expect(state.applied).toEqual([expect.objectContaining({ frame: expectedOutput })])
    await expect(state.history.read('inv-context')).resolves.toMatchObject({
      version: 1,
      events: [{ kind: 'transcript-compacted', payload: { messages: expectedOutput.items.map((item) => item.message), requiredUserMessage: expectedOutput.requiredUser } }]
    })
  })

  it('returns stale without appending when the captured epoch changed during planning', async () => {
    const state = setup()
    state.binding.capture = async () => ({ ...state.current(), epoch: 5 })

    await expect(state.port.commitReplacement({ operationId: 'stale-op', reason: 'auto-compact', candidate: state.candidate }))
      .resolves.toEqual({ status: 'stale' })
    await expect(state.history.read('inv-context')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('rechecks epoch inside the writer queue after the initial fence check', async () => {
    const state = setup()
    const resultPromise = state.port.commitReplacement({ operationId: 'epoch-race-op', reason: 'auto-compact', candidate: state.candidate })
    state.setCurrent({ ...state.current(), epoch: 5 })

    await expect(resultPromise).resolves.toEqual({ status: 'stale' })
    await expect(state.history.read('inv-context')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('returns uncompressible without writing History or projecting the replacement', async () => {
    const state = setup()
    const projection = vi.fn()
    const candidate = state.registrar.registerTransformation({
      base: state.base, output: state.candidate.output, proof: {
        historyPayload: {},
        sourceBindings: [{ outputIdentity: 'input-user', inputIdentities: ['input-user'] }],
        shadowedRanges: [], commitProjection: projection
      }
    })
    state.binding.appendReplacement = async () => ({ status: 'uncompressible' as const }) as never

    const result = await state.port.commitReplacement({ operationId: 'uncompressible-op', reason: 'auto-compact', candidate })

    expect(result).toEqual({ status: 'uncompressible' })
    expect(projection).not.toHaveBeenCalled()
    expect(state.applied).toHaveLength(0)
    await expect(state.history.read('inv-context')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('reports commit-uncertain if projection fails after History committed and does not adopt memory', async () => {
    const state = setup({ project: () => { throw new Error('projection failed') } })
    const result = await state.port.commitReplacement({ operationId: 'uncertain-op', reason: 'auto-compact', candidate: state.candidate })

    expect(result).toMatchObject({ status: 'commit-uncertain', receipt: { operationId: 'uncertain-op', historyVersion: 1 }, error: new Error('projection failed') })
    expect(state.applied).toHaveLength(0)
    await expect(state.history.read('inv-context')).resolves.toMatchObject({ version: 1, events: [{ kind: 'transcript-compacted' }] })
  })

  it('reports commit-uncertain when the History writer cannot determine whether append committed', async () => {
    const state = setup()
    const error = Object.assign(new Error('commit outcome unknown'), { name: 'TransactionCommitUnknownError' })
    state.binding.appendReplacement = async () => { throw error }

    const result = await state.port.commitReplacement({ operationId: 'unknown-append-op', reason: 'auto-compact', candidate: state.candidate })

    expect(result).toMatchObject({ status: 'commit-uncertain', error })
    expect(state.applied).toHaveLength(0)
  })

  it('rethrows a known History append failure without adopting the candidate', async () => {
    const state = setup()
    state.binding.appendReplacement = async () => { throw new Error('transaction rolled back') }

    await expect(state.port.commitReplacement({ operationId: 'known-append-failure', reason: 'auto-compact', candidate: state.candidate }))
      .rejects.toThrow('transaction rolled back')
    expect(state.applied).toHaveLength(0)
    await expect(state.history.read('inv-context')).resolves.toMatchObject({ version: 0, events: [] })
  })

  it('rejects payloads that overwrite SDK-owned transcript material before append', async () => {
    const state = setup()
    const candidate = state.registrar.registerTransformation({
      base: state.base, output: state.candidate.output,
      proof: {
        historyPayload: { messages: [{ role: 'user', content: 'forged' }] },
        sourceBindings: [{ outputIdentity: 'input-user', inputIdentities: ['input-user'] }],
        shadowedRanges: []
      }
    })

    await expect(state.port.commitReplacement({ operationId: 'reserved-payload-conflict', reason: 'auto-compact', candidate }))
      .rejects.toThrow('CONTEXT_HISTORY_PAYLOAD_CONFLICT:messages')
    await expect(state.history.read('inv-context')).resolves.toMatchObject({ version: 0, events: [] })
  })
})
