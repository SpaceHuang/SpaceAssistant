import { afterEach, describe, expect, it } from 'vitest'
import {
  getArtifactDecisionRequest,
  registerArtifactDecisionRequest,
  resetArtifactDecisionBridgeForTests,
  submitArtifactDecisionResponse,
  waitForArtifactDecisionResponse
} from '../artifacts/artifactDecisionBridge'
import { getSharedArtifactDecisionRegistry } from '../artifacts/artifactDecisionBridge'
import {
  parseArtifactDecisionRemoteReply,
  resolveRemoteArtifactDecisionChoice,
  serializeArtifactDecisionForRemote,
  buildArtifactDecisionOptions
} from './artifactDecisionRemote'

describe('artifact decision remote integration', () => {
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
  })

  function registerOverwriteRequest() {
    return registerArtifactDecisionRequest({
      requestId: 'req-remote',
      sessionId: 'sess-remote',
      toolUseId: 'tool-remote',
      attempt: 0,
      groupKey: 'overwrite:src/existing.ts',
      kind: 'overwrite',
      options: buildArtifactDecisionOptions('overwrite')
    })
  }

  it('shares the same registry between remote serialization and bridge response', async () => {
    const request = registerOverwriteRequest()
    expect(getSharedArtifactDecisionRegistry().get(request.decisionId)).toBeTruthy()
    expect(serializeArtifactDecisionForRemote(request)).toContain(request.decisionId)

    const waitPromise = waitForArtifactDecisionResponse('req-remote', 'tool-remote')
    const parsed = parseArtifactDecisionRemoteReply('1', request.decisionId)
    expect(parsed).toEqual({ kind: 'choice', decisionId: request.decisionId, choice: '1' })
    const choice = resolveRemoteArtifactDecisionChoice(request, parsed as Extract<typeof parsed, { kind: 'choice' }>)
    expect(choice).toBe('overwrite')

    submitArtifactDecisionResponse({
      decisionId: request.decisionId,
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      attempt: request.attempt,
      choice
    })
    await expect(waitPromise).resolves.toBe('overwrite')
    expect(getArtifactDecisionRequest(request.decisionId)).toBeUndefined()
  })

  it('maps remote rename and change-directory replies to bridge choices', async () => {
    const request = registerOverwriteRequest()
    const renameParsed = parseArtifactDecisionRemoteReply('2 review-v2.md', request.decisionId)
    expect(resolveRemoteArtifactDecisionChoice(request, renameParsed as Extract<typeof renameParsed, { kind: 'choice' }>)).toBe(
      'rename:review-v2.md'
    )

    const dirParsed = parseArtifactDecisionRemoteReply('3 reports/final/', request.decisionId)
    expect(resolveRemoteArtifactDecisionChoice(request, dirParsed as Extract<typeof dirParsed, { kind: 'choice' }>)).toBe(
      'change-directory:reports/final'
    )

    const cancelParsed = parseArtifactDecisionRemoteReply('4', request.decisionId)
    expect(resolveRemoteArtifactDecisionChoice(request, cancelParsed as Extract<typeof cancelParsed, { kind: 'choice' }>)).toBe(
      'cancel'
    )
  })
})
