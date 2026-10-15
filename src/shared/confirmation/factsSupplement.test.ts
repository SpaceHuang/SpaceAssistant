import { describe, expect, it, vi } from 'vitest'
import { createInvocationFactsSnapshot } from './invocationFactsSnapshot'
import { verifyAndCreateFactsSupplement } from './factsSupplement'
import type { ContentFacts } from './types'

const facts: ContentFacts = {
  toolName: 'run_script', actionClass: 'execute', baseRiskLevel: 'medium',
  signals: [{ kind: 'script-analysis', signal: 'suspicious', patterns: ['network-egress'] }],
  summary: { text: 'run script' }
}
const envelope = { toolName: 'run_script', input: { code: 'fetch(url)' } }

describe('verified fact supplements', () => {
  it('treats model references only as leads and retains every prior risk signal', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-1', envelope, facts,
      extractorVersion: 'extractor-v1', completeness: 'partial', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const resolveEvidence = vi.fn(async (reference: string) => reference === 'script:ast'
      ? { signals: [{ kind: 'script-uncertified' }] as ContentFacts['signals'], completeness: 'complete' as const }
      : undefined)
    const next = await verifyAndCreateFactsSupplement({ prior, envelope, requestedReferences: ['script:ast'],
      round: 1, deadlineAt: 10_000, now: () => 1_000, resolveEvidence })
    expect(resolveEvidence).toHaveBeenCalledWith('script:ast')
    expect(next.factsRevision).toBe(2)
    expect(next.completeness).toBe('complete')
    expect(next.facts.signals).toContainEqual(facts.signals[0])
    expect(next.facts.signals).toContainEqual({ kind: 'script-uncertified' })
    expect(next.evidenceReferences).toEqual(['script:ast'])
  })

  it('does not trust a model-requested completeness upgrade', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-untrusted-completeness', envelope, facts,
      extractorVersion: 'extractor-v1', completeness: 'partial', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const next = await verifyAndCreateFactsSupplement({ prior, envelope, requestedReferences: ['script:ast'],
      round: 1, deadlineAt: 10_000, now: () => 1_000, resolveEvidence: () => ({ signals: [] }),
      completeness: 'complete' } as never)
    expect(next.completeness).toBe('partial')
  })

  it('rejects invalid completeness claims returned by the host resolver', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-invalid-host-completeness', envelope, facts,
      extractorVersion: 'extractor-v1', completeness: 'partial', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    await expect(verifyAndCreateFactsSupplement({ prior, envelope, requestedReferences: ['script:ast'],
      round: 1, deadlineAt: 10_000, now: () => 1_000,
      resolveEvidence: () => ({ signals: [], completeness: 'unknown' } as never) })).rejects.toThrow(/completeness/i)
  })

  it('rejects unverified references, excess rounds, expired deadlines, and changed envelopes', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-1', envelope, facts,
      extractorVersion: 'extractor-v1', completeness: 'partial', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const resolveEvidence = vi.fn(async () => undefined)
    const base = { prior, envelope, requestedReferences: ['forged'], round: 1, deadlineAt: 10_000,
      now: () => 1_000, resolveEvidence }
    await expect(verifyAndCreateFactsSupplement(base)).rejects.toThrow(/unverified/i)
    await expect(verifyAndCreateFactsSupplement({ ...base, requestedReferences: ['x'], round: 4 })).rejects.toThrow(/round/i)
    await expect(verifyAndCreateFactsSupplement({ ...base, requestedReferences: ['x'], now: () => 10_001 })).rejects.toThrow(/deadline/i)
    await expect(verifyAndCreateFactsSupplement({ ...base, resolveEvidence: () => ({ signals: [] }),
      envelope: { ...envelope, input: { code: 'safe' } } })).rejects.toThrow(/envelope/i)
  })

  it('stops if trusted evidence resolution consumes the remaining time budget', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-1', envelope, facts,
      extractorVersion: 'extractor-v1', completeness: 'partial', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    let clock = 1_000
    await expect(verifyAndCreateFactsSupplement({ prior, envelope, requestedReferences: ['script:ast'], round: 1,
      deadlineAt: 10_000, now: () => clock, resolveEvidence: async () => {
        clock = 10_000
        return { signals: [] }
      } })).rejects.toThrow(/deadline/i)
  })
})
