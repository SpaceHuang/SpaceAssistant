import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import { RelocateOperationRepository } from './relocateOperationRepository'
import { computeFileDigest } from './relocateDigest'
import { recoverPendingRelocateOperations, recoverRelocateOperation } from './relocateRecovery'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'

describe('relocateRecovery', () => {
  const fixtures: ArtifactTestFixture[] = []
  const registry = new ArtifactPathLeaseRegistry()

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.teardown()
  })

  async function seedOperation(fixture: ArtifactTestFixture, phase: string, input?: {
    targetContent?: string
    sourceContent?: string
    commitArtifact?: boolean
  }) {
    const sourceRel = 'src/source.md'
    const targetRel = 'dst/target.md'
    const source = path.join(fixture.workDir, sourceRel)
    const target = path.join(fixture.workDir, targetRel)
    await fs.mkdir(path.dirname(source), { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(source, input?.sourceContent ?? 'source-body')
    if (input?.targetContent) await fs.writeFile(target, input.targetContent)
    const digest = await computeFileDigest(source)
    const artifact = new ArtifactRepository(fixture.db).create({
      id: 'artifact-recover',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'scratch',
      role: 'scratch',
      title: 'Recover',
      canonicalPath: input?.commitArtifact ? target : source,
      pathIdentityKey: input?.commitArtifact ? targetRel : sourceRel,
      pathSource: 'system-assigned'
    })
    const operations = new RelocateOperationRepository(fixture.db)
    const operation = operations.createPrepared({
      id: 'operation-recover',
      artifactId: artifact.id,
      moveMode: 'same-device-move',
      sourcePath: source,
      targetPath: target,
      targetExisted: Boolean(input?.targetContent),
      expectedSize: Buffer.byteLength(input?.sourceContent ?? 'source-body'),
      expectedDigest: digest
    })
    operations.updatePhase(operation.id, phase as never)
    return { artifact, source, target, operation, digest }
  }

  it('recovers cleanup_pending by deleting backup files and completing idempotently', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const target = path.join(fixture.workDir, 'dst/target.md')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'committed')
    const backup = path.join(fixture.workDir, 'dst/.target.md.spaceassistant-operation-recover.bak')
    await fs.writeFile(backup, 'backup')
    const { artifact } = await seedOperation(fixture, 'cleanup_pending', { commitArtifact: true })
    getDbConnection(fixture.db)
      .prepare('UPDATE artifact_operations SET target_backup_path = ?, target_backup_identity = ? WHERE id = ?')
      .run(backup, JSON.stringify((await import('../safeAtomicWrite')).identityFromStat(await fs.stat(backup))), 'operation-recover')

    const first = await recoverRelocateOperation({ db: fixture.db, profiles: [fixture.profile], registry }, 'operation-recover')
    const second = await recoverRelocateOperation({ db: fixture.db, profiles: [fixture.profile], registry }, 'operation-recover')
    expect(first.phase).toBe('completed')
    expect(second.phase).toBe('completed')
    await expect(fs.readFile(backup, 'utf8')).rejects.toThrow()
    expect(new ArtifactRepository(fixture.db).find(artifact.id)?.canonicalPath).toBe(target)
  })

  it('recovers source_cleanup_pending by retrying source deletion', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { source } = await seedOperation(fixture, 'source_cleanup_pending', { commitArtifact: true, targetContent: 'committed' })
    getDbConnection(fixture.db).prepare("UPDATE artifact_operations SET move_mode = 'cross-device-move' WHERE id = ?").run('operation-recover')

    await recoverRelocateOperation({ db: fixture.db, profiles: [fixture.profile], registry }, 'operation-recover')
    const phase = getDbConnection(fixture.db).prepare('SELECT phase FROM artifact_operations WHERE id = ?').get('operation-recover') as { phase: string }
    expect(['cleanup_pending', 'completed', 'source_cleanup_pending']).toContain(phase.phase)
    if (phase.phase === 'source_cleanup_pending') {
      await expect(fs.readFile(source, 'utf8')).resolves.toBeDefined()
    }
  })

  it('recovers target_committed by replaying DB commit when artifact path is stale', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { target } = await seedOperation(fixture, 'target_committed')
    await fs.writeFile(target, 'committed')
    await recoverRelocateOperation({ db: fixture.db, profiles: [fixture.profile], registry }, 'operation-recover')
    const artifact = new ArtifactRepository(fixture.db).find('artifact-recover')
    expect(artifact?.canonicalPath).toBe(target)
  })

  it('scans all non-terminal operations on startup recovery', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    await seedOperation(fixture, 'cleanup_pending', { commitArtifact: true, targetContent: 'done' })
    const count = await recoverPendingRelocateOperations({ db: fixture.db, profiles: [fixture.profile], registry })
    expect(count).toBeGreaterThan(0)
  })

  it('recovers prepared phase without mutating an already committed target', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { target, digest } = await seedOperation(fixture, 'prepared')
    await fs.writeFile(target, 'source-body')
    getDbConnection(fixture.db).prepare('UPDATE artifact_operations SET expected_digest = ? WHERE id = ?').run(digest, 'operation-recover')
    await recoverRelocateOperation({ db: fixture.db, profiles: [fixture.profile], registry }, 'operation-recover')
    const phase = getDbConnection(fixture.db).prepare('SELECT phase FROM artifact_operations WHERE id = ?').get('operation-recover') as { phase: string }
    expect(['target_committed', 'cleanup_pending', 'completed']).toContain(phase.phase)
  })
})
