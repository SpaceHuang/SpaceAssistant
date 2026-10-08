import { describe, expect, it, vi } from 'vitest'
import { createContextRegistrar, createSessionContextPort, type ContextFrame, type ContextScope } from '../src/context'

const scope: Extract<ContextScope, { kind: 'session' }> = { kind: 'session', sessionId: 'session-manual' }
const frame: ContextFrame = {
  items: [{ replayIdentity: 'message-1', sourceMessageIds: ['message-1'], message: { role: 'user', id: 'message-1', content: 'old' }, sourceData: {} }],
  system: '', windowId: 'window-1', pendingTools: []
}

describe('session ContextPort', () => {
  it('uses the captured surface fingerprint as a CAS and returns the committed receipt', async () => {
    let fingerprint = 'surface-v1'
    const persist = vi.fn(async () => ({ status: 'committed' as const }))
    const registrar = createContextRegistrar()
    const port = createSessionContextPort({
      registrar, scope,
      capture: async () => ({ frame, surfaceFingerprint: fingerprint }),
      persist
    })
    const base = await port.readCurrent(scope)
    const output = { ...frame, items: [{ ...frame.items[0]!, message: { role: 'user' as const, id: 'message-1', content: 'replacement' } }] }
    const candidate = registrar.registerTransformation({ base, output, proof: {
      historyPayload: { compactionId: 'compact-1' },
      sourceBindings: [{ outputIdentity: 'message-1', inputIdentities: ['message-1'] }], shadowedRanges: []
    } })

    const result = await port.commitReplacement({ operationId: 'manual-1', reason: 'manual-compact', candidate })
    expect(result).toMatchObject({ status: 'committed', receipt: { operationId: 'manual-1', inputFingerprint: 'surface-v1' } })
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ expectedSurfaceFingerprint: 'surface-v1', operationId: 'manual-1' }))
    expect(fingerprint).toBe('surface-v1')
  })

  it('rejects an output substituted after evidence registration before session persistence', async () => {
    const persist = vi.fn(async () => ({ status: 'committed' as const }))
    const registrar = createContextRegistrar()
    const port = createSessionContextPort({ registrar, scope, capture: async () => ({ frame, surfaceFingerprint: 'surface-v1' }), persist })
    const base = await port.readCurrent(scope)
    const candidate = registrar.registerTransformation({ base, output: { ...frame, windowId: 'window-2' }, proof: {
      historyPayload: {}, sourceBindings: [{ outputIdentity: 'message-1', inputIdentities: ['message-1'] }], shadowedRanges: []
    } })
    const substituted = { ...candidate, output: { ...candidate.output, items: [], requiredUser: undefined } }

    await expect(port.commitReplacement({ operationId: 'forged-session-candidate', reason: 'window-transition', candidate: substituted }))
      .rejects.toThrow('CONTEXT_EVIDENCE_CANDIDATE_MISMATCH')
    expect(persist).not.toHaveBeenCalled()
  })

  it('uses the registered output if the caller mutates its candidate while capture is pending', async () => {
    let releaseCapture!: () => void
    let captureStarted!: () => void
    const started = new Promise<void>((resolve) => { captureStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseCapture = resolve })
    let captures = 0
    const persist = vi.fn(async () => ({ status: 'committed' as const }))
    const registrar = createContextRegistrar()
    const port = createSessionContextPort({
      registrar, scope,
      capture: async () => {
        if (++captures === 2) { captureStarted(); await gate }
        return { frame, surfaceFingerprint: 'surface-v1' }
      },
      persist
    })
    const base = await port.readCurrent(scope)
    const candidate = registrar.registerTransformation({ base, output: { ...frame, windowId: 'window-2' }, proof: {
      historyPayload: {}, sourceBindings: [{ outputIdentity: 'message-1', inputIdentities: ['message-1'] }], shadowedRanges: []
    } })
    const submitted = structuredClone(candidate)
    const committing = port.commitReplacement({ operationId: 'mutated-during-capture', reason: 'window-transition', candidate: submitted })
    await started
    Object.assign(submitted.output, { items: [], requiredUser: undefined })
    releaseCapture()

    await expect(committing).resolves.toMatchObject({ status: 'committed', snapshot: { frame: { windowId: 'window-2' } } })
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ output: expect.objectContaining({ windowId: 'window-2', items: frame.items }) }))
  })

  it('keeps the registered output when the caller mutates its candidate while persistence is pending', async () => {
    let releasePersist!: () => void
    let persistStarted!: () => void
    const started = new Promise<void>((resolve) => { persistStarted = resolve })
    const gate = new Promise<void>((resolve) => { releasePersist = resolve })
    const persist = vi.fn(async () => { persistStarted(); await gate; return { status: 'committed' as const } })
    const registrar = createContextRegistrar()
    const port = createSessionContextPort({ registrar, scope, capture: async () => ({ frame, surfaceFingerprint: 'surface-v1' }), persist })
    const base = await port.readCurrent(scope)
    const candidate = registrar.registerTransformation({ base, output: { ...frame, windowId: 'window-2' }, proof: {
      historyPayload: {}, sourceBindings: [{ outputIdentity: 'message-1', inputIdentities: ['message-1'] }], shadowedRanges: []
    } })
    const submitted = structuredClone(candidate)
    const committing = port.commitReplacement({ operationId: 'mutated-during-persist', reason: 'window-transition', candidate: submitted })
    await started
    Object.assign(submitted.output, { items: [], requiredUser: undefined })
    releasePersist()

    await expect(committing).resolves.toMatchObject({ status: 'committed', snapshot: { frame: { items: frame.items } } })
  })

  it('does not persist when the captured session surface became stale', async () => {
    let fingerprint = 'surface-v1'
    const persist = vi.fn(async () => ({ status: 'committed' as const }))
    const registrar = createContextRegistrar()
    const port = createSessionContextPort({ registrar, scope, capture: async () => ({ frame, surfaceFingerprint: fingerprint }), persist })
    const base = await port.readCurrent(scope)
    const candidate = registrar.registerTransformation({ base, output: { ...frame, windowId: 'window-2' }, proof: {
      historyPayload: {}, sourceBindings: [{ outputIdentity: 'message-1', inputIdentities: ['message-1'] }], shadowedRanges: []
    } })
    fingerprint = 'surface-v2'

    await expect(port.commitReplacement({ operationId: 'manual-stale', reason: 'manual-compact', candidate })).resolves.toEqual({ status: 'stale' })
    expect(persist).not.toHaveBeenCalled()
  })
})
