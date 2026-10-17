import { describe, expect, it } from 'vitest'
import type { AutomationTask, AutomationTaskInput, ButlerTaskWriteResult, PreflightReport, TargetBinding } from './automationTaskTypes'

describe('automation task compatibility contracts', () => {
  it('keeps legacy single-root tasks readable without inventing a work root', () => {
    const legacy: AutomationTask = {
      id: 'legacy', name: 'legacy', schedule: { kind: 'daily', time: '09:00' }, prompt: 'run',
      deliveryPref: 'none', enabled: true, createdAt: 1, updatedAt: 1, workDir: '/legacy/root',
      preflightVersion: 0, targetBindingsJson: null,
    }
    const missing: AutomationTask = { ...legacy, id: 'missing', workDir: undefined }
    expect(legacy.workDirs).toBeUndefined()
    expect(missing.workDirs).toBeUndefined()
  })

  it('supports explicit multiple roots during the compatibility period', () => {
    const input: AutomationTaskInput = {
      name: 'multi', schedule: { kind: 'once', at: 100 }, prompt: 'summarize files',
      deliveryPref: 'none', workDirs: ['/a', '/b'],
    }
    expect(input.workDirs).toEqual(['/a', '/b'])
  })

  it('models discriminated target bindings and preflight outcomes', () => {
    const binding: TargetBinding = {
      kind: 'collection', directory: '/data', selector: '*.csv', sort: 'canonical-path',
      rawText: 'all CSV files in /data', resolverVersion: 1, rootsDigest: 'digest', taskRevision: 2,
    }
    const report: PreflightReport = { status: 'blocked', blockers: [{ code: 'target-ambiguous', messageKey: 'config:preflight.ambiguous', field: 'prompt' }], suggestedDirectories: [] }
    const blocked: ButlerTaskWriteResult = { ok: false, kind: 'preflight-blocked', report }
    expect(binding.kind).toBe('collection')
    expect(blocked.ok && blocked.id).toBe(false)
  })
})

import { getAutomationTaskWorkDirs } from './automationTaskTypes'

describe('getAutomationTaskWorkDirs', () => {
  it('uses explicit roots, adapts one legacy root, and never invents a root', () => {
    expect(getAutomationTaskWorkDirs({ workDirs: ['/a', '/b'], workDir: '/legacy' })).toEqual(['/a', '/b'])
    expect(getAutomationTaskWorkDirs({ workDir: '/legacy' })).toEqual(['/legacy'])
    expect(getAutomationTaskWorkDirs({})).toEqual([])
    expect(getAutomationTaskWorkDirs({ workDirs: [] })).toEqual([])
    expect(getAutomationTaskWorkDirs({ workDirs: [], workDir: '/legacy' })).toEqual([])
  })

  it('returns a defensive copy of canonical roots', () => {
    const roots = ['/a']
    const adapted = getAutomationTaskWorkDirs({ workDirs: roots })
    adapted.push('/mutated')
    expect(roots).toEqual(['/a'])
  })
})
