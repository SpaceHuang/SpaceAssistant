import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_DECISION_REMOTE_USAGE_HINT,
  buildArtifactDecisionOptions,
  parseArtifactDecisionRemoteReply,
  resolveRemoteArtifactDecisionChoice,
  serializeArtifactDecisionForRemote
} from './artifactDecisionRemote'

describe('artifactDecisionRemote', () => {
  const request = {
    decisionId: 'dec-1',
    requestId: 'req-1',
    sessionId: 'sess-1',
    toolUseId: 'tool-1',
    attempt: 1,
    kind: 'overwrite' as const,
    title: '覆盖确认',
    options: [
      { key: 'overwrite', label: '覆盖' },
      { key: 'rename', label: '改名', requiresInput: 'rename' as const },
      { key: 'change-directory', label: '改目录', requiresInput: 'directory' as const },
      { key: 'cancel', label: '取消' }
    ]
  }

  it('serializes numbered options with decisionId', () => {
    const text = serializeArtifactDecisionForRemote(request)
    expect(text).toContain('dec-1')
    expect(text).toContain('1. 覆盖')
    expect(text).toContain('2 review-v2.md')
  })

  it('parses rename and change-directory replies', () => {
    expect(parseArtifactDecisionRemoteReply('2 review-v2.md', 'dec-1', request.options)).toEqual({
      kind: 'choice',
      decisionId: 'dec-1',
      choice: 'rename:review-v2.md'
    })
    expect(parseArtifactDecisionRemoteReply('3 reports/final/', 'dec-1', request.options)).toEqual({
      kind: 'choice',
      decisionId: 'dec-1',
      choice: 'change-directory:reports/final'
    })
  })

  it('encodes output-location directory replies as change-directory', () => {
    const locationRequest = {
      ...request,
      kind: 'output-location' as const,
      options: buildArtifactDecisionOptions('output-location')
    }
    expect(parseArtifactDecisionRemoteReply('1 reports/final', 'dec-loc', locationRequest.options)).toEqual({
      kind: 'choice',
      decisionId: 'dec-loc',
      choice: 'change-directory:reports/final'
    })
  })

  it('returns usage hint for invalid numbered replies', () => {
    expect(parseArtifactDecisionRemoteReply('9 missing', 'dec-1')).toEqual({ kind: 'usage_hint' })
    expect(ARTIFACT_DECISION_REMOTE_USAGE_HINT).toContain('review-v2.md')
  })

  it('maps numbered overwrite replies to option keys', () => {
    expect(resolveRemoteArtifactDecisionChoice(request, { kind: 'choice', decisionId: 'dec-1', choice: '1' })).toBe('overwrite')
    expect(resolveRemoteArtifactDecisionChoice(request, { kind: 'choice', decisionId: 'dec-1', choice: '4' })).toBe('cancel')
  })
})
