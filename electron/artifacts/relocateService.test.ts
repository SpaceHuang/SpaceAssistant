import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDbConnection } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { ArtifactPathLeaseRegistry } from './pathLeaseRegistry'
import { relocateArtifact } from './relocateService'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import * as relocateFs from './relocateFs'

describe('relocateService', () => {
  const fixtures: ArtifactTestFixture[] = []
  const registry = new ArtifactPathLeaseRegistry()

  afterEach(() => {
    vi.restoreAllMocks()
    for (const fixture of fixtures.splice(0)) fixture.teardown()
  })

  function setupArtifact(fixture: ArtifactTestFixture, relPath: string, content: string) {
    const abs = path.join(fixture.workDir, relPath)
    return fs.mkdir(path.dirname(abs), { recursive: true }).then(() => fs.writeFile(abs, content)).then(() => {
      return new ArtifactRepository(fixture.db).create({
        id: `artifact-${relPath.replace(/[^\w]+/g, '-')}`,
        sessionId: fixture.session.id,
        workDirProfileId: fixture.profile.id,
        workspaceRootReal: fixture.workDir,
        container: 'scratch',
        role: 'scratch',
        title: relPath,
        canonicalPath: abs,
        pathIdentityKey: relPath,
        pathSource: 'system-assigned'
      })
    })
  }

  it('does not create an operation journal when overwrite is not authorized', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = await setupArtifact(fixture, 'draft.md', 'source')
    const target = path.join(fixture.workDir, 'reports/final.md')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'existing')

    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      { sessionId: fixture.session.id, artifactId: artifact.id, target: 'reports/final.md', mode: 'move' }
    )

    expect(result).toEqual({ ok: false, error: 'ARTIFACT_RELOCATE_OVERWRITE_REQUIRED' })
    expect(getDbConnection(fixture.db).prepare('SELECT COUNT(*) AS count FROM artifact_operations').get()).toEqual({ count: 0 })
  })

  it('creates a prepared journal with source/target/mode, temp/backup paths and digests', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = await setupArtifact(fixture, 'draft.md', 'source-content')
    const target = path.join(fixture.workDir, 'reports/final.md')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'target-content')

    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      {
        sessionId: fixture.session.id,
        artifactId: artifact.id,
        target: 'reports/final.md',
        mode: 'move',
        overwriteAuthorized: true
      }
    )

    expect(result.ok).toBe(true)
    const row = getDbConnection(fixture.db).prepare('SELECT * FROM artifact_operations WHERE artifact_id = ?').get(artifact.id) as {
      source_path: string
      target_path: string
      move_mode: string
      target_backup_path: string
      temp_path: string | null
      expected_digest: string
      target_original_digest: string
      phase: string
    }
    expect(row.source_path).toContain('draft.md')
    expect(row.target_path).toContain('final.md')
    expect(row.move_mode).toBe('same-device-move')
    expect(row.target_backup_path).toContain('.final.md.spaceassistant-')
    expect(row.expected_digest).toHaveLength(64)
    expect(row.target_original_digest).toHaveLength(64)
    expect(['completed', 'cleanup_pending']).toContain(row.phase)
  })

  it('acquires source and target write leases in identity order', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const ordered: string[] = []
    const spy = vi.spyOn(ArtifactPathLeaseRegistry.prototype, 'acquireWrites').mockImplementation(function (this: ArtifactPathLeaseRegistry, identities) {
      ordered.push(...identities)
      return { identities: [...identities], release: () => {} }
    })
    const artifact = await setupArtifact(fixture, 'a/run.sh', 'script')
    await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      { sessionId: fixture.session.id, artifactId: artifact.id, target: 'b/run.sh', mode: 'move' }
    )
    expect(spy).toHaveBeenCalled()
    expect(ordered).toEqual([...ordered].sort())
  })

  it('same-device move backs up an existing target then commits the source to target', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = await setupArtifact(fixture, 'src/from.md', 'moved-body')
    const targetRel = 'dst/to.md'
    const target = path.join(fixture.workDir, targetRel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'old-target')

    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      {
        sessionId: fixture.session.id,
        artifactId: artifact.id,
        target: targetRel,
        mode: 'move',
        overwriteAuthorized: true
      }
    )

    expect(result.ok).toBe(true)
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('moved-body')
    const updated = new ArtifactRepository(fixture.db).find(artifact.id)
    expect(updated?.canonicalPath).toBe(targetRel)
    const op = getDbConnection(fixture.db).prepare('SELECT phase, target_backup_path FROM artifact_operations WHERE artifact_id = ?').get(artifact.id) as {
      phase: string
      target_backup_path: string
    }
    expect(op.phase).toBe('completed')
    await expect(fs.readFile(op.target_backup_path, 'utf8')).rejects.toThrow()
  })

  it('copy mode creates a new artifactId and keeps the original active by default', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = await setupArtifact(fixture, 'src/original.md', 'copy-body')
    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      { sessionId: fixture.session.id, artifactId: artifact.id, target: 'dst/copy.md', mode: 'copy' }
    )
    expect(result).toEqual(expect.objectContaining({ ok: true, activeArtifactId: artifact.id }))
    if (!result.ok) return
    expect(result.artifactId).not.toBe(artifact.id)
    expect(new ArtifactRepository(fixture.db).find(artifact.id)?.canonicalPath).toContain('original.md')
    expect(new ArtifactRepository(fixture.db).find(result.artifactId)?.canonicalPath).toContain('copy.md')
  })

  it('move keeps the same artifactId after DB commit', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = await setupArtifact(fixture, 'src/move-me.md', 'payload')
    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      { sessionId: fixture.session.id, artifactId: artifact.id, target: 'dst/moved.md', mode: 'move' }
    )
    expect(result).toEqual(expect.objectContaining({ ok: true, artifactId: artifact.id, activeArtifactId: artifact.id }))
  })

  it('cross-device source cleanup failure stays in source_cleanup_pending without rolling back target', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    vi.spyOn(relocateFs, 'detectMoveMode').mockResolvedValue('cross-device-move')
    vi.spyOn(relocateFs, 'deleteIfIdentityMatches').mockImplementation(async (absPath) => {
      if (absPath.includes(`${path.sep}src${path.sep}cross.md`)) return false
      try {
        await fs.unlink(absPath)
        return true
      } catch {
        return false
      }
    })
    const artifact = await setupArtifact(fixture, 'src/cross.md', 'cross-body')
    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      { sessionId: fixture.session.id, artifactId: artifact.id, target: 'dst/cross.md', mode: 'move', overwriteAuthorized: true }
    )
    expect(result.ok).toBe(true)
    const op = getDbConnection(fixture.db).prepare('SELECT phase FROM artifact_operations WHERE artifact_id = ?').get(artifact.id) as { phase: string }
    expect(op.phase).toBe('source_cleanup_pending')
    await expect(fs.readFile(path.join(fixture.workDir, 'dst/cross.md'), 'utf8')).resolves.toBe('cross-body')
  })

  it('marks recovery_required when identities diverge during compensation', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const artifact = await setupArtifact(fixture, 'src/fail.md', 'body')
    const target = path.join(fixture.workDir, 'dst/fail.md')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'occupied')
    vi.spyOn(relocateFs, 'sameDeviceRename').mockRejectedValueOnce(new Error('rename failed'))

    const result = await relocateArtifact(
      { db: fixture.db, profiles: [fixture.profile], registry },
      {
        sessionId: fixture.session.id,
        artifactId: artifact.id,
        target: 'dst/fail.md',
        mode: 'move',
        overwriteAuthorized: true
      }
    )

    expect(result.ok).toBe(false)
    const op = getDbConnection(fixture.db).prepare('SELECT phase FROM artifact_operations WHERE artifact_id = ?').get(artifact.id) as { phase: string }
    expect(['recovery_required', 'rolled_back']).toContain(op.phase)
  })
})
