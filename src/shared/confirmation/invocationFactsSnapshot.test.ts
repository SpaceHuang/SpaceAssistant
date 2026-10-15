import { describe, expect, it } from 'vitest'
import { createInvocationFactsSnapshot, sameInvocationFactsSnapshot, serializeInvocationFactsSnapshot } from './invocationFactsSnapshot'
import type { ContentFacts } from './types'

const facts: ContentFacts = {
  toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'low', signals: [],
  summary: { text: 'create report.txt' }, factsProviderDeclared: true
}

describe('invocation facts snapshot', () => {
  it('binds invocation, envelope, facts, extractor, completeness, evidence, environment, and monotonic revision', async () => {
    const snapshot = await createInvocationFactsSnapshot({
      invocationId: 'inv-1', envelope: { toolName: 'write_file', input: { path: 'report.txt' } },
      facts, extractorVersion: 'extractor-v1', completeness: 'complete',
      evidenceReferences: ['workspace:report.txt'], environmentVersion: 'env-4', previousFactsRevision: 6
    })
    expect(snapshot).toMatchObject({ invocationId: 'inv-1', extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: ['workspace:report.txt'], environmentVersion: 'env-4', factsRevision: 7 })
    expect(snapshot.envelopeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.factsHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.facts.signals)).toBe(true)
  })

  it('rejects malformed binding data and non-monotonic revisions', async () => {
    await expect(createInvocationFactsSnapshot({
      invocationId: '', envelope: {}, facts, extractorVersion: 'extractor-v1', completeness: 'complete',
      evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0
    })).rejects.toThrow(/invocation/i)
    await expect(createInvocationFactsSnapshot({
      invocationId: 'inv-1', envelope: {}, facts, extractorVersion: 'extractor-v1', completeness: 'complete',
      evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: -1
    })).rejects.toThrow(/revision/i)
    await expect(createInvocationFactsSnapshot({
      invocationId: 'inv-1', envelope: {}, facts, extractorVersion: 'extractor-v1', completeness: 'unknown' as never,
      evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: Number.MAX_SAFE_INTEGER
    })).rejects.toThrow(/completeness/i)
  })

  it('keeps detached trusted facts immutable when inputs or model-facing copies change', async () => {
    const inputFacts = structuredClone(facts)
    const snapshot = await createInvocationFactsSnapshot({
      invocationId: 'inv-model-boundary', envelope: { toolName: 'write_file' }, facts: inputFacts,
      extractorVersion: 'extractor-v1', completeness: 'complete', evidenceReferences: [],
      environmentVersion: 'env-1', previousFactsRevision: 0
    })

    inputFacts.summary.text = 'changed outside the snapshot'
    expect(snapshot.facts.summary.text).toBe('create report.txt')
    expect(Object.isFrozen(snapshot.facts.summary)).toBe(true)
    expect(() => { snapshot.facts.summary.text = 'changed inside the snapshot' }).toThrow()

    const modelFacingCopy = JSON.parse(serializeInvocationFactsSnapshot(snapshot)) as {
      facts: { summary: { text: string } }
    }
    modelFacingCopy.facts.summary.text = 'changed in a serialized copy'
    expect(snapshot.facts.summary.text).toBe('create report.txt')
    expect(serializeInvocationFactsSnapshot(snapshot)).toBe(serializeInvocationFactsSnapshot(snapshot))
  })

  it('compares exact bound facts rather than mutable object identity', async () => {
    const input = { invocationId: 'inv-1', envelope: { toolName: 'write_file' }, facts,
      extractorVersion: 'extractor-v1', completeness: 'complete' as const,
      evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 }
    const one = await createInvocationFactsSnapshot(input)
    const same = await createInvocationFactsSnapshot(input)
    const changed = await createInvocationFactsSnapshot({ ...input, environmentVersion: 'env-2' })
    expect(sameInvocationFactsSnapshot(one, same)).toBe(true)
    expect(sameInvocationFactsSnapshot(one, changed)).toBe(false)
  })

  it.each([
    ['target', { toolName: 'write_file', input: { path: 'other.txt' } }, 'env-1'],
    ['script or parameters', { toolName: 'run_script', input: { code: 'different()' } }, 'env-1'],
    ['attachment', { toolName: 'wechat_send_media', input: { attachmentId: 'different' } }, 'env-1'],
    ['permissions or work directory', { toolName: 'write_file', input: { path: 'report.txt' } }, 'env-2']
  ] as const)('invalidates a snapshot when %s changes', async (_name, changedEnvelope, environmentVersion) => {
    const base = { invocationId: 'inv-2', facts, extractorVersion: 'extractor-v1', completeness: 'complete' as const,
      evidenceReferences: ['evidence-1'], previousFactsRevision: 0 }
    const original = await createInvocationFactsSnapshot({ ...base,
      envelope: { toolName: 'write_file', input: { path: 'report.txt', content: 'hello' } }, environmentVersion: 'env-1' })
    const changed = await createInvocationFactsSnapshot({ ...base, envelope: changedEnvelope, environmentVersion })
    expect(changed.factsRevision).toBe(original.factsRevision)
    expect(sameInvocationFactsSnapshot(original, changed)).toBe(false)
  })
})
