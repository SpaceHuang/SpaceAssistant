import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetArtifactDecisionBridgeForTests } from './artifactDecisionBridge'
import { createArtifactTestFixture, type ArtifactTestFixture } from './testHelpers'
import { isArtifactManagementEnabled, shouldUseLegacyWorkspaceRedirect } from './featureFlag'
import {
  prepareArtifactToolWrite,
  registerArtifactWriteOutcome,
  createToolLoopArtifactState
} from './toolLoopArtifactFlow'
import { createSession, getSession } from '../database'
import { ArtifactRepository } from './artifactRepository'
import { resolveArtifactOutput } from './artifactResolver'
import { resolveReferenceRetention } from './referenceRetention'
import { buildArtifactCompletionSummary } from './completionSummary'
import { ArtifactChangeCursor } from './changeCursor'
import { extractExplicitPathEvidence } from './explicitPathEvidence'
import { buildArtifactDecisionOptions } from '../remote/artifactDecisionRemote'

describe('artifact acceptance integration', () => {
  const fixtures: ArtifactTestFixture[] = []
  afterEach(() => {
    resetArtifactDecisionBridgeForTests()
    fixtures.splice(0).forEach((fixture) => fixture.teardown())
  })

  describe('dev scenario (AC-01～05, AC-22～25, AC-33, AC-35～40)', () => {
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

    it('AC-02/AC-05: explicit project paths resolve literally without redirect', () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      for (const requestedPath of ['src/auth.ts', 'docs/api.md', 'docs/review/notes.md']) {
        const result = prepareArtifactToolWrite({
          workDir: fixture.workDir,
          sessionId: fixture.session.id,
          requestId: `ac-02-${requestedPath}`,
          toolUseId: `tool-${requestedPath}`,
          path: requestedPath,
          artifact: {
            container: 'project',
            role: 'primary',
            title: path.basename(requestedPath),
            requestedPath,
            pathSource: 'project-convention'
          }
        })
        expect(result.kind).toBe('ready')
        if (result.kind !== 'ready') continue
        expect(result.prepared.finalPath).toBe(requestedPath)
      }
    })

    it('AC-03/AC-36: temporary verification script lands in scratch runs', () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const result = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-03',
        toolUseId: 'tool-ac-03',
        path: 'verify-login.sh',
        artifact: {
          container: 'scratch',
          role: 'scratch',
          title: 'verify-login.sh',
          materialKind: 'script',
          pathSource: 'agent-default'
        }
      })
      expect(result.kind).toBe('ready')
      if (result.kind !== 'ready') return
      expect(result.prepared.finalPath).toMatch(/^\.spaceassistant\/runs\//)
      expect(result.prepared.resolved.decision).toBeUndefined()
    })

    it('AC-04: project and scratch writes appear in completion summary', () => {
      const summary = buildArtifactCompletionSummary([
        { artifactId: 'p1', container: 'project', role: 'primary', finalPath: 'src/auth.ts' },
        { artifactId: 't1', container: 'project', role: 'primary', finalPath: 'src/auth.test.ts' },
        { artifactId: 's1', container: 'scratch', role: 'scratch', finalPath: '.spaceassistant/runs/s1/script/verify.sh' }
      ])
      expect(summary.project).toHaveLength(2)
      expect(summary.scratch).toHaveLength(1)
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

    it('AC-33: scratch script path stays relative to workDir for project resource access', () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      fs.mkdirSync(path.join(fixture.workDir, 'src'), { recursive: true })
      fs.writeFileSync(path.join(fixture.workDir, 'src', 'config.json'), '{}')
      const result = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-33',
        toolUseId: 'tool-ac-33',
        path: 'run.sh',
        artifact: {
          container: 'scratch',
          role: 'scratch',
          title: 'run.sh',
          materialKind: 'script',
          pathSource: 'agent-default'
        }
      })
      expect(result.kind).toBe('ready')
      if (result.kind !== 'ready') return
      const scriptPath = path.join(fixture.workDir, result.prepared.finalPath)
      expect(fs.existsSync(path.dirname(scriptPath))).toBe(false)
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
      fs.writeFileSync(scriptPath, '# reads src/config.json')
      expect(fs.existsSync(path.join(fixture.workDir, 'src', 'config.json'))).toBe(true)
    })

    it('AC-38/AC-40: path type conflict is rejected for file vs directory mismatch', async () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const { resolveOutputPathKind } = await import('./outputPathKind')
      const root = fixture.workDir
      fs.mkdirSync(path.join(root, 'report'), { recursive: true })
      await expect(
        resolveOutputPathKind({ targetPath: path.join(root, 'report'), declaredKind: 'file' })
      ).rejects.toThrow(/ARTIFACT_PATH_TYPE_CONFLICT/)
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

  describe('analysis scenario (AC-06～17, AC-41～43)', () => {
    it('AC-07/AC-09/AC-11: package primary uses explicit paths literally', () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const userMessage = '请写入 `docs/review/review.md` 和 `docs/review/query.sql`'
      const evidence = extractExplicitPathEvidence(userMessage, { requestId: 'ac-07' })
      const reportEvidence = evidence.find((item) => item.rawPath === 'docs/review/review.md')!
      const sqlEvidence = evidence.find((item) => item.rawPath === 'docs/review/query.sql')!
      const report = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-07',
        toolUseId: 'tool-ac-07',
        path: 'docs/review/review.md',
        userMessage,
        artifact: {
          container: 'package',
          role: 'primary',
          packageId: 'pkg-1',
          title: 'Review',
          requestedPath: 'docs/review/review.md',
          pathSource: 'user',
          pathEvidenceId: reportEvidence.evidenceId
        }
      })
      expect(report.kind).toBe('ready')
      if (report.kind !== 'ready') return
      expect(report.prepared.finalPath).toBe('docs/review/review.md')

      const sql = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-07',
        toolUseId: 'tool-ac-12',
        path: 'docs/review/query.sql',
        userMessage,
        artifact: {
          container: 'package',
          role: 'supporting',
          packageId: 'pkg-1',
          materialKind: 'query',
          title: 'query',
          requestedPath: 'docs/review/query.sql',
          pathSource: 'user',
          pathEvidenceId: sqlEvidence.evidenceId
        }
      })
      expect(sql.kind).toBe('ready')
      if (sql.kind !== 'ready') return
      expect(sql.prepared.finalPath).toBe('docs/review/query.sql')
    })

    it('AC-15: supporting SQL derives into .materials via repository package primary', () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      new ArtifactRepository(fixture.db).create({
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
      const result = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-15',
        toolUseId: 'tool-ac-15',
        path: 'ignored.sql',
        db: fixture.db,
        artifact: {
          container: 'package',
          role: 'supporting',
          packageId: 'pkg-1',
          materialKind: 'query',
          title: 'analysis',
          pathSource: 'agent-default'
        }
      })
      expect(result.kind).toBe('ready')
      if (result.kind !== 'ready') return
      expect(result.prepared.finalPath).toBe('reports/final.materials/analysis.sql')
    })

    it('AC-10: missing package location requests output-location and resume completes write', async () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const result = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-10',
        toolUseId: 'tool-ac-10',
        path: '',
        artifact: {
          container: 'package',
          role: 'primary',
          packageId: 'pkg-new',
          title: 'Report',
          pathSource: 'agent-default'
        }
      })
      expect(result.kind).toBe('decision_required')
      if (result.kind !== 'decision_required') return
      expect(result.decisionKind).toBe('output-location')
      expect(buildArtifactDecisionOptions('output-location').map((o) => o.key)).toContain('custom')

      const { resumeArtifactToolWriteAfterDecision } = await import('./toolLoopArtifactFlow')
      const resumed = await resumeArtifactToolWriteAfterDecision({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-10',
        toolUseId: 'tool-ac-10',
        path: '',
        decisionId: result.decisionId,
        decisionKind: 'output-location',
        attempt: result.attempt,
        previousFinalPath: result.previousFinalPath,
        choice: 'change-directory:reports/ac10',
        artifact: {
          container: 'package',
          role: 'primary',
          packageId: 'pkg-new',
          title: 'Report',
          pathSource: 'agent-default'
        }
      })
      expect(resumed.kind).toBe('ready')
      if (resumed.kind === 'ready') {
        expect(resumed.prepared.finalPath).toBe('reports/ac10/report.md')
      }
    })

    it('AC-41: ordinary retrieval does not retain reference artifacts', () => {
      expect(resolveReferenceRetention({ mode: 'retrieve' })).toEqual({ kind: 'none' })
      expect(resolveReferenceRetention({ mode: 'short-summary' })).toEqual({ kind: 'none' })
    })

    it('AC-43: unassociated save requests long-term/pending/cancel decision', () => {
      expect(resolveReferenceRetention({ mode: 'save' })).toEqual({
        kind: 'reference-retention',
        choices: ['long-term', 'pending', 'cancel']
      })
    })

    it('AC-42: package-associated reference routes to materials directory', () => {
      expect(resolveReferenceRetention({ mode: 'long-term', packageId: 'pkg-1' })).toEqual({
        kind: 'package-reference',
        packageId: 'pkg-1'
      })
    })
  })

  describe('research writing scenario (AC-18～21, AC-26～28, AC-44)', () => {
    it('AC-18/AC-19: continuous draft.md edits reuse artifactId via prepareArtifactToolWrite', () => {
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const repository = new ArtifactRepository(fixture.db)
      repository.create({
        id: 'draft-1',
        sessionId: fixture.session.id,
        workDirProfileId: fixture.profile.id,
        workspaceRootReal: fixture.workDir,
        container: 'package',
        role: 'primary',
        packageId: 'pkg-draft',
        title: 'Draft',
        canonicalPath: 'draft.md',
        pathIdentityKey: 'draft-id',
        pathSource: 'agent-default'
      })
      const first = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-18-a',
        toolUseId: 'tool-a',
        path: 'draft.md',
        db: fixture.db,
        artifact: {
          container: 'package',
          role: 'primary',
          packageId: 'pkg-draft',
          title: 'Draft',
          requestedPath: 'draft.md',
          pathSource: 'agent-default'
        }
      })
      expect(first.kind).toBe('ready')
      if (first.kind !== 'ready') return
      expect(first.prepared.finalPath).toBe('draft.md')

      const second = prepareArtifactToolWrite({
        workDir: fixture.workDir,
        sessionId: fixture.session.id,
        requestId: 'ac-18-b',
        toolUseId: 'tool-b',
        path: 'other.md',
        db: fixture.db,
        artifact: {
          container: 'package',
          role: 'primary',
          packageId: 'pkg-draft',
          artifactId: 'draft-1',
          title: 'Draft',
          requestedPath: 'other.md',
          pathSource: 'agent-default'
        }
      })
      expect(second.kind).toBe('ready')
      if (second.kind !== 'ready') return
      expect(second.prepared.finalPath).toBe('draft.md')
    })

    it('AC-21/AC-26: session clean skips pending references by default', async () => {
      const { cleanArtifactSession } = await import('./artifactCleanSession')
      const { getSharedArtifactPathLeaseRegistry } = await import('./toolPathLease')
      const fixture = createArtifactTestFixture()
      fixtures.push(fixture)
      const repository = new ArtifactRepository(fixture.db)
      const scratchPath = path.join(fixture.workDir, '.spaceassistant/runs/s1/note/pending.md')
      fs.mkdirSync(path.dirname(scratchPath), { recursive: true })
      fs.writeFileSync(scratchPath, 'pending')
      repository.create({
        id: 'scratch-1',
        sessionId: fixture.session.id,
        workDirProfileId: fixture.profile.id,
        workspaceRootReal: fixture.workDir,
        container: 'scratch',
        role: 'scratch',
        title: 'Scratch',
        canonicalPath: scratchPath,
        pathIdentityKey: scratchPath,
        pathSource: 'system-assigned'
      })
      const refPath = path.join(fixture.workDir, 'refs/pending.pdf')
      fs.mkdirSync(path.dirname(refPath), { recursive: true })
      fs.writeFileSync(refPath, 'pdf')
      repository.create({
        id: 'ref-1',
        sessionId: fixture.session.id,
        workDirProfileId: fixture.profile.id,
        workspaceRootReal: fixture.workDir,
        container: 'project',
        role: 'reference',
        title: 'Pending ref',
        canonicalPath: refPath,
        pathIdentityKey: refPath,
        pathSource: 'agent-default',
        stage: 'pending'
      })
      const result = await cleanArtifactSession({
        repository,
        registry: getSharedArtifactPathLeaseRegistry(),
        sessionId: fixture.session.id,
        workDir: fixture.workDir,
        includeReferences: false
      })
      expect(result.deleted).toContain('scratch-1')
      expect(result.skipped.some((item) => item.id === 'ref-1')).toBe(true)
    })

    it('AC-44: agent-suggested reference retention requires explicit decision', () => {
      expect(resolveReferenceRetention({ mode: 'save' }).kind).toBe('reference-retention')
    })

    it('AC-28: change cursor tracks staged draft updates for completion summary', () => {
      const cursor = new ArtifactChangeCursor('req-draft')
      cursor.record({
        requestId: 'req-draft',
        success: true,
        artifactId: 'draft-1',
        container: 'package',
        role: 'primary',
        finalPath: 'draft.md',
        stage: 'draft'
      })
      cursor.record({
        requestId: 'req-draft',
        success: true,
        artifactId: 'draft-1',
        container: 'package',
        role: 'primary',
        finalPath: 'draft.md',
        stage: 'final'
      })
      const summary = buildArtifactCompletionSummary(cursor.entries())
      expect(summary.package).toHaveLength(2)
      expect(summary.package[1]).toEqual({ finalPath: 'draft.md', stage: 'final' })
    })
  })
})
