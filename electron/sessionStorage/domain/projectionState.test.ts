import { describe, expect, it } from 'vitest'
import { transitionProjectionState, type ProjectionStateRecord } from './projectionState'

const invalid: ProjectionStateRecord = {
  sessionId: 'session-a', scopeKey: 'scope-a', sessionGeneration: 'generation-1', status: 'invalid',
  historyWatermarkJson: null, messageRevision: null, payloadGeneration: null, payloadDigest: null,
  validatedRangeJson: null, sourceIdentityJson: null, processGeneration: null, rebuildToken: null,
  failureCaseJson: null, attempts: 0, retryAfter: null, updatedAt: 1,
}

describe('projection state transition protocol', () => {
  it('claims invalid work with a process-fenced token and publishes only matching source proof', () => {
    const rebuilding = transitionProjectionState(invalid, {
      type: 'claim', processGeneration: 4, rebuildToken: 'token-a', now: 2,
    }, '{"generation":"generation-1"}')
    expect(rebuilding).toMatchObject({ status: 'rebuilding', processGeneration: 4, rebuildToken: 'token-a' })

    expect(transitionProjectionState(rebuilding!, {
      type: 'publish', processGeneration: 4, rebuildToken: 'token-a',
      expectedSourceIdentityJson: '{"generation":"generation-1"}',
      historyWatermarkJson: '{"sessionSeq":3}', messageRevision: 7, payloadGeneration: 'payload-a',
      payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":3}', now: 3,
    }, '{"generation":"generation-2"}')).toMatchObject({ status: 'invalid', rebuildToken: null, payloadGeneration: null })

    expect(transitionProjectionState(rebuilding!, {
      type: 'publish', processGeneration: 4, rebuildToken: 'token-a',
      expectedSourceIdentityJson: '{"generation":"generation-1"}',
      historyWatermarkJson: '{"sessionSeq":3}', messageRevision: 7, payloadGeneration: 'payload-a',
      payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":3}', now: 4,
    }, '{"generation":"generation-1"}')).toMatchObject({ status: 'valid', payloadGeneration: 'payload-a', payloadDigest: 'digest-a', rebuildToken: null })
  })

  it('rejects stale callbacks and allows only due rejected work or a fenced process takeover', () => {
    const rebuilding = transitionProjectionState(invalid, {
      type: 'claim', processGeneration: 4, rebuildToken: 'token-a', now: 2,
    }, 'source-a')!
    expect(transitionProjectionState(rebuilding, {
      type: 'reject', processGeneration: 4, rebuildToken: 'stale-token', failureCaseJson: '{"case":"mismatch"}', attempts: 1, retryAfter: 10, now: 3,
    })).toBeNull()
    const rejected = transitionProjectionState(rebuilding, {
      type: 'reject', processGeneration: 4, rebuildToken: 'token-a', failureCaseJson: '{"case":"mismatch"}', attempts: 1, retryAfter: 10, now: 3,
    })!
    expect(transitionProjectionState(rejected, {
      type: 'claim', processGeneration: 4, rebuildToken: 'token-b', now: 9,
    }, 'source-a')).toBeNull()
    expect(transitionProjectionState(rejected, {
      type: 'claim', processGeneration: 4, rebuildToken: 'token-b', now: 10,
    }, 'source-a')).toMatchObject({ status: 'rebuilding', rebuildToken: 'token-b' })

    expect(transitionProjectionState(rebuilding, {
      type: 'claim', processGeneration: 5, rebuildToken: 'token-c', now: 11,
    }, 'source-a')).toMatchObject({ status: 'rebuilding', processGeneration: 5, rebuildToken: 'token-c' })
  })

  it('source invalidation revokes proof and token without changing another scope', () => {
    const valid: ProjectionStateRecord = {
      ...invalid, status: 'valid', historyWatermarkJson: '{"sessionSeq":3}', messageRevision: 7,
      payloadGeneration: 'payload-a', payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":3}', sourceIdentityJson: 'source-a', updatedAt: 4,
    }
    expect(transitionProjectionState(valid, { type: 'invalidate', sessionGeneration: 'generation-1', now: 5 }))
      .toMatchObject({ status: 'invalid', payloadGeneration: null, payloadDigest: null, historyWatermarkJson: null, rebuildToken: null })
    expect(transitionProjectionState(valid, { type: 'invalidate', sessionGeneration: 'other-generation', now: 5 })).toBeNull()
  })
})
