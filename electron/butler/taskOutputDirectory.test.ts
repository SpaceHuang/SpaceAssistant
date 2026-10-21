import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { ensureAutomationRunOutputDirectory, isValidAutomationRunOutputScope, matchesAutomationRunOutputWriteTarget, matchesBoundOutputWriteTarget, resolveAutomationRunOutputDir, resolveBoundOutputTarget } from './taskOutputDirectory'
import type { TargetBinding } from '../../src/shared/automationTaskTypes'

describe('resolveAutomationRunOutputDir', () => {
  it('uses the selected directory directly for direct output', () => {
    expect(resolveAutomationRunOutputDir('/results', 'direct', new Date(2026, 9, 18, 17, 42).getTime())).toBe('/results')
  })

  it('uses the scheduled local date for daily output', () => {
    const scheduledFor = new Date(2026, 9, 18, 23, 59).getTime()
    expect(resolveAutomationRunOutputDir('/results', 'daily', scheduledFor)).toBe(path.join('/results', '20261018'))
  })

  it('uses the scheduled local date and hour for hourly output', () => {
    const scheduledFor = new Date(2026, 9, 18, 7, 4).getTime()
    expect(resolveAutomationRunOutputDir('/results', 'hourly', scheduledFor)).toBe(path.join('/results', '20261018-07'))
  })

  it('remaps a preflight-bound relative result path into the run archive directory', () => {
    const binding: Extract<TargetBinding, { kind: 'output' }> = {
      kind: 'output', path: '/results/reports/summary.txt', ancestor: '/results', relativeSuffix: path.join('reports', 'summary.txt'),
      outputRoot: '/results', expectedType: 'file', rawText: 'write summary.txt', resolverVersion: 3, rootsDigest: 'output-digest', taskRevision: 8,
    }
    expect(resolveBoundOutputTarget(binding, '/results/20261018-07')).toBe('/results/20261018-07/reports/summary.txt')
  })

  it('matches only file descendants of a preflight-bound output directory', () => {
    const binding: Extract<TargetBinding, { kind: 'output' }> = {
      kind: 'output', path: '/results/reports', ancestor: '/results', relativeSuffix: 'reports',
      outputRoot: '/results', expectedType: 'directory', rawText: 'save results in reports', resolverVersion: 3,
      rootsDigest: 'output-digest', taskRevision: 8,
    }
    expect(matchesBoundOutputWriteTarget(binding, '/results/20261018-07', '/results/20261018-07/reports/summary.txt')).toBe(true)
    expect(matchesBoundOutputWriteTarget(binding, '/results/20261018-07', '/results/20261018-07/reports/nested/summary.txt')).toBe(true)
    expect(matchesBoundOutputWriteTarget(binding, '/results/20261018-07', '/results/20261018-07/reports')).toBe(false)
    expect(matchesBoundOutputWriteTarget(binding, '/results/20261018-07', '/results/20261018-07/private.txt')).toBe(false)
  })

  it('file binding allows only its exact target', () => {
    const binding: Extract<TargetBinding, { kind: 'output' }> = {
      kind: 'output', path: '/results/summary.txt', ancestor: '/results', relativeSuffix: 'summary.txt',
      outputRoot: '/results', expectedType: 'file', rawText: 'write summary', resolverVersion: 3,
      rootsDigest: 'output-digest', taskRevision: 8,
    }
    expect(matchesBoundOutputWriteTarget(binding, '/results/20261018-07', '/results/20261018-07/summary.txt')).toBe(true)
    expect(matchesBoundOutputWriteTarget(binding, '/results/20261018-07', '/results/20261018-07/other.txt')).toBe(false)
  })

  it('rejects a tampered output binding that escapes the selected output root', () => {
    const binding: Extract<TargetBinding, { kind: 'output' }> = {
      kind: 'output', path: '/results/../private.txt', ancestor: '/results', relativeSuffix: '../private.txt',
      outputRoot: '/results', expectedType: 'file', rawText: 'write file', resolverVersion: 3, rootsDigest: 'output-digest', taskRevision: 8,
    }
    expect(() => resolveBoundOutputTarget(binding, '/results/20261018-07')).toThrow('OUTPUT_PATH_ESCAPE')
  })
})

describe('ensureAutomationRunOutputDirectory', () => {
  it('creates only the date archive below the selected output root', async () => {
    const outputRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-output-root-')))
    const scheduledFor = new Date(2026, 9, 18, 7, 0).getTime()
    try {
      const runOutputDir = await ensureAutomationRunOutputDirectory(outputRoot, 'daily', scheduledFor)
      expect(runOutputDir).toBe(path.join(outputRoot, '20261018'))
      expect((await fs.lstat(runOutputDir)).isDirectory()).toBe(true)
      expect(await fs.readdir(outputRoot)).toEqual(['20261018'])
    } finally {
      await fs.rm(outputRoot, { recursive: true, force: true })
    }
  })

  it('rejects a non-directory archive path and leaves the selected root intact', async () => {
    const outputRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-output-root-')))
    const scheduledFor = new Date(2026, 9, 18, 7, 0).getTime()
    const archivePath = path.join(outputRoot, '20261018')
    await fs.writeFile(archivePath, 'occupied')
    try {
      await expect(ensureAutomationRunOutputDirectory(outputRoot, 'daily', scheduledFor)).rejects.toThrow('OUTPUT_DIRECTORY_COMPONENT_INVALID')
      expect(await fs.readFile(archivePath, 'utf8')).toBe('occupied')
    } finally {
      await fs.rm(outputRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects an archive symlink that points outside the selected output root', async () => {
    const outputRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-output-root-')))
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-output-outside-')))
    const scheduledFor = new Date(2026, 9, 18, 7, 0).getTime()
    const archivePath = path.join(outputRoot, '20261018')
    await fs.symlink(outside, archivePath, 'dir')
    try {
      await expect(ensureAutomationRunOutputDirectory(outputRoot, 'daily', scheduledFor)).rejects.toThrow('OUTPUT_DIRECTORY_COMPONENT_INVALID')
      expect(await fs.readdir(outside)).toEqual([])
    } finally {
      await fs.rm(outputRoot, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('automation run output scope', () => {
  const scheduledFor = new Date(2026, 9, 18, 7, 0).getTime()
  const scope = {
    outputDirectory: '/results', organization: 'daily' as const, scheduledFor,
    runOutputDir: '/results/20261018', taskRevision: 4
  }

  it('validates the archive directory derived from the approved root and strategy', () => {
    expect(isValidAutomationRunOutputScope(scope)).toBe(true)
    expect(isValidAutomationRunOutputScope({ ...scope, runOutputDir: '/results/other' })).toBe(false)
    expect(isValidAutomationRunOutputScope({ ...scope, outputDirectory: '/other' })).toBe(false)
  })

  it('allows file targets only under the validated run directory and rejects escapes or aliased parents', () => {
    expect(matchesAutomationRunOutputWriteTarget(scope, {
      normalizedPath: '/results/20261018/report.md', parentReal: '/results/20261018', targetKind: 'missing', zone: 'outside-workdir'
    } as never)).toBe(true)
    expect(matchesAutomationRunOutputWriteTarget(scope, {
      normalizedPath: '/results/20261018/nested/report.md', parentReal: '/results/20261018/nested', targetKind: 'file', zone: 'outside-workdir'
    } as never)).toBe(true)
    expect(matchesAutomationRunOutputWriteTarget(scope, {
      normalizedPath: '/results/other/report.md', parentReal: '/results/other', targetKind: 'missing', zone: 'outside-workdir'
    } as never)).toBe(false)
    expect(matchesAutomationRunOutputWriteTarget(scope, {
      normalizedPath: '/private/report.md', parentReal: '/private', targetKind: 'missing', zone: 'outside-workdir'
    } as never)).toBe(false)
    expect(matchesAutomationRunOutputWriteTarget(scope, {
      normalizedPath: '/results/20261018', parentReal: '/results', targetKind: 'directory', zone: 'outside-workdir'
    } as never)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('uses case-sensitive POSIX path boundaries for output write authorization', () => {
    const posixScope = {
      outputDirectory: '/data/Reports', organization: 'direct' as const, scheduledFor,
      runOutputDir: '/data/Reports', taskRevision: 4
    }
    expect(matchesAutomationRunOutputWriteTarget(posixScope, {
      normalizedPath: '/data/reports/result.md', parentReal: '/data/reports', targetKind: 'missing', zone: 'outside-workdir'
    } as never)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('treats backslashes as literal characters in POSIX paths', () => {
    const posixScope = {
      outputDirectory: '/data/Reports\\private', organization: 'direct' as const, scheduledFor,
      runOutputDir: '/data/Reports\\private', taskRevision: 4
    }
    expect(matchesAutomationRunOutputWriteTarget(posixScope, {
      normalizedPath: '/data/Reports/private/result.md', parentReal: '/data/Reports/private', targetKind: 'missing', zone: 'outside-workdir'
    } as never)).toBe(false)
  })
})
