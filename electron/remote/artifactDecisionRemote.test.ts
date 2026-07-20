import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_DECISION_REMOTE_USAGE_HINT,
  buildArtifactDecisionOptions,
  extractArtifactDecisionReplyPrefix,
  parseArtifactDecisionRemoteReply,
  parseArtifactDecisionReplyBody,
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

  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const upperUuid = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'

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
    expect(resolveRemoteArtifactDecisionChoice(request, { kind: 'choice', decisionId: 'dec-1', choice: '1' })).toBe(
      'overwrite'
    )
    expect(resolveRemoteArtifactDecisionChoice(request, { kind: 'choice', decisionId: 'dec-1', choice: '4' })).toBe(
      'cancel'
    )
  })

  describe('UUID prefix extraction', () => {
    it('extracts a lowercase UUID prefix and leaves the body without it', () => {
      expect(extractArtifactDecisionReplyPrefix(`${uuid} 1 reports/final`)).toEqual({
        replyDecisionId: uuid,
        body: '1 reports/final',
        hadUuidPrefix: true
      })
    })

    it('extracts an uppercase UUID prefix and normalizes to lowercase', () => {
      expect(extractArtifactDecisionReplyPrefix(`${upperUuid} 2 name.md`)).toEqual({
        replyDecisionId: uuid,
        body: '2 name.md',
        hadUuidPrefix: true
      })
    })

    it('does not treat an incomplete UUID-like token as a prefix', () => {
      expect(extractArtifactDecisionReplyPrefix('aaaaaaaa-bbbb-4ccc-8ddd 1')).toEqual({
        body: 'aaaaaaaa-bbbb-4ccc-8ddd 1',
        hadUuidPrefix: false
      })
    })

    it('returns hadUuidPrefix true for an unknown but well-formed UUID without state lookup', () => {
      const unknown = '11111111-2222-4333-8444-555555555555'
      expect(extractArtifactDecisionReplyPrefix(`${unknown} 1`)).toEqual({
        replyDecisionId: unknown,
        body: '1',
        hadUuidPrefix: true
      })
    })
  })

  describe('strict body parsing', () => {
    it('returns not_decision when there is no UUID prefix and the first token is not a positive integer', () => {
      expect(parseArtifactDecisionReplyBody('yes please', request.options, false)).toEqual({ kind: 'not_decision' })
      expect(parseArtifactDecisionReplyBody('Y abc', request.options, false)).toEqual({ kind: 'not_decision' })
    })

    it('returns usage_hint when a UUID prefix is present but the body lacks a valid number', () => {
      expect(parseArtifactDecisionReplyBody('', request.options, true)).toEqual({ kind: 'usage_hint' })
      expect(parseArtifactDecisionReplyBody('rename-only', request.options, true)).toEqual({ kind: 'usage_hint' })
    })

    it('returns usage_hint when the option index is out of range', () => {
      expect(parseArtifactDecisionReplyBody('9', request.options, false)).toEqual({ kind: 'usage_hint' })
    })

    it('returns usage_hint when a requiresInput option is missing its value', () => {
      expect(parseArtifactDecisionReplyBody('2', request.options, false)).toEqual({ kind: 'usage_hint' })
      expect(parseArtifactDecisionReplyBody('3', request.options, false)).toEqual({ kind: 'usage_hint' })
    })

    it('returns usage_hint when a non-input option carries trailing text', () => {
      expect(parseArtifactDecisionReplyBody('1 extra', request.options, false)).toEqual({ kind: 'usage_hint' })
      expect(parseArtifactDecisionReplyBody('4 nope', request.options, false)).toEqual({ kind: 'usage_hint' })
    })

    it('encodes rename options as rename:<value>', () => {
      expect(parseArtifactDecisionReplyBody('2 review-v2.md', request.options, false)).toEqual({
        kind: 'choice',
        choice: 'rename:review-v2.md'
      })
    })

    it('normalizes directory backslashes and trailing slashes into change-directory:<value>', () => {
      expect(parseArtifactDecisionReplyBody('3 reports\\final\\', request.options, false)).toEqual({
        kind: 'choice',
        choice: 'change-directory:reports/final'
      })
    })

    it('rejects UUID pollution in input values for both prefix-mid and hash-suffix forms', () => {
      expect(parseArtifactDecisionReplyBody(`1 ${uuid} path`, request.options, false)).toEqual({
        kind: 'usage_hint'
      })
      expect(parseArtifactDecisionReplyBody(`1 path #${uuid}`, request.options, false)).toEqual({
        kind: 'usage_hint'
      })
      const locationOptions = buildArtifactDecisionOptions('output-location')
      expect(parseArtifactDecisionReplyBody(`1 ${uuid} reports/final`, locationOptions, false)).toEqual({
        kind: 'usage_hint'
      })
      expect(parseArtifactDecisionReplyBody(`1 reports/final #${uuid}`, locationOptions, false)).toEqual({
        kind: 'usage_hint'
      })
    })
  })

  describe('compatibility parseArtifactDecisionRemoteReply', () => {
    it('parses UUID-prefixed replies by composing prefix extraction and body parsing', () => {
      expect(parseArtifactDecisionRemoteReply(`${uuid} 3 reports/final`, 'ignored', request.options)).toEqual({
        kind: 'choice',
        decisionId: uuid,
        choice: 'change-directory:reports/final'
      })
    })
  })

  describe('serializer', () => {
    it('includes the real decisionId, title, and all numbered options', () => {
      const realId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
      const text = serializeArtifactDecisionForRemote({ ...request, decisionId: realId })
      expect(text).toContain(realId)
      expect(text).toContain('覆盖确认')
      expect(text).toContain('1. 覆盖')
      expect(text).toContain('2. 改名')
      expect(text).toContain('3. 改目录')
      expect(text).toContain('4. 取消')
    })

    it('includes copyable single-candidate and multi-candidate UUID examples', () => {
      const text = serializeArtifactDecisionForRemote(request)
      expect(text).toMatch(/1\b/)
      expect(text).toContain(`dec-1 1`)
    })

    it('uses the actual requiresInput option number in valued examples instead of a fixed index', () => {
      const location = {
        ...request,
        decisionId: 'cccccccc-dddd-4eee-8fff-000000000000',
        kind: 'output-location' as const,
        options: buildArtifactDecisionOptions('output-location')
      }
      const text = serializeArtifactDecisionForRemote(location)
      expect(text).toContain('1 reports/final')
      expect(text).toContain(`${location.decisionId} 1 reports/final`)
      expect(text).not.toContain('2 review-v2.md')
    })

    it('omits misleading valued examples when no option requires input', () => {
      const ownership = {
        ...request,
        kind: 'ownership' as const,
        options: buildArtifactDecisionOptions('ownership')
      }
      const text = serializeArtifactDecisionForRemote(ownership)
      expect(text).not.toMatch(/\d+\s+\S+\.(md|ts)/)
      expect(text).not.toMatch(/\d+\s+reports\//)
    })
  })
})
