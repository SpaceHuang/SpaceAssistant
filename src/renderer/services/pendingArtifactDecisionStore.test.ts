import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactDecisionRequest } from '../../shared/artifactDecisionTypes'
import { pendingArtifactDecisionStore } from './pendingArtifactDecisionStore'

describe('pendingArtifactDecisionStore', () => {
  const request: ArtifactDecisionRequest = {
    decisionId: 'dec-1',
    requestId: 'req-1',
    sessionId: 'sess-1',
    toolUseId: 'tool-1',
    attempt: 0,
    kind: 'overwrite',
    options: [{ key: 'overwrite', label: '覆盖' }, { key: 'cancel', label: '取消' }]
  }

  beforeEach(() => {
    pendingArtifactDecisionStore.reset()
    vi.restoreAllMocks()
  })

  it('forwards overwrite and cancel responses through artifactDecisionResponse', () => {
    const respond = vi.spyOn(window.api, 'artifactDecisionResponse').mockResolvedValue(undefined)
    pendingArtifactDecisionStore.respond(request, 'overwrite')
    expect(respond).toHaveBeenCalledWith({
      decisionId: 'dec-1',
      requestId: 'req-1',
      sessionId: 'sess-1',
      toolUseId: 'tool-1',
      attempt: 0,
      choice: 'overwrite'
    })

    pendingArtifactDecisionStore.respond(request, 'cancel')
    expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ choice: 'cancel' }))
  })
})
