import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionStorageCleanupReleaseGateInput } from '../runtime/sessionStorageCleanupReleaseConfig'
import { evaluateSessionStorageCleanupReleaseGate, getSessionStorageCleanupCompatibilityRecordSha256 } from '../runtime/sessionStorageCleanupReleaseGate'

const { writeSessionStorageBuildIdentity, writeSessionStorageCleanupReleaseMetadata } = require('../../scripts/after-pack.cjs') as {
  writeSessionStorageBuildIdentity: (context: unknown, runGit?: (...args: unknown[]) => string) => unknown
  writeSessionStorageCleanupReleaseMetadata: (context: unknown, identity: unknown) => void
}

const tempDirectories: string[] = []
const version = '0.2.5'
const candidateSha = 'c'.repeat(40)
const record = {
  formatVersion: 1,
  decision: 'accepted',
  review: { reference: 'isolated-drill-only', reviewedAt: '2026-10-04T00:00:00.000Z' },
  candidate: {
    version,
    commitSha: candidateSha,
    schemaVersion: 50,
    historyFormatVersion: 1,
    spillFormatVersion: 1,
  },
  rollback: {
    version: '0.2.4',
    commitSha: 'b'.repeat(40),
    maxReadableSchemaVersion: 50,
    historyFormatVersions: [1],
    spillFormatVersions: [1],
    canonicalOnlyReader: true,
    cleanupStates: ['write-stopped', 'pending', 'complete'],
    artifacts: {
      'linux-x64': { downloadUrl: 'file:///tmp/rollback-linux-x64.AppImage', sha256: 'a'.repeat(64) },
      'mac-arm64': { downloadUrl: 'file:///tmp/rollback-mac-arm64.dmg', sha256: 'b'.repeat(64) },
    },
  },
} as const

function createFixture(withReleaseInput = true) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-cleanup-release-'))
  tempDirectories.push(projectDir)
  const appOutDir = path.join(projectDir, 'app-out')
  fs.mkdirSync(appOutDir)
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ version }))
  if (withReleaseInput) {
    const inputDir = path.join(projectDir, 'release-input')
    fs.mkdirSync(inputDir)
    fs.writeFileSync(path.join(inputDir, 'session-storage-cleanup-deployment.json'), JSON.stringify({
      formatVersion: 1,
      allowContentCleanup: true,
      compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(record),
    }))
    fs.writeFileSync(path.join(inputDir, 'session-storage-cleanup-compatibility.json'), JSON.stringify(record))
  }
  const context = {
    electronPlatformName: 'linux',
    arch: 'x64',
    appOutDir,
    packager: { info: { projectDir }, appInfo: { productFilename: 'SpaceAssistant' } },
  }
  const identity = { formatVersion: 2, version, commitSha: candidateSha, sourceTreeClean: true,
    buildId: 'b'.repeat(36), target: { platform: 'mac', arch: 'arm64' } }
  return { projectDir, appOutDir, context, identity }
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('afterPack cleanup release metadata injection', () => {
  it('injects a post-commit candidate record into the bundle and authorizes its exact target', () => {
    const fixture = createFixture()
    const identity = writeSessionStorageBuildIdentity(fixture.context,
      (_command: unknown, args: unknown[]) => args[0] === 'status' ? '' : candidateSha)
    writeSessionStorageCleanupReleaseMetadata(fixture.context, identity)

    const resourcesPath = path.join(fixture.appOutDir, 'resources')
    const input = readSessionStorageCleanupReleaseGateInput({
      resourcesPath,
      appVersion: version,
      schemaVersion: 50,
      historyFormatVersion: 1,
      spillFormatVersion: 1,
      platform: 'linux',
      arch: 'x64',
    })
    expect(evaluateSessionStorageCleanupReleaseGate(input)).toEqual({ allowed: true, reason: 'authorized' })
    expect(JSON.parse(fs.readFileSync(path.join(resourcesPath, 'session-storage-cleanup-compatibility.json'), 'utf8')))
      .toMatchObject({ candidate: { commitSha: candidateSha, version } })
  })

  it('writes default-off metadata when no controlled release input is supplied', () => {
    const fixture = createFixture(false)
    writeSessionStorageCleanupReleaseMetadata(fixture.context, fixture.identity)
    const resourcesPath = path.join(fixture.appOutDir, 'resources')
    expect(JSON.parse(fs.readFileSync(path.join(resourcesPath, 'session-storage-cleanup-deployment.json'), 'utf8')))
      .toEqual({ formatVersion: 1, allowContentCleanup: false, compatibilityRecordSha256: null })
    expect(fs.readFileSync(path.join(resourcesPath, 'session-storage-cleanup-compatibility.json'), 'utf8')).toBe('null\n')
  })

  it('keeps the source tree clean when post-commit release input is placed in the dedicated ignored directory', () => {
    const fixture = createFixture(false)
    fs.writeFileSync(path.join(fixture.projectDir, '.gitignore'), '/release-input/\n')
    execFileSync('git', ['init', '-q'], { cwd: fixture.projectDir })
    execFileSync('git', ['config', 'user.name', 'Cleanup metadata test'], { cwd: fixture.projectDir })
    execFileSync('git', ['config', 'user.email', 'cleanup-metadata-test@localhost'], { cwd: fixture.projectDir })
    execFileSync('git', ['add', 'package.json', '.gitignore'], { cwd: fixture.projectDir })
    execFileSync('git', ['commit', '-qm', 'fixed C candidate source'], { cwd: fixture.projectDir })
    const inputDir = path.join(fixture.projectDir, 'release-input')
    fs.mkdirSync(inputDir)
    fs.writeFileSync(path.join(inputDir, 'session-storage-cleanup-deployment.json'), '{}')
    fs.writeFileSync(path.join(inputDir, 'session-storage-cleanup-compatibility.json'), 'null')

    const identity = writeSessionStorageBuildIdentity(fixture.context)
    expect(identity).toMatchObject({ sourceTreeClean: true })
    expect((identity as { commitSha: string }).commitSha).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.projectDir, encoding: 'utf8' }).trim(),
    )
  })

  it('rejects self-reference candidates that do not match the fixed source commit', () => {
    const fixture = createFixture()
    const mismatchedIdentity = { ...fixture.identity, commitSha: 'd'.repeat(40) }
    expect(() => writeSessionStorageCleanupReleaseMetadata(fixture.context, mismatchedIdentity))
      .toThrow(/candidate commit does not match packaged source HEAD/)
  })

  it('rejects an enabled package without a rollback artifact for its platform and architecture', () => {
    const fixture = createFixture()
    const inputPath = path.join(fixture.projectDir, 'release-input', 'session-storage-cleanup-compatibility.json')
    const incomplete = structuredClone(record) as { rollback: { artifacts: Record<string, unknown> } }
    incomplete.rollback.artifacts = {}
    fs.writeFileSync(inputPath, JSON.stringify(incomplete))
    const deploymentPath = path.join(fixture.projectDir, 'release-input', 'session-storage-cleanup-deployment.json')
    const deployment = {
      formatVersion: 1,
      allowContentCleanup: true,
      compatibilityRecordSha256: getSessionStorageCleanupCompatibilityRecordSha256(incomplete as never),
    }
    fs.writeFileSync(deploymentPath, JSON.stringify(deployment))

    expect(() => writeSessionStorageCleanupReleaseMetadata(fixture.context, fixture.identity))
      .toThrow(/rollback artifact missing for linux-x64/)
  })

  it('uses the same normalized platform key that the runtime gate will request on macOS', () => {
    const fixture = createFixture()
    const macContext = { ...fixture.context, electronPlatformName: 'darwin', arch: 'arm64' }
    expect(() => writeSessionStorageCleanupReleaseMetadata(macContext, fixture.identity)).not.toThrow()
    expect(fs.existsSync(path.join(fixture.appOutDir, 'SpaceAssistant.app', 'Contents', 'Resources',
      'session-storage-cleanup-compatibility.json'))).toBe(true)
  })
})
