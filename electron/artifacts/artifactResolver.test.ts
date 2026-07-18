import { describe, expect, it } from 'vitest'
import { resolveArtifactOutput } from './artifactResolver'

describe('resolveArtifactOutput', () => {
  it.each(['user', 'project-convention'] as const)('keeps an explicit/project convention project path literal for %s', (pathSource) => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      intent: { container: 'project', role: 'primary', requestedPath: 'src/auth.ts', pathSource, ...(pathSource === 'user' ? { pathEvidenceId: 'request-1:0-11' } : {}) }
    })).toEqual(expect.objectContaining({
      finalPath: 'src/auth.ts',
      canonicalPath: '/workspace/src/auth.ts',
      provenance: pathSource === 'user' ? { pathSource, pathEvidenceId: 'request-1:0-11' } : { pathSource }
    }))
  })
})
