import { describe, expect, it, afterEach } from 'vitest'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { resolveToolArtifactPath } from './toolArtifactPath'
import { extractExplicitPathEvidence } from './explicitPathEvidence'
import { ArtifactEvidenceConsumption } from './evidenceConsumption'
import { ArtifactRepository } from './artifactRepository'
import { prepareArtifactToolWrite } from './toolLoopArtifactFlow'
import { buildArtifactDecisionOptions } from '../remote/artifactDecisionRemote'
import {
  registerArtifactDecisionRequest,
  submitArtifactDecisionResponse,
  waitForArtifactDecisionResponse,
  resetArtifactDecisionBridgeForTests
} from './artifactDecisionBridge'
import { signalChatCancel, registerChatCancel, clearChatCancel } from '../chatCancelRegistry'
import { deleteSession, getDbConnection } from '../database'
import { getSharedArtifactPathLeaseRegistry, toolWriteLeaseIdentity, clearToolPathLeases, acquireToolWriteLease } from './toolPathLease'

describe('review remediation production wiring', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    clearToolPathLeases()
    fixtures.splice(0).forEach((f) => f.teardown())
  })

  it('rejects forged user path evidence in resolveToolArtifactPath', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const userMessage = '保存为 `reports/final.md`'
    expect(() => resolveToolArtifactPath({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      toolUseId: 't1',
      path: 'other.md',
      requestId: 'request-1',
      userMessage,
      artifact: {
        container: 'project',
        role: 'primary',
        requestedPath: 'other.md',
        pathSource: 'user',
        pathEvidenceId: 'request-1:0-99'
      }
    })).toThrow(/ARTIFACT_EXPLICIT_PATH_UNRESOLVED/)
  })

  it('loads existingArtifact from the repository for continued edits', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repo = new ArtifactRepository(fixture.db)
    repo.create({
      id: 'draft-1',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'package',
      role: 'primary',
      title: 'draft',
      canonicalPath: 'draft.md',
      pathIdentityKey: 'draft-id',
      pathSource: 'agent-default'
    })
    const resolved = resolveToolArtifactPath({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      toolUseId: 't1',
      path: 'moved.md',
      db: fixture.db,
      artifact: {
        container: 'package',
        role: 'primary',
        artifactId: 'draft-1',
        requestedPath: 'moved.md',
        pathSource: 'agent-default'
      }
    })
    expect(resolved.finalPath).toBe('draft.md')
  })

  it('derives package materials from the repository package primary path', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repo = new ArtifactRepository(fixture.db)
    repo.create({
      id: 'pkg-1',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'package',
      role: 'primary',
      title: 'report',
      canonicalPath: 'reports/final.md',
      pathIdentityKey: 'pkg-primary',
      pathSource: 'agent-default'
    })
    const resolved = resolveToolArtifactPath({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      toolUseId: 't1',
      path: 'ignored.ts',
      db: fixture.db,
      artifact: {
        container: 'package',
        role: 'supporting',
        packageId: 'pkg-1',
        title: 'query',
        materialKind: 'script',
        pathSource: 'agent-default'
      }
    })
    expect(resolved.finalPath).toBe('reports/final.materials/query.ts')
  })

  it('blocks new scratch writes while explicit output evidence remains unresolved', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const userMessage = '保存为 `reports/final.md`'
    const consumption = new ArtifactEvidenceConsumption(extractExplicitPathEvidence(userMessage, { requestId: 'request-2' }))
    expect(() => resolveToolArtifactPath({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      toolUseId: 't1',
      path: 'tmp.sh',
      requestId: 'request-2',
      userMessage,
      evidenceConsumption: consumption,
      artifact: {
        container: 'scratch',
        role: 'scratch',
        title: 'tmp.sh',
        materialKind: 'script',
        pathSource: 'agent-default'
      }
    })).toThrow(/ARTIFACT_EXPLICIT_PATH_UNRESOLVED/)
  })

  it('exposes complete options for non-overwrite decisions', () => {
    expect(buildArtifactDecisionOptions('output-location').map((o) => o.key)).toEqual(['custom'])
    expect(buildArtifactDecisionOptions('ownership').map((o) => o.key)).toEqual(['project', 'package', 'scratch'])
    expect(buildArtifactDecisionOptions('overwrite').map((o) => o.key)).toEqual([
      'overwrite', 'rename', 'change-directory', 'cancel'
    ])
    const result = prepareArtifactToolWrite({
      workDir: '/tmp',
      sessionId: 's',
      requestId: 'r',
      toolUseId: 't',
      path: 'placeholder.md',
      artifact: { container: 'package', role: 'primary', packageId: 'p', pathSource: 'agent-default' }
    })
    expect(result).toEqual(expect.objectContaining({
      kind: 'decision_required',
      decisionKind: 'output-location'
    }))
  })

  it('cancels an in-flight artifact decision wait via chat cancel', async () => {
    const signal = registerChatCancel('cancel-req')
    const pending = registerArtifactDecisionRequest({
      requestId: 'cancel-req',
      sessionId: 's',
      toolUseId: 't',
      attempt: 0,
      kind: 'overwrite',
      options: buildArtifactDecisionOptions('overwrite')
    })
    const wait = waitForArtifactDecisionResponse('cancel-req', 't', signal)
    signalChatCancel('cancel-req')
    await expect(wait).resolves.toBeNull()
    clearChatCancel('cancel-req')
    expect(pending.decisionId).toBeTruthy()
  })

  it('does not consume a decision when no waiter is registered', () => {
    const pending = registerArtifactDecisionRequest({
      requestId: 'orphan',
      sessionId: 's',
      toolUseId: 't',
      attempt: 0,
      kind: 'overwrite',
      options: buildArtifactDecisionOptions('overwrite')
    })
    submitArtifactDecisionResponse({
      decisionId: pending.decisionId,
      requestId: 'orphan',
      sessionId: 's',
      toolUseId: 't',
      attempt: 0,
      choice: 'overwrite'
    })
    // Still pending in registry — consume should still work for a real waiter later.
    const wait = waitForArtifactDecisionResponse('orphan', 't')
    submitArtifactDecisionResponse({
      decisionId: pending.decisionId,
      requestId: 'orphan',
      sessionId: 's',
      toolUseId: 't',
      attempt: 0,
      choice: 'overwrite'
    })
    return expect(wait).resolves.toEqual(expect.objectContaining({ choice: 'overwrite' }))
  })

  it('allows session deletion after a rolled_back relocate journal', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = new ArtifactRepository(fixture.db).create({
      id: 'artifact',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'project',
      role: 'primary',
      canonicalPath: 'src/a.ts',
      pathIdentityKey: 'src/a.ts',
      pathSource: 'agent-default'
    })
    getDbConnection(fixture.db)
      .prepare(`INSERT INTO artifact_operations (
        id, artifact_id, operation, move_mode, source_path, target_path, phase, created_at, updated_at
      ) VALUES (?, ?, 'relocate', 'move', 'src/a.ts', 'src/b.ts', 'rolled_back', 1, 1)`)
      .run('operation', artifact.id)
    expect(() => deleteSession(fixture.db, fixture.session.id)).not.toThrow()
  })

  it('uses a shared lease key space so writes block deletes', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const workDir = fixture.workDir
    const write = acquireToolWriteLease('s1', 'report.md', workDir)
    const identity = toolWriteLeaseIdentity(workDir, 'report.md')
    expect(() => getSharedArtifactPathLeaseRegistry().claimDelete(identity)).toThrow(/lease/i)
    write.release()
    getSharedArtifactPathLeaseRegistry().claimDelete(identity).release()
  })
})
