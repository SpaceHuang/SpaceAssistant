import { describe, expect, it } from 'vitest'
import { applyCommittedSurfaceShadow, computeReplaySurfaceFingerprint, computeShadowedRanges, projectReplaySurface, restoreReplaySurface, surfaceItemIdentities, surfaceItemIdentity } from './surfaceReplay'
import { computeCompactionSummaryHash, foldCompactionEvents } from './compactionEvents'

describe('surface replay', () => {
  it('uses content identity when a surface item has no explicit id', () => {
    expect(surfaceItemIdentity({ role: 'user', content: 'same' }, 0)).toBe(surfaceItemIdentity({ role: 'user', content: 'same' }, 9))
  })
  it('uses the same canonical fingerprint for provider and persisted message shapes', () => {
    expect(computeReplaySurfaceFingerprint('system', [{ role: 'user', content: 'hello' }])).toBe(computeReplaySurfaceFingerprint('system', [{ id: 'u1', role: 'user', content: 'hello', status: 'sent' }]))
  })
  it('keeps replay fingerprints stable across dynamic system prompts', () => {
    const surface = [{ role: 'user', content: 'hello' }]
    expect(computeReplaySurfaceFingerprint('base', surface)).toBe(computeReplaySurfaceFingerprint('base\n\nupdated skills', surface))
  })
  it('uses the same identity and fingerprint for assistant blocks and persisted text', () => {
    const provider = { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
    const persisted = { id: 'db-assistant', role: 'assistant', content: 'answer', status: 'completed' }
    expect(surfaceItemIdentity(provider, 0)).toBe(surfaceItemIdentity(persisted, 0))
    expect(computeReplaySurfaceFingerprint('system', [provider])).toBe(computeReplaySurfaceFingerprint('system', [persisted]))
  })
  it('projects live tool turns to the same stable message sequence as persisted history', () => {
    const live = [{ role: 'user', content: 'question' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }] }, { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }]
    const persisted = [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer', toolCalls: [{ id: 'tool-1' }] }]
    expect(projectReplaySurface(live).map((m) => ({ role: m.role, content: m.content }))).toEqual(projectReplaySurface(persisted).map((m) => ({ role: m.role, content: m.content })))
    expect(computeReplaySurfaceFingerprint('system', projectReplaySurface(live))).toBe(computeReplaySurfaceFingerprint('system', projectReplaySurface(persisted)))
  })
  it('merges text before and after a tool call into the persisted assistant turn', () => {
    const live = [{ role: 'assistant', content: [{ type: 'text', text: 'before ' }, { type: 'tool_use', id: 't', name: 'read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }, { role: 'assistant', content: [{ type: 'text', text: 'after' }] }]
    expect(projectReplaySurface(live)).toEqual([{ role: 'assistant', content: 'before after' }])
  })
  it('does not use the lossy projection as the send surface without a replay change', () => {
    const full = [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }]
    const projected = projectReplaySurface(full)
    const replayed = applyCommittedSurfaceShadow(projected.map((message, index) => ({ ...message, id: surfaceItemIdentities(projected)[index]! })), { committed: [], rejected: [] }, [], 'w', (items) => computeReplaySurfaceFingerprint('system', items))
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(projected.map((message, index) => ({ ...message, id: surfaceItemIdentities(projected)[index]! }))))
    expect(full[0]!.content).toEqual([{ type: 'tool_use', id: 't', name: 'read', input: {} }])
    expect(full[1]!.content).toEqual([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }])
  })
  it('restores retained ordinary messages by their canonical identity', () => {
    const original = [{ id: 'u', role: 'user', content: 'question' }, { id: 'tail', role: 'user', content: 'next' }]
    const projected = projectReplaySurface(original)
    expect(restoreReplaySurface(original, projected)).toEqual(original)
  })
  it('restores the tool result paired with a retained tool-use assistant', () => {
    const original = [{ id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 't' }] }, { id: 'r', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }]
    const replayed = [{ id: 'a', role: 'assistant', content: 'summary' }]
    expect(restoreReplaySurface(original, replayed)).toEqual(original)
  })
  it('disambiguates repeated normalized messages by occurrence', () => {
    const identities = surfaceItemIdentities([{ role: 'user', content: 'same' }, { role: 'user', content: 'same' }, { role: 'user', content: 'other' }, { role: 'user', content: 'same' }])
    expect(new Set(identities).size).toBe(4)
    expect(identities[1]).toBe(`${identities[0]}#1`)
    expect(identities[3]).toBe(`${identities[0]}#2`)
  })
  it('keeps repeated-message identities stable after an earlier duplicate is shadowed', () => {
    const [first, second] = surfaceItemIdentities([{ role: 'user', content: 'same' }, { role: 'user', content: 'same' }])
    const replay = foldCompactionEvents([{
      seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'same|same', surfaceBoundaryId: 'db-2' }
    }, {
      seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', candidate: { shadowedRanges: [{ start: first, end: first }] }, summaryHash: computeCompactionSummaryHash({ shadowedRanges: [{ start: first, end: first }] }), outputSurfaceFingerprint: 'same', shadowedRanges: [{ start: first, end: first }] }
    }, {
      seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'same|same', outputSurfaceFingerprint: 'same', summaryHash: computeCompactionSummaryHash({ shadowedRanges: [{ start: first, end: first }] }) }
    }])
    const fingerprint = (values: readonly { content?: string }[]) => values.map((value) => value.content ?? '').join('|')
    expect(applyCommittedSurfaceShadow([{ id: 'db-1', role: 'user', content: 'same' }, { id: 'db-2', role: 'user', content: 'same' }], replay, [], 'w', fingerprint)).toEqual([{ id: 'db-2', role: 'user', content: 'same' }])
    expect(second).not.toBe(first)
  })
  it('uses the persisted identity for a checkpoint that duplicates an existing message', () => {
    const checkpoint = { id: 'checkpoint', role: 'user', content: 'same' }
    const candidate = { checkpointMessage: checkpoint, checkpointReplayIdentity: 'checkpoint-identity', shadowedRanges: [{ start: 'old', end: 'old' }] }
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'same|tail', surfaceBoundaryId: 'tail' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', candidate, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: 'same|tail', shadowedRanges: candidate.shadowedRanges } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'same|tail', outputSurfaceFingerprint: 'same|tail', summaryHash: computeCompactionSummaryHash(candidate) } }
    ])
    const fingerprint = (values: readonly { content?: string }[]) => values.map((value) => value.content ?? '').join('|')
    expect(applyCommittedSurfaceShadow([{ id: 'old', role: 'user', content: 'same' }, { id: 'tail', role: 'user', content: 'tail' }], replay, [], 'w', fingerprint)).toEqual([checkpoint, { id: 'tail', role: 'user', content: 'tail' }])
  })
  it('computes contiguous shadow ranges for reset output', () => {
    expect(computeShadowedRanges([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }], [{ id: 'a' }, { id: 'c' }, { id: 'e' }])).toEqual([{ start: 'b', end: 'b' }, { start: 'd', end: 'd' }])
  })
  it('hides committed shadow ranges without deleting facts or required input', () => {
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'in' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', summaryHash: 'h', outputSurfaceFingerprint: 'out', shadowedRanges: [{ start: 'old-1', end: 'old-2' }] } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h' } }
    ])
    const facts = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'current', required: true }, { id: 'tail' }]
    expect(applyCommittedSurfaceShadow(facts, replay, ['old-2'], 'w')).toEqual([{ id: 'old-2' }, { id: 'current', required: true }, { id: 'tail' }])
    expect(facts).toHaveLength(4)
  })

  it('does not apply another window shadow', () => {
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'other', windowId: 'other', inputSurfaceFingerprint: 'in' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'other', windowId: 'other', summaryHash: 'h', outputSurfaceFingerprint: 'out', shadowedRanges: [{ start: 'old-1', end: 'old-1' }] } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'other', windowId: 'other', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h' } }
    ])
    expect(applyCommittedSurfaceShadow([{ id: 'old-1' }], replay, [], 'current')).toEqual([{ id: 'old-1' }])
  })

  it('replays the committed checkpoint before the retained surface', () => {
    const candidate = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary' }, shadowedRanges: [{ start: 'old-1', end: 'old-1' }] }
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'checkpointed', windowId: 'w', inputSurfaceFingerprint: 'in' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'checkpointed', windowId: 'w', candidate, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: 'out', shadowedRanges: candidate.shadowedRanges } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'checkpointed', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: computeCompactionSummaryHash(candidate) } }
    ])
    expect(applyCommittedSurfaceShadow([{ id: 'old-1' }, { id: 'tail' }], replay, [], 'w')).toEqual([{ id: 'checkpoint-1', role: 'user', content: 'summary' }, { id: 'tail' }])
  })

  it('applies consecutive compactions in order using the prior checkpoint surface', () => {
    const first = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary 1' }, shadowedRanges: [{ start: 'old-1', end: 'old-2' }] }
    const second = { checkpointMessage: { id: 'checkpoint-2', role: 'user', content: 'summary 2' }, shadowedRanges: [{ start: 'checkpoint-1', end: 'new-1' }] }
    const events = [
      { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'c1', windowId: 'w', inputSurfaceFingerprint: 'in-1' } },
      { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'c1', windowId: 'w', candidate: first, summaryHash: computeCompactionSummaryHash(first), outputSurfaceFingerprint: 'out-1', shadowedRanges: first.shadowedRanges } },
      { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'c1', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in-1', outputSurfaceFingerprint: 'out-1', summaryHash: computeCompactionSummaryHash(first) } },
      { seq: 4, type: 'compaction_start' as const, payload: { compactionId: 'c2', windowId: 'w', inputSurfaceFingerprint: 'in-2' } },
      { seq: 5, type: 'compaction_summary' as const, payload: { compactionId: 'c2', windowId: 'w', candidate: second, summaryHash: computeCompactionSummaryHash(second), outputSurfaceFingerprint: 'out-2', shadowedRanges: second.shadowedRanges } },
      { seq: 6, type: 'compaction_end' as const, payload: { compactionId: 'c2', windowId: 'w', status: 'committed', startSeq: 4, summarySeq: 5, inputSurfaceFingerprint: 'in-2', outputSurfaceFingerprint: 'out-2', summaryHash: computeCompactionSummaryHash(second) } }
    ]
    expect(applyCommittedSurfaceShadow([{ id: 'old-1' }, { id: 'old-2' }, { id: 'new-1' }, { id: 'tail' }], foldCompactionEvents(events), [], 'w')).toEqual([{ id: 'checkpoint-2', role: 'user', content: 'summary 2' }, { id: 'tail' }])
  })

  it('validates the historical boundary while allowing a later turn to append messages', () => {
    const candidate = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary' }, shadowedRanges: [{ start: 'old-1', end: 'old-2' }] }
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'old-1|old-2|tail', surfaceBoundaryId: 'tail' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', candidate, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: 'checkpoint-1|tail' , shadowedRanges: candidate.shadowedRanges } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'old-1|old-2|tail', outputSurfaceFingerprint: 'checkpoint-1|tail', summaryHash: computeCompactionSummaryHash(candidate) } }
    ])
    const fingerprint = (items: readonly { id: string }[]) => items.map((item) => item.id).join('|')
    expect(applyCommittedSurfaceShadow([
      { id: 'old-1', status: 'sent' }, { id: 'old-2', status: 'sent' }, { id: 'tail' }, { id: 'new-turn', status: 'pending' }
    ], replay, [], 'w', fingerprint)).toEqual([
      { id: 'checkpoint-1', role: 'user', content: 'summary' }, { id: 'tail' }, { id: 'new-turn', status: 'pending' }
    ])
  })

  it('keeps earlier valid compactions when a later record fails output validation', () => {
    const first = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary 1' }, shadowedRanges: [{ start: 'old-1', end: 'old-1' }] }
    const second = { checkpointMessage: { id: 'checkpoint-2', role: 'user', content: 'summary 2' }, shadowedRanges: [{ start: 'checkpoint-1', end: 'new-1' }] }
    const events = [
      { seq: 1, type: 'compaction_start' as const, payload: { compactionId: 'c1', windowId: 'w', inputSurfaceFingerprint: 'old-1|new-1', surfaceBoundaryId: 'new-1' } },
      { seq: 2, type: 'compaction_summary' as const, payload: { compactionId: 'c1', windowId: 'w', candidate: first, summaryHash: computeCompactionSummaryHash(first), outputSurfaceFingerprint: 'checkpoint-1|new-1', shadowedRanges: first.shadowedRanges } },
      { seq: 3, type: 'compaction_end' as const, payload: { compactionId: 'c1', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'old-1|new-1', outputSurfaceFingerprint: 'checkpoint-1|new-1', summaryHash: computeCompactionSummaryHash(first) } },
      { seq: 4, type: 'compaction_start' as const, payload: { compactionId: 'c2', windowId: 'w', inputSurfaceFingerprint: 'checkpoint-1|new-1', surfaceBoundaryId: 'new-1' } },
      { seq: 5, type: 'compaction_summary' as const, payload: { compactionId: 'c2', windowId: 'w', candidate: second, summaryHash: computeCompactionSummaryHash(second), outputSurfaceFingerprint: 'wrong', shadowedRanges: second.shadowedRanges } },
      { seq: 6, type: 'compaction_end' as const, payload: { compactionId: 'c2', windowId: 'w', status: 'committed', startSeq: 4, summarySeq: 5, inputSurfaceFingerprint: 'checkpoint-1|new-1', outputSurfaceFingerprint: 'wrong', summaryHash: computeCompactionSummaryHash(second) } }
    ]
    const fingerprint = (items: readonly { id: string }[]) => items.map((item) => item.id).join('|')
    expect(applyCommittedSurfaceShadow([{ id: 'old-1' }, { id: 'new-1' }], foldCompactionEvents(events), [], 'w', fingerprint)).toEqual([{ id: 'checkpoint-1', role: 'user', content: 'summary 1' }, { id: 'new-1' }])
  })

  it('locates a boundary by normalized content when a transient API id becomes a database id', () => {
    const candidate = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary' }, shadowedRanges: [{ start: surfaceItemIdentity({ role: 'user', content: 'user' }, 0), end: surfaceItemIdentity({ role: 'assistant', content: 'assistant' }, 1) }] }
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: 'user|assistant|tail', surfaceBoundaryId: 'temp-assistant' } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', candidate, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: 'summary|tail', shadowedRanges: candidate.shadowedRanges } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'user|assistant|tail', outputSurfaceFingerprint: 'summary|tail', summaryHash: computeCompactionSummaryHash(candidate) } }
    ])
    const fingerprint = (items: readonly { role?: string; content?: string }[]) => items.map((item) => item.content ?? item.role ?? '').join('|')
    expect(applyCommittedSurfaceShadow([
      { id: 'db-user', role: 'user', content: 'user' }, { id: 'db-assistant', role: 'assistant', content: 'assistant' }, { id: 'db-tail', role: 'user', content: 'tail' }, { id: 'new-turn', role: 'user', content: 'new' }
    ], replay, [], 'w', fingerprint)).toEqual([
      { id: 'checkpoint-1', role: 'user', content: 'summary' }, { id: 'db-tail', role: 'user', content: 'tail' }, { id: 'new-turn', role: 'user', content: 'new' }
    ])
  })

  it('replays a committed range after assistant blocks are persisted as text', () => {
    const assistantApi = { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
    const user = { role: 'user', content: 'question' }
    const candidate = { checkpointMessage: { id: 'checkpoint-1', role: 'user', content: 'summary' }, shadowedRanges: [{ start: surfaceItemIdentity(user, 0), end: surfaceItemIdentity(assistantApi, 1) }] }
    const inputFingerprint = computeReplaySurfaceFingerprint('system', [user, assistantApi])
    const outputFingerprint = computeReplaySurfaceFingerprint('system', [candidate.checkpointMessage])
    const replay = foldCompactionEvents([
      { seq: 1, type: 'compaction_start', payload: { compactionId: 'c', windowId: 'w', inputSurfaceFingerprint: inputFingerprint, surfaceBoundaryId: surfaceItemIdentity(assistantApi, 1) } },
      { seq: 2, type: 'compaction_summary', payload: { compactionId: 'c', windowId: 'w', candidate, summaryHash: computeCompactionSummaryHash(candidate), outputSurfaceFingerprint: outputFingerprint, shadowedRanges: candidate.shadowedRanges } },
      { seq: 3, type: 'compaction_end', payload: { compactionId: 'c', windowId: 'w', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: inputFingerprint, outputSurfaceFingerprint: outputFingerprint, summaryHash: computeCompactionSummaryHash(candidate) } }
    ])
    expect(applyCommittedSurfaceShadow([{ id: 'db-user', ...user }, { id: 'db-assistant', role: 'assistant', content: 'answer' }, { id: 'new', role: 'user', content: 'next' }], replay, [], 'w', (items) => computeReplaySurfaceFingerprint('system', items))).toEqual([{ id: 'checkpoint-1', role: 'user', content: 'summary' }, { id: 'new', role: 'user', content: 'next' }])
  })
})
