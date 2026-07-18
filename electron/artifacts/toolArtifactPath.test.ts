import { describe, expect, it } from 'vitest'
import { resolveToolArtifactPath } from './toolArtifactPath'

describe('resolveToolArtifactPath', () => {
  it('uses the resolved artifact finalPath for a declared write intent', () => {
    expect(resolveToolArtifactPath({
      workDir: '/workspace', sessionId: 's1', toolUseId: 't1', path: 'ignored.md',
      artifact: { container: 'scratch', role: 'scratch', title: 'verify.sh', materialKind: 'script', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ finalPath: '.spaceassistant/runs/s1/script/verify.sh' }))
  })
})
