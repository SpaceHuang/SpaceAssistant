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
    options: [
      { key: 'overwrite', label: '覆盖' },
      { key: 'cancel', label: '取消' }
    ]
  }

  beforeEach(() => {
    pendingArtifactDecisionStore.reset()
    vi.restoreAllMocks()
  })

  it('forwards overwrite and cancel responses through artifactDecisionResponse', async () => {
    const respond = vi.spyOn(window.api, 'artifactDecisionResponse').mockResolvedValue('resolved')
    pendingArtifactDecisionStore.upsertForTests(request)
    pendingArtifactDecisionStore.respond(request, 'overwrite')
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({
        decisionId: 'dec-1',
        requestId: 'req-1',
        sessionId: 'sess-1',
        toolUseId: 'tool-1',
        attempt: 0,
        choice: 'overwrite'
      })
    })
    await vi.waitFor(() => {
      expect(pendingArtifactDecisionStore.findForSession('sess-1')).toBeUndefined()
    })
  })

  it('marks the card stale without retry when IPC returns non-resolved', async () => {
    vi.spyOn(window.api, 'artifactDecisionResponse').mockResolvedValue('stale')
    pendingArtifactDecisionStore.upsertForTests(request)
    pendingArtifactDecisionStore.respond(request, 'overwrite')
    await vi.waitFor(() => {
      expect(pendingArtifactDecisionStore.findForSession('sess-1')?.uiStatus).toBe('stale')
    })
    // Still present — no automatic retry / removal on stale.
    expect(pendingArtifactDecisionStore.findForSession('sess-1')?.decisionId).toBe('dec-1')
  })

  it('marks the card stale when IPC rejects', async () => {
    vi.spyOn(window.api, 'artifactDecisionResponse').mockRejectedValue(new Error('boom'))
    pendingArtifactDecisionStore.upsertForTests(request)
    pendingArtifactDecisionStore.respond(request, 'overwrite')
    await vi.waitFor(() => {
      expect(pendingArtifactDecisionStore.findForSession('sess-1')?.uiStatus).toBe('stale')
    })
  })
})
