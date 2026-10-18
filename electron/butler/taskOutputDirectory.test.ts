import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchesBoundOutputWriteTarget, resolveAutomationRunOutputDir, resolveBoundOutputTarget } from './taskOutputDirectory'
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
