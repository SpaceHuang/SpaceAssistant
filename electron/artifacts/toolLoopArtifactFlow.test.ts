import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetArtifactDecisionBridgeForTests,
  submitArtifactDecisionResponse
} from './artifactDecisionBridge'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { ArtifactRepository } from './artifactRepository'
import {
  artifactManagedWriteStageOrder,
  createToolLoopArtifactState,
  prepareArtifactToolWrite,
  registerArtifactWriteOutcome,
  resolveArtifactToolWriteWithDecision,
  resumeArtifactToolWriteAfterDecision,
  runArtifactManagedWriteStagesForTests
} from './toolLoopArtifactFlow'
import * as writeRegistration from './writeRegistration'

describe('toolLoopArtifactFlow', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    fixtures.splice(0).forEach((fixture) => fixture.teardown())
  })

  it('resolves scratch writes to finalPath before confirm would run', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const result = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-1',
      toolUseId: 'tool-1',
      path: 'ignored.sh',
      artifact: {
        container: 'scratch',
        role: 'scratch',
        title: 'verify.sh',
        materialKind: 'script',
        pathSource: 'agent-default'
      }
    })
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.prepared.finalPath).toBe('.spaceassistant/runs/' + fixture.session.id + '/script/verify.sh')
    expect(result.prepared.pathResolvedPayload.type).toBe('tool:path-resolved')
    expect(result.prepared.pathResolvedPayload.metadata.finalPath).toBe(result.prepared.finalPath)
  })

  it('returns decision_required instead of throwing when resolver needs a path decision', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const result = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-2',
      toolUseId: 'tool-2',
      path: '',
      artifact: {
        container: 'package',
        role: 'primary',
        title: 'report',
        pathSource: 'agent-default'
      }
    })
    expect(result).toMatchObject({ kind: 'decision_required', decisionKind: 'output-location', attempt: 0 })
  })

  it('resumes the same requestId/toolUseId after an overwrite decision', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const occupied = path.join(fixture.workDir, 'src/existing.ts')
    fs.mkdirSync(path.dirname(occupied), { recursive: true })
    fs.writeFileSync(occupied, 'old')
    const artifact = {
      container: 'project',
      role: 'primary',
      title: 'existing',
      requestedPath: 'src/existing.ts',
      pathSource: 'agent-default'
    }
    const initial = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-3',
      toolUseId: 'tool-3',
      path: 'src/existing.ts',
      artifact,
      occupiedPaths: ['src/existing.ts']
    })
    expect(initial.kind).toBe('decision_required')
    if (initial.kind !== 'decision_required') return
    const resumed = await resumeArtifactToolWriteAfterDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-3',
      toolUseId: 'tool-3',
      path: 'src/existing.ts',
      artifact,
      decisionId: initial.decisionId,
      attempt: initial.attempt,
      choice: 'overwrite',
      previousFinalPath: initial.previousFinalPath,
      occupiedPaths: ['src/existing.ts']
    })
    expect(resumed.kind).toBe('ready')
    if (resumed.kind !== 'ready') return
    expect(resumed.prepared.finalPath).toBe('src/existing.ts')
  })

  it('keeps resolver, confirm, remote grant, execute, and register in order', () => {
    const trace: string[] = []
    const { confirmInput } = runArtifactManagedWriteStagesForTests({
      trace,
      resolve: () => ({ finalPath: 'resolved.md' }),
      buildConfirmInput: (finalPath) => {
        expect(finalPath).toBe('resolved.md')
        return { path: finalPath }
      },
      evaluateRemoteGrant: () => {},
      execute: () => true,
      register: () => {}
    })
    expect(trace).toEqual(artifactManagedWriteStageOrder())
    expect(confirmInput.path).toBe('resolved.md')
  })

  it('does not register artifacts when the write fails', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const state = createToolLoopArtifactState('req-4')
    const prepared = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-4',
      toolUseId: 'tool-4',
      path: 'notes.md',
      artifact: { container: 'project', role: 'primary', title: 'notes', requestedPath: 'notes.md', pathSource: 'agent-default' }
    })
    expect(prepared.kind).toBe('ready')
    if (prepared.kind !== 'ready') return
    const outcome = registerArtifactWriteOutcome({
      db: fixture.db,
      sessionId: fixture.session.id,
      workDir: fixture.workDir,
      workDirProfileId: fixture.profile.id,
      requestId: 'req-4',
      prepared: prepared.prepared,
      writeSucceeded: false,
      changeCursor: state.changeCursor
    })
    expect(outcome.ok).toBe(false)
    expect(new ArtifactRepository(fixture.db).listBySession(fixture.session.id)).toHaveLength(0)
    expect(state.changeCursor.entries()).toHaveLength(0)
  })

  it('registers only after a successful write and reports recoverable audit on registration failure', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const state = createToolLoopArtifactState('req-5')
    const prepared = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-5',
      toolUseId: 'tool-5',
      path: 'notes.md',
      artifact: { container: 'project', role: 'primary', title: 'notes', requestedPath: 'notes.md', pathSource: 'agent-default' }
    })
    expect(prepared.kind).toBe('ready')
    if (prepared.kind !== 'ready') return
    const audit = vi.fn()
    vi.spyOn(writeRegistration, 'registerResolvedArtifactWrite').mockImplementation(() => {
      throw new Error('database unavailable')
    })
    const failing = registerArtifactWriteOutcome({
      db: fixture.db,
      sessionId: fixture.session.id,
      workDir: fixture.workDir,
      workDirProfileId: fixture.profile.id,
      requestId: 'req-5',
      prepared: prepared.prepared,
      writeSucceeded: true,
      changeCursor: state.changeCursor,
      audit: (event, detail) => audit(event, detail)
    })
    vi.restoreAllMocks()
    expect(failing.ok).toBe(false)
    if (failing.ok) return
    expect(failing.error).toContain('文件已写入但登记失败')
    expect(audit).toHaveBeenCalledWith('artifact.register.failed', expect.objectContaining({ requestId: 'req-5' }))
    expect(new ArtifactRepository(fixture.db).listBySession(fixture.session.id)).toHaveLength(0)
  })

  it('resolves artifact writes through wait/resume using the same toolUseId', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = {
      container: 'project',
      role: 'primary',
      title: 'existing',
      requestedPath: 'src/existing.ts',
      pathSource: 'agent-default'
    }
    const resolved = await resolveArtifactToolWriteWithDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'req-6',
      toolUseId: 'tool-6',
      path: 'src/existing.ts',
      artifact,
      occupiedPaths: ['src/existing.ts'],
      onDecisionRequired: (pending) => {
        submitArtifactDecisionResponse({
          decisionId: pending.decisionId,
          requestId: 'req-6',
          sessionId: fixture.session.id,
          toolUseId: 'tool-6',
          attempt: pending.attempt,
          choice: 'overwrite'
        })
      }
    })
    expect(resolved.kind).toBe('ready')
  })
})
