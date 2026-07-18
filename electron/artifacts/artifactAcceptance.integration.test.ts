import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetArtifactDecisionBridgeForTests } from './artifactDecisionBridge'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { isArtifactManagementEnabled, shouldUseLegacyWorkspaceRedirect } from './featureFlag'
import { prepareArtifactToolWrite, registerArtifactWriteOutcome, createToolLoopArtifactState } from './toolLoopArtifactFlow'
import { createSession, getSession } from '../database'
import { ArtifactRepository } from './artifactRepository'

describe('artifact acceptance integration (Section 8 starter)', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    fixtures.splice(0).forEach((fixture) => fixture.teardown())
  })

  it('AC-01/AC-35: artifact-enabled session skips legacy extension redirect semantics', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const session = createSession(fixture.db, {
      name: 'artifact-on',
      workDirProfileId: fixture.profile.id,
      artifactManagementEnabled: true
    })
    const metadata = getSession(fixture.db, session.id)!.metadata
    expect(isArtifactManagementEnabled(metadata)).toBe(true)
    expect(shouldUseLegacyWorkspaceRedirect(metadata)).toBe(false)
  })

  it('AC-02: explicit project path resolves without redirecting to another directory', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const result = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'ac-02',
      toolUseId: 'tool-ac-02',
      path: 'src/auth.ts',
      artifact: {
        container: 'project',
        role: 'primary',
        title: 'auth',
        requestedPath: 'src/auth.ts',
        pathSource: 'project-convention'
      }
    })
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    expect(result.prepared.finalPath).toBe('src/auth.ts')
  })

  it('AC-22: scratch write uses system-assigned runs path', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const result = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'ac-22',
      toolUseId: 'tool-ac-22',
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
    expect(result.prepared.finalPath).toMatch(/^\.spaceassistant\/runs\//)
    expect(result.prepared.pathResolvedPayload.metadata.provenance).toEqual({ pathSource: 'system-assigned' })
  })

  it('AC-39: successful write registers artifact; failed write does not', () => {
    const fixture = createArtifactTestFixture()
    fixtures.push(fixture)
    const state = createToolLoopArtifactState('ac-39')
    const prepared = prepareArtifactToolWrite({
      workDir: fixture.workDir,
      sessionId: fixture.session.id,
      requestId: 'ac-39',
      toolUseId: 'tool-ac-39',
      path: 'notes.md',
      artifact: {
        container: 'project',
        role: 'primary',
        title: 'notes',
        requestedPath: 'notes.md',
        pathSource: 'agent-default'
      }
    })
    expect(prepared.kind).toBe('ready')
    if (prepared.kind !== 'ready') return
    const outcome = registerArtifactWriteOutcome({
      db: fixture.db,
      sessionId: fixture.session.id,
      workDir: fixture.workDir,
      workDirProfileId: fixture.profile.id,
      requestId: 'ac-39',
      prepared: prepared.prepared,
      writeSucceeded: true,
      changeCursor: state.changeCursor
    })
    expect(outcome.ok).toBe(true)
    expect(new ArtifactRepository(fixture.db).listBySession(fixture.session.id)).toHaveLength(1)
    const target = path.join(fixture.workDir, 'notes.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'content')
    const failed = registerArtifactWriteOutcome({
      db: fixture.db,
      sessionId: fixture.session.id,
      workDir: fixture.workDir,
      workDirProfileId: fixture.profile.id,
      requestId: 'ac-39-b',
      prepared: prepared.prepared,
      writeSucceeded: false,
      changeCursor: state.changeCursor
    })
    expect(failed.ok).toBe(false)
    expect(new ArtifactRepository(fixture.db).listBySession(fixture.session.id)).toHaveLength(1)
  })
})
