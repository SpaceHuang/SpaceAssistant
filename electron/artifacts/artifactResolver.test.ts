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

  it('ignores an agent-suggested scratch directory and assigns a safe run path', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      sessionId: 'session-1',
      intent: { container: 'scratch', role: 'scratch', requestedPath: '../outside/verify.sh', title: 'verify.sh', materialKind: 'script', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({
      finalPath: '.spaceassistant/runs/session-1/script/verify.sh',
      provenance: { pathSource: 'system-assigned' }
    }))
  })

  it('suffixes a new colliding scratch file with toolUseId but preserves an existing artifact path', () => {
    const common = { workDir: '/workspace', sessionId: 'session-1', intent: { container: 'scratch' as const, role: 'scratch' as const, title: 'verify.sh', materialKind: 'script' as const, pathSource: 'agent-default' as const } }
    expect(resolveArtifactOutput({ ...common, toolUseId: 'tool-123456' , occupiedPaths: ['.spaceassistant/runs/session-1/script/verify.sh'] })).toEqual(
      expect.objectContaining({ finalPath: '.spaceassistant/runs/session-1/script/verify-tool-1234.sh' })
    )
    expect(resolveArtifactOutput({ ...common, existingArtifact: { artifactId: 'artifact-1', canonicalPath: '/workspace/.spaceassistant/runs/session-1/script/verify.sh' }, intent: { ...common.intent, artifactId: 'artifact-1' } })).toEqual(
      expect.objectContaining({ finalPath: '.spaceassistant/runs/session-1/script/verify.sh' })
    )
  })

  it('requires an overwrite decision before replacing an unrelated artifact', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace',
      occupiedPaths: ['reports/final.md'],
      intent: { container: 'project', role: 'primary', requestedPath: 'reports/final.md', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ decision: { kind: 'overwrite' } }))
  })

  it('does not let a write with artifactId silently move to a requested path when the artifact is absent', () => {
    expect(() => resolveArtifactOutput({
      workDir: '/workspace',
      intent: { container: 'project', role: 'primary', artifactId: 'missing-artifact', requestedPath: 'moved.ts', pathSource: 'agent-default' }
    })).toThrow(/canonical/i)
  })

  it('creates a role subdirectory for package materials only when a sibling-name collision exists', () => {
    const common = {
      workDir: '/workspace', packagePrimaryPath: 'reports/final.md',
      intent: { container: 'package' as const, role: 'reference' as const, packageId: 'package-1', materialKind: 'note' as const, title: 'source', pathSource: 'agent-default' as const }
    }
    expect(resolveArtifactOutput(common)).toEqual(expect.objectContaining({ finalPath: 'reports/final.materials/source.md' }))
    expect(resolveArtifactOutput({ ...common, occupiedPaths: ['reports/final.materials/source.md'] })).toEqual(
      expect.objectContaining({ finalPath: 'reports/final.materials/references/source.md' })
    )
  })

  it('derives a package reference without an explicit path into the materials directory', () => {
    expect(resolveArtifactOutput({
      workDir: '/workspace', packagePrimaryPath: 'reports/final.md',
      intent: { container: 'package', role: 'reference', packageId: 'package-1', title: 'source', materialKind: 'note', pathSource: 'agent-default' }
    })).toEqual(expect.objectContaining({ finalPath: 'reports/final.materials/source.md' }))
  })

  it('re-resolves rename and change-directory decisions with user-decision provenance and incremented attempt', async () => {
    const { resolveArtifactOutputAfterDecision } = await import('./artifactDecisionReresolve')
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-reresolve-'))
    try {
      await fs.mkdir(path.join(root, 'reports'), { recursive: true })
      await fs.mkdir(path.join(root, 'drafts'), { recursive: true })
      const renamed = await resolveArtifactOutputAfterDecision({
        workDir: root,
        attempt: 0,
        decisionId: 'decision-1',
        previousFinalPath: 'reports/final.md',
        occupiedPaths: ['reports/final.md', 'reports/review-v2.md'],
        intent: { container: 'project', role: 'primary', requestedPath: 'reports/final.md', pathSource: 'agent-default' },
        response: { action: 'rename', newName: 'review-v2.md' }
      })
      expect(renamed).toEqual(expect.objectContaining({
        attempt: 1,
        finalPath: 'reports/review-v2.md',
        provenance: { pathSource: 'user-decision', pathDecisionId: 'decision-1' },
        decision: { kind: 'overwrite' }
      }))

      const relocated = await resolveArtifactOutputAfterDecision({
        workDir: root,
        attempt: 1,
        decisionId: 'decision-2',
        previousFinalPath: 'reports/review-v2.md',
        occupiedPaths: ['reports/final.md', 'reports/review-v2.md'],
        intent: { container: 'project', role: 'primary', requestedPath: 'reports/review-v2.md', pathSource: 'agent-default' },
        response: { action: 'change-directory', newDirectory: 'drafts' }
      })
      expect(relocated).toEqual(expect.objectContaining({
        attempt: 2,
        finalPath: 'drafts/review-v2.md',
        provenance: { pathSource: 'user-decision', pathDecisionId: 'decision-2' }
      }))
      expect(relocated.decision).toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects unsafe rename/change-directory targets without rewriting them into the workspace', async () => {
    const { resolveArtifactOutputAfterDecision } = await import('./artifactDecisionReresolve')
    await expect(resolveArtifactOutputAfterDecision({
      workDir: '/tmp',
      attempt: 0,
      decisionId: 'decision-bad',
      previousFinalPath: 'reports/final.md',
      intent: { container: 'project', role: 'primary', requestedPath: 'reports/final.md', pathSource: 'agent-default' },
      response: { action: 'change-directory', newDirectory: '../outside' }
    })).rejects.toThrow(/directory|artifact path/i)
  })
})
