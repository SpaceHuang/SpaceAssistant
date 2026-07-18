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

  it('uses the canonical path of an existing project artifact when an artifactId is supplied', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      existingArtifact: { artifactId: 'artifact-1', canonicalPath: '/workspace/src/auth.ts' },
      intent: { container: 'project', role: 'primary', artifactId: 'artifact-1', requestedPath: 'other.ts', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ finalPath: 'src/auth.ts', canonicalPath: '/workspace/src/auth.ts' }))
  })

  it('uses an explicit package primary file path literally', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      intent: { container: 'package', role: 'primary', packageId: 'package-1', requestedPath: 'reports/final.md', pathSource: 'user', pathEvidenceId: 'request-1:0-16' }
    })).toEqual(expect.objectContaining({ finalPath: 'reports/final.md', canonicalPath: '/workspace/reports/final.md' }))
  })

  it('appends the primary artifact display filename to an explicit package directory', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      intent: { container: 'package', role: 'primary', packageId: 'package-1', requestedPath: 'reports/', pathKind: 'directory', title: 'Final Summary', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ finalPath: 'reports/final-summary.md', canonicalPath: '/workspace/reports/final-summary.md' }))
  })

  it('requests an output-location decision instead of creating a temporary package primary file', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      intent: { container: 'package', role: 'primary', packageId: 'package-1', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ decision: { kind: 'output-location', packageId: 'package-1' } }))
  })

  it('derives an unqualified supporting material beside its package primary artifact', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      packagePrimaryPath: 'reports/final.md',
      intent: { container: 'package', role: 'supporting', packageId: 'package-1', materialKind: 'script', title: 'query', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ finalPath: 'reports/final.materials/query.ts' }))
  })

  it('returns an ownership decision rather than creating an anonymous package for unqualified supporting content', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      intent: { container: 'package', role: 'supporting', title: 'query', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ decision: { kind: 'ownership' } }))
  })
})
