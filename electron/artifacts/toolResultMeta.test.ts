import { describe, expect, it } from 'vitest'
import { buildArtifactPathResolvedResult } from './toolResultMeta'

describe('buildArtifactPathResolvedResult', () => {
  it('emits tool:path-resolved for a system-assigned path with complete artifact metadata', () => {
    expect(buildArtifactPathResolvedResult({
      artifactId: 'artifact-1', container: 'scratch', role: 'scratch', pathKind: 'file',
      requestedPath: 'agent/scratch.sh', finalPath: '.spaceassistant/runs/s1/script/scratch.sh', provenance: { pathSource: 'system-assigned' }, reason: 'temporary verification'
    })).toEqual(expect.objectContaining({
      type: 'tool:path-resolved',
      path: '.spaceassistant/runs/s1/script/scratch.sh',
      metadata: expect.objectContaining({ artifactId: 'artifact-1', container: 'scratch', role: 'scratch', pathKind: 'file', reason: 'temporary verification' })
    }))
  })
})
