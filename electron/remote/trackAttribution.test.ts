import { describe, expect, it, vi } from 'vitest'
import { attributeRemoteMessage, type IntentAttributor, type TrackCandidateSummary } from './trackAttribution'

const candidates: TrackCandidateSummary[] = [
  { trackId: 'active-1', state: 'processing', summary: '查找知乎资料', updatedAt: 100 },
  { trackId: 'active-2', state: 'waiting-user', summary: '准备本地部署', updatedAt: 90 }
]

function scores(values: Array<{ trackId: string; score: number }>): IntentAttributor {
  return { classify: vi.fn(async () => ({ kind: 'scores', scores: values })) }
}

describe('remote IM intent attribution', () => {
  it('creates a new Track when there are no eligible candidates without calling the classifier', async () => {
    const classifier = scores([])
    await expect(attributeRemoteMessage({ text: '新的问题', candidates: [], classifier })).resolves.toEqual({
      kind: 'new-track', reasonCode: 'no-eligible-candidates'
    })
    expect(classifier.classify).not.toHaveBeenCalled()
  })

  it('uses a unique high confidence candidate and marks completed candidates as successors', async () => {
    const classifier = scores([{ trackId: 'active-1', score: 0.9 }, { trackId: 'active-2', score: 0.2 }])
    await expect(attributeRemoteMessage({ text: '继续查知乎', candidates, classifier })).resolves.toEqual({
      kind: 'continuation', trackId: 'active-1', confidence: 0.9, evidenceCodes: ['semantic-unique-above-threshold']
    })
    const completedClassifier = scores([{ trackId: 'done', score: 0.9 }])
    await expect(attributeRemoteMessage({
      text: '补充一下', candidates: [{ trackId: 'done', state: 'completed', summary: '查询本地部署模型', updatedAt: 100 }],
      classifier: completedClassifier
    })).resolves.toEqual({ kind: 'successor', parentTrackId: 'done', confidence: 0.9, evidenceCodes: ['semantic-unique-above-threshold'] })
  })

  it('does not silently choose close candidates and treats below-threshold scores as a new intent', async () => {
    await expect(attributeRemoteMessage({
      text: '再查一下', candidates, classifier: scores([{ trackId: 'active-1', score: 0.9 }, { trackId: 'active-2', score: 0.8 }])
    })).resolves.toMatchObject({ kind: 'ambiguous', reasonCode: 'confidence-margin-too-small' })
    await expect(attributeRemoteMessage({
      text: '再查一下', candidates, classifier: scores([{ trackId: 'active-1', score: 0.84 }, { trackId: 'active-2', score: 0.1 }])
    })).resolves.toMatchObject({ kind: 'new-track', reasonCode: 'no-reasonable-continuation-candidate' })
  })

  it('starts a new Track when every existing candidate is below the continuation threshold', async () => {
    await expect(attributeRemoteMessage({
      text: '这是另一个完全不同的请求', candidates,
      classifier: scores([{ trackId: 'active-1', score: 0.2 }, { trackId: 'active-2', score: 0.1 }])
    })).resolves.toEqual({ kind: 'new-track', reasonCode: 'no-reasonable-continuation-candidate' })
  })

  it('applies the frozen thresholds inclusively and refuses to truncate more than five candidates', async () => {
    await expect(attributeRemoteMessage({
      text: '继续', candidates, classifier: scores([{ trackId: 'active-1', score: 0.85 }, { trackId: 'active-2', score: 0.7 }])
    })).resolves.toMatchObject({ kind: 'continuation', trackId: 'active-1' })
    const classifier = scores([])
    const six = Array.from({ length: 6 }, (_, index) => ({ ...candidates[0], trackId: `track-${index}` }))
    await expect(attributeRemoteMessage({ text: '继续', candidates: six, classifier }))
      .resolves.toMatchObject({ kind: 'ambiguous', reasonCode: 'too-many-candidates', candidateTrackIds: six.map(({ trackId }) => trackId) })
    expect(classifier.classify).not.toHaveBeenCalled()
  })

  it('times out a stalled classifier and falls back to ambiguity', async () => {
    vi.useFakeTimers()
    try {
      let classifierSignal: AbortSignal | undefined
      const classifier: IntentAttributor = { classify: vi.fn((input) => {
        classifierSignal = (input as typeof input & { signal?: AbortSignal }).signal
        return new Promise(() => undefined)
      }) }
      const result = attributeRemoteMessage({ text: '继续', candidates, classifier, classifierDeadlineMs: 20 })
      await vi.advanceTimersByTimeAsync(20)
      await expect(result).resolves.toMatchObject({ kind: 'ambiguous', reasonCode: 'classifier-timeout' })
      expect(classifierSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed classifier output, external IDs, duplicate IDs, and non-finite scores into ambiguity', async () => {
    for (const result of [
      { kind: 'continuation', trackId: 'active-1' },
      { kind: 'scores', scores: [{ trackId: 'other', score: 1 }] },
      { kind: 'scores', scores: [{ trackId: 'active-1', score: 0.9 }, { trackId: 'active-1', score: 0.8 }] },
      { kind: 'scores', scores: [{ trackId: 'active-1', score: Number.NaN }, { trackId: 'active-2', score: 0 }] }
    ]) {
      const classifier: IntentAttributor = { classify: async () => result as never }
      await expect(attributeRemoteMessage({ text: '继续', candidates, classifier })).resolves.toMatchObject({ kind: 'ambiguous' })
    }
  })

  it('never invokes semantic classification for confirmation or clarification protocol input', async () => {
    const classifier = scores([{ trackId: 'active-1', score: 1 }, { trackId: 'active-2', score: 0 }])
    await expect(attributeRemoteMessage({ text: '允许', messageKind: 'confirmation', candidates, classifier }))
      .resolves.toEqual({ kind: 'reserved-protocol', protocol: 'confirmation' })
    await expect(attributeRemoteMessage({ text: '选择 ABCD-...', messageKind: 'clarification', candidates, classifier }))
      .resolves.toEqual({ kind: 'reserved-protocol', protocol: 'clarification' })
    expect(classifier.classify).not.toHaveBeenCalled()
  })

  it('does not fall back to semantic matching when an explicit reference is stale or unresolved', async () => {
    const classifier = scores([{ trackId: 'active-1', score: 1 }, { trackId: 'active-2', score: 0 }])
    await expect(attributeRemoteMessage({
      text: '继续', candidates, classifier, explicitReference: { trackId: 'gone', state: 'unavailable' }
    })).resolves.toEqual({ kind: 'rejected', reasonCode: 'explicit-reference-unavailable' })
    expect(classifier.classify).not.toHaveBeenCalled()
  })
})
