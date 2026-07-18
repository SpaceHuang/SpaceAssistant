import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ArtifactDecisionRequest } from '../../../shared/artifactDecisionTypes'
import { ArtifactDecisionCard } from './ArtifactDecisionCard'
import { pendingArtifactDecisionStore } from '../../services/pendingArtifactDecisionStore'

function Harness({ request }: { request: ArtifactDecisionRequest }) {
  return (
    <ArtifactDecisionCard
      request={request}
      onRespond={(choice) => pendingArtifactDecisionStore.respond(request, choice)}
      onCancel={() => pendingArtifactDecisionStore.cancel(request)}
    />
  )
}

describe('ArtifactDecisionFlow harness', () => {
  const request: ArtifactDecisionRequest = {
    decisionId: 'dec-flow',
    requestId: 'req-flow',
    sessionId: 'sess-flow',
    toolUseId: 'tool-flow',
    attempt: 1,
    kind: 'overwrite',
    options: [
      { key: 'overwrite', label: '覆盖' },
      { key: 'rename', label: '改名', requiresInput: 'rename' },
      { key: 'change-directory', label: '改目录', requiresInput: 'directory' },
      { key: 'cancel', label: '取消' }
    ]
  }

  beforeEach(() => {
    pendingArtifactDecisionStore.reset()
    vi.restoreAllMocks()
  })

  it('routes desktop card actions through the shared decision bridge API', () => {
    const respond = vi.spyOn(window.api, 'artifactDecisionResponse').mockResolvedValue(undefined)
    render(<Harness request={request} />)

    fireEvent.click(screen.getByRole('button', { name: '覆盖' }))
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ choice: 'overwrite', decisionId: 'dec-flow' }))

    fireEvent.click(document.querySelector('.artifact-decision-card__cancel')!)
    expect(respond).toHaveBeenLastCalledWith(expect.objectContaining({ choice: 'cancel' }))
  })
})
