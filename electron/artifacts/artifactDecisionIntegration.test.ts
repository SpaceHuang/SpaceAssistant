import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getArtifactDecisionRequest,
  resetArtifactDecisionBridgeForTests,
  submitArtifactDecisionResponse
} from './artifactDecisionBridge'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import {
  prepareArtifactToolWrite,
  resolveArtifactToolWriteWithDecision,
  resumeArtifactToolWriteAfterDecision
} from './toolLoopArtifactFlow'

describe('artifact decision integration (desktop bridge)', () => {
  const fixtures: ArtifactTestFixture[] = []

  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    fixtures.splice(0).forEach((fixture) => fixture.teardown())
  })

  function overwriteFixture() {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const target = path.join(fixture.workDir, 'src/existing.ts')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'old')
    const conflict = path.join(fixture.workDir, 'src/review-v2.ts')
    fs.writeFileSync(conflict, 'other')
    const artifact = {
      container: 'project' as const,
      role: 'primary' as const,
      title: 'existing',
      requestedPath: 'src/existing.ts',
      pathSource: 'agent-default' as const
    }
    return { fixture, artifact, occupiedPaths: ['src/existing.ts', 'src/review-v2.ts'] }
  }

  it('cancels through the shared registry waiter', async () => {
    const { fixture, artifact, occupiedPaths } = overwriteFixture()
    const resolved = await resolveArtifactToolWriteWithDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-cancel',
      toolUseId: 'tool-cancel',
      path: 'src/existing.ts',
      artifact,
      occupiedPaths,
      onDecisionRequired: (pending) => {
        submitArtifactDecisionResponse({
          decisionId: pending.decisionId,
          requestId: 'req-cancel',
          sessionId: fixture.session.id,
          toolUseId: 'tool-cancel',
          attempt: pending.attempt,
          choice: 'cancel'
        })
      }
    })
    expect(resolved).toEqual({ kind: 'error', message: 'Artifact decision cancelled' })
  })

  it('resumes overwrite, rename, and change-directory through the same registry', async () => {
    const { fixture, artifact, occupiedPaths } = overwriteFixture()

    const overwriteReady = await resolveArtifactToolWriteWithDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-overwrite',
      toolUseId: 'tool-overwrite',
      path: 'src/existing.ts',
      artifact,
      occupiedPaths,
      onDecisionRequired: (pending) => {
        submitArtifactDecisionResponse({
          decisionId: pending.decisionId,
          requestId: 'req-overwrite',
          sessionId: fixture.session.id,
          toolUseId: 'tool-overwrite',
          attempt: pending.attempt,
          choice: 'overwrite'
        })
      }
    })
    expect(overwriteReady.kind).toBe('ready')
    if (overwriteReady.kind !== 'ready') return
    expect(overwriteReady.prepared.finalPath).toBe('src/existing.ts')

    const renameReady = await resolveArtifactToolWriteWithDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-rename',
      toolUseId: 'tool-rename',
      path: 'src/existing.ts',
      artifact,
      occupiedPaths: ['src/existing.ts'],
      onDecisionRequired: (pending) => {
        submitArtifactDecisionResponse({
          decisionId: pending.decisionId,
          requestId: 'req-rename',
          sessionId: fixture.session.id,
          toolUseId: 'tool-rename',
          attempt: pending.attempt,
          choice: 'rename:renamed.ts'
        })
      }
    })
    expect(renameReady.kind).toBe('ready')
    if (renameReady.kind !== 'ready') return
    expect(renameReady.prepared.finalPath).toBe('src/renamed.ts')

    const directoryReady = await resolveArtifactToolWriteWithDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-dir',
      toolUseId: 'tool-dir',
      path: 'src/existing.ts',
      artifact,
      occupiedPaths: ['src/existing.ts'],
      onDecisionRequired: (pending) => {
        submitArtifactDecisionResponse({
          decisionId: pending.decisionId,
          requestId: 'req-dir',
          sessionId: fixture.session.id,
          toolUseId: 'tool-dir',
          attempt: pending.attempt,
          choice: 'change-directory:drafts'
        })
      }
    })
    expect(directoryReady.kind).toBe('ready')
    if (directoryReady.kind !== 'ready') return
    expect(directoryReady.prepared.finalPath).toBe('drafts/existing.ts')
  })

  it('issues a new decisionId when a rename target still conflicts', async () => {
    const { fixture, artifact, occupiedPaths } = overwriteFixture()
    const initial = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-conflict',
      toolUseId: 'tool-conflict',
      path: 'src/existing.ts',
      artifact,
      occupiedPaths
    })
    expect(initial.kind).toBe('decision_required')
    if (initial.kind !== 'decision_required') return

    const firstRequest = getArtifactDecisionRequest(initial.decisionId)
    expect(firstRequest?.kind).toBe('overwrite')

    const second = await resumeArtifactToolWriteAfterDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-conflict',
      toolUseId: 'tool-conflict',
      path: 'src/existing.ts',
      artifact,
      decisionId: initial.decisionId,
      attempt: initial.attempt,
      choice: 'rename:review-v2.ts',
      previousFinalPath: initial.previousFinalPath,
      occupiedPaths
    })
    expect(second.kind).toBe('decision_required')
    if (second.kind !== 'decision_required') return
    expect(second.decisionId).not.toBe(initial.decisionId)
    expect(second.attempt).toBeGreaterThan(initial.attempt)
    expect(getArtifactDecisionRequest(second.decisionId)?.kind).toBe('overwrite')
  })
})
