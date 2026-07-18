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

  it('relocates and deletes artifacts registered with relative canonicalPath', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { registerResolvedArtifactWrite } = await import('./writeRegistration')
    const { relocateArtifact } = await import('./relocateService')
    const { deleteArtifactFile } = await import('./artifactDeletion')
    const { artifactPathIdentityForRelative, artifactLeaseKey } = await import('./artifactPathKeys')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')

    await fs.mkdir(fixture.workDir, { recursive: true })
    await fs.writeFile(path.join(fixture.workDir, 'draft.md'), 'body')
    const record = registerResolvedArtifactWrite({
      repository: new ArtifactRepository(fixture.db),
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workDir: fixture.workDir,
      intent: {
        container: 'scratch',
        role: 'scratch',
        title: 'draft.md',
        pathSource: 'system-assigned'
      },
      resolved: {
        finalPath: 'draft.md',
        canonicalPath: path.join(fixture.workDir, 'draft.md'),
        provenance: { pathSource: 'system-assigned' }
      }
    })
    expect(record.canonicalPath).toBe('draft.md')

    const relocated = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry: getSharedArtifactPathLeaseRegistry() },
      { sessionId: fixture.session.id, artifactId: record.id, target: 'reports/final.md', mode: 'move' }
    )
    expect(relocated.ok).toBe(true)
    const after = new ArtifactRepository(fixture.db).find(record.id)
    expect(after?.canonicalPath).toBe('reports/final.md')
    await expect(fs.readFile(path.join(fixture.workDir, 'reports/final.md'), 'utf8')).resolves.toBe('body')

    await deleteArtifactFile({
      registry: getSharedArtifactPathLeaseRegistry(),
      identity: artifactLeaseKey(after!.workspaceRootReal, after!.pathIdentityKey),
      targetPath: path.join(fixture.workDir, after!.canonicalPath),
      workDir: fixture.workDir,
      expectedWorkspaceRootReal: after!.workspaceRootReal,
      artifactId: after!.id,
      repository: new ArtifactRepository(fixture.db)
    })
    expect(new ArtifactRepository(fixture.db).find(record.id)?.status).toBe('deleted')
    expect(artifactPathIdentityForRelative(fixture.workDir, 'reports/final.md')).toBeTruthy()
  })

  it('rejects relocate while a tool write lease holds the source identity', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { relocateArtifact } = await import('./relocateService')
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    await fs.writeFile(path.join(fixture.workDir, 'draft.md'), 'body')
    const artifact = new ArtifactRepository(fixture.db).create({
      id: 'leased-draft',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'scratch',
      role: 'scratch',
      title: 'draft',
      canonicalPath: 'draft.md',
      pathIdentityKey: (await import('./artifactPathKeys')).artifactPathIdentityForRelative(fixture.workDir, 'draft.md'),
      pathSource: 'system-assigned'
    })
    const write = acquireToolWriteLease(fixture.session.id, 'draft.md', fixture.workDir)
    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry: getSharedArtifactPathLeaseRegistry() },
      { sessionId: fixture.session.id, artifactId: artifact.id, target: 'moved.md', mode: 'move' }
    )
    write.release()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/lease/i)
  })

  it('completes ownership package and project choices through resume', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { resumeArtifactToolWriteAfterDecision } = await import('./toolLoopArtifactFlow')
    const ownershipArtifact = {
      container: 'package' as const,
      role: 'supporting' as const,
      title: 'notes',
      pathSource: 'agent-default' as const
    }

    const prepared = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'own-2',
      toolUseId: 'tool-own-2',
      path: '',
      artifact: ownershipArtifact
    })
    expect(prepared.kind).toBe('decision_required')
    if (prepared.kind !== 'decision_required') return
    expect(prepared.decisionKind).toBe('ownership')

    const afterPackage = await resumeArtifactToolWriteAfterDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'own-2',
      toolUseId: 'tool-own-2',
      path: '',
      decisionId: prepared.decisionId,
      decisionKind: 'ownership',
      attempt: prepared.attempt,
      previousFinalPath: prepared.previousFinalPath,
      choice: 'package',
      artifact: ownershipArtifact
    })
    expect(afterPackage.kind).toBe('decision_required')
    if (afterPackage.kind !== 'decision_required') return
    expect(afterPackage.decisionKind).toBe('output-location')

    const afterLocation = await resumeArtifactToolWriteAfterDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'own-2',
      toolUseId: 'tool-own-2',
      path: '',
      decisionId: afterPackage.decisionId,
      decisionKind: 'output-location',
      attempt: afterPackage.attempt,
      previousFinalPath: afterPackage.previousFinalPath,
      choice: 'change-directory:reports/out',
      artifact: afterPackage.artifact
    })
    expect(afterLocation.kind).toBe('ready')
    if (afterLocation.kind === 'ready') {
      expect(afterLocation.prepared.finalPath).toMatch(/^reports\/out\//)
    }

    const asProject = await resumeArtifactToolWriteAfterDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'own-project',
      toolUseId: 'tool-project',
      path: '',
      decisionId: 'dec-project',
      decisionKind: 'ownership',
      attempt: 0,
      previousFinalPath: '',
      choice: 'project',
      artifact: ownershipArtifact
    })
    expect(asProject.kind).toBe('ready')
    if (asProject.kind === 'ready') {
      expect(asProject.prepared.finalPath).toBe('notes.md')
    }
  })

  it('consumes user path evidence after overwrite decision reaches ready', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { resumeArtifactToolWriteAfterDecision } = await import('./toolLoopArtifactFlow')
    const userMessage = '保存为 `occupied.md`'
    const evidence = extractExplicitPathEvidence(userMessage, { requestId: 'ev-ow' })
    const consumption = new ArtifactEvidenceConsumption(evidence)
    const occupied = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'ev-ow',
      toolUseId: 't-first',
      path: 'occupied.md',
      userMessage,
      evidenceConsumption: consumption,
      occupiedPaths: ['occupied.md'],
      artifact: {
        container: 'project',
        role: 'primary',
        requestedPath: 'occupied.md',
        pathSource: 'user',
        pathEvidenceId: evidence[0]!.evidenceId
      }
    })
    expect(occupied).toEqual(expect.objectContaining({ kind: 'decision_required' }))
    expect(consumption.unconsumedOutputEvidence().length).toBeGreaterThan(0)

    if (occupied.kind !== 'decision_required') return
    const ready = await resumeArtifactToolWriteAfterDecision({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'ev-ow',
      toolUseId: 't-first',
      path: 'occupied.md',
      decisionId: occupied.decisionId,
      decisionKind: 'overwrite',
      attempt: occupied.attempt,
      previousFinalPath: occupied.previousFinalPath,
      choice: 'overwrite',
      occupiedPaths: ['occupied.md'],
      userMessage,
      evidenceConsumption: consumption,
      artifact: {
        container: 'project',
        role: 'primary',
        requestedPath: 'occupied.md',
        pathSource: 'user',
        pathEvidenceId: evidence[0]!.evidenceId
      }
    })
    expect(ready.kind).toBe('ready')
    expect(consumption.unconsumedOutputEvidence()).toEqual([])
  })
})
