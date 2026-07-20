import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactRepository } from './artifactRepository'
import { createArtifactIpcHandlers } from './artifactIpc'
import { getSession } from '../database'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { getSharedArtifactPathLeaseRegistry } from './toolPathLease'
import {
  registerArtifactDecisionRequest,
  resetArtifactDecisionBridgeForTests,
  waitForArtifactDecisionResponse
} from './artifactDecisionBridge'

describe('artifact IPC handlers', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => {
    getSharedArtifactPathLeaseRegistry()
    for (const fixture of fixtures.splice(0)) fixture.teardown()
  })

  function makeHandlers(fixture: ArtifactTestFixture) {
    const events: Array<{ sessionId: string; artifactId: string; action: string }> = []
    const handlers = createArtifactIpcHandlers({
      db: fixture.db,
      getProfiles: () => [fixture.profile],
      getActiveProfileId: () => fixture.profile.id,
      notifyChanged: (event) => events.push(event)
    })
    return { handlers, events }
  }

  it('lists artifacts by session from repository without trusting renderer paths', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    repository.create({
      id: 'artifact-1',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'project',
      role: 'primary',
      title: 'Auth',
      canonicalPath: path.join(fixture.workDir, 'src/auth.ts'),
      pathIdentityKey: 'src/auth.ts',
      pathSource: 'project-convention'
    })
    const { handlers } = makeHandlers(fixture)
    expect(handlers.list({ sessionId: fixture.session.id })).toEqual([
      expect.objectContaining({ id: 'artifact-1', finalPath: 'src/auth.ts', container: 'project' })
    ])
    expect(handlers.list({ sessionId: fixture.session.id, workDir: '/evil' } as never)).toEqual([
      expect.objectContaining({ id: 'artifact-1' })
    ])
  })

  it('rejects delete when workspace identity drifts and does not mark deleted', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    const target = path.join(fixture.workDir, 'draft.md')
    await fs.writeFile(target, 'x')
    repository.create({
      id: 'artifact-del',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: `${fixture.workDir}-moved`,
      container: 'scratch',
      role: 'scratch',
      title: 'Draft',
      canonicalPath: target,
      pathIdentityKey: 'draft.md',
      pathSource: 'system-assigned'
    })
    const { handlers, events } = makeHandlers(fixture)
    const result = await handlers.delete({ sessionId: fixture.session.id, artifactId: 'artifact-del' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ARTIFACT_WORKSPACE_CHANGED')
    expect(repository.find('artifact-del')?.status).toBe('active')
    expect(events).toEqual([])
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('x')
  })

  it('deletes artifact file and marks deleted on success', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    const target = path.join(fixture.workDir, 'draft.md')
    await fs.writeFile(target, 'x')
    repository.create({
      id: 'artifact-del-2',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'scratch',
      role: 'scratch',
      title: 'Draft',
      canonicalPath: target,
      pathIdentityKey: 'draft.md',
      pathSource: 'system-assigned'
    })
    const { handlers, events } = makeHandlers(fixture)
    const result = await handlers.delete({ sessionId: fixture.session.id, artifactId: 'artifact-del-2' })
    expect(result).toEqual({ ok: true })
    expect(repository.find('artifact-del-2')?.status).toBe('deleted')
    expect(events).toEqual([{ sessionId: fixture.session.id, artifactId: 'artifact-del-2', action: 'deleted' }])
    await expect(fs.readFile(target, 'utf8')).rejects.toThrow()
  })

  it('relocate moves artifact through RelocateService IPC', async () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const repository = new ArtifactRepository(fixture.db)
    const source = path.join(fixture.workDir, 'scratch.md')
    await fs.writeFile(source, 'payload')
    repository.create({
      id: 'artifact-relocate',
      sessionId: fixture.session.id,
      workDirProfileId: fixture.profile.id,
      workspaceRootReal: fixture.workDir,
      container: 'scratch',
      role: 'scratch',
      title: 'Scratch',
      canonicalPath: source,
      pathIdentityKey: 'scratch.md',
      pathSource: 'system-assigned'
    })
    const { handlers, events } = makeHandlers(fixture)
    const result = await handlers.relocate({
      sessionId: fixture.session.id,
      artifactId: 'artifact-relocate',
      target: 'project/scratch.md',
      mode: 'move'
    })
    expect(result.ok).toBe(true)
    expect(repository.find('artifact-relocate')?.canonicalPath).toContain('project/scratch.md')
    expect(events.some((event) => event.artifactId === 'artifact-relocate' && event.action === 'updated')).toBe(true)
  })

  it('stores default dir in session metadata after strict workspace validation', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const { handlers } = makeHandlers(fixture)
    handlers.setDefaultDir({ sessionId: fixture.session.id, dir: 'reports/final' })
    expect(getSession(fixture.db, fixture.session.id)?.metadata?.artifactDefaultDir).toBe('reports/final')
  })

  describe('decisionResponse result protocol', () => {
    afterEach(() => {
      resetArtifactDecisionBridgeForTests()
    })

    function registerDesktopDecision() {
      const request = registerArtifactDecisionRequest({
        requestId: 'req-ipc',
        sessionId: 'sess-ipc',
        toolUseId: 'tool-ipc',
        attempt: 1,
        kind: 'overwrite',
        options: [
          { key: 'overwrite', label: '覆盖' },
          { key: 'cancel', label: '取消' }
        ]
      })
      const waitPromise = waitForArtifactDecisionResponse(request.requestId, request.toolUseId)
      return { request, waitPromise }
    }

    it('returns resolved/stale/binding_mismatch/invalid to the caller', async () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const { handlers } = makeHandlers(fixture)
      const { request, waitPromise } = registerDesktopDecision()

      expect(
        handlers.decisionResponse({
          decisionId: request.decisionId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          toolUseId: request.toolUseId,
          attempt: request.attempt,
          choice: 'overwrite'
        })
      ).toBe('resolved')
      await expect(waitPromise).resolves.toMatchObject({ choice: 'overwrite' })

      expect(
        handlers.decisionResponse({
          decisionId: request.decisionId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          toolUseId: request.toolUseId,
          attempt: request.attempt,
          choice: 'cancel'
        })
      ).toBe('stale')

      const second = registerDesktopDecision()
      expect(
        handlers.decisionResponse({
          decisionId: second.request.decisionId,
          requestId: 'wrong-req',
          sessionId: second.request.sessionId,
          toolUseId: second.request.toolUseId,
          attempt: second.request.attempt,
          choice: 'overwrite'
        })
      ).toBe('binding_mismatch')

    expect(
      handlers.decisionResponse({
        decisionId: second.request.decisionId,
        requestId: second.request.requestId,
        sessionId: second.request.sessionId,
        toolUseId: second.request.toolUseId,
        attempt: second.request.attempt,
        choice: ''
      })
    ).toBe('invalid')

    expect(
      handlers.decisionResponse({
        decisionId: second.request.decisionId,
        requestId: second.request.requestId,
        sessionId: second.request.sessionId,
        toolUseId: second.request.toolUseId,
        attempt: second.request.attempt,
        choice: 'rename:../evil'
      })
    ).toBe('invalid')
  })

    it('keeps ordinary desktop decisions working without remote owner', async () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const { handlers } = makeHandlers(fixture)
      const { request, waitPromise } = registerDesktopDecision()
      expect(
        handlers.decisionResponse({
          decisionId: request.decisionId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          toolUseId: request.toolUseId,
          attempt: request.attempt,
          choice: 'cancel'
        })
      ).toBe('resolved')
      await expect(waitPromise).resolves.toMatchObject({ choice: 'cancel' })
    })
  })
})
