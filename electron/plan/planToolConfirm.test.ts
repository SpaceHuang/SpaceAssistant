import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_CONFIG } from '../../src/shared/domainTypes'
import { shouldSkipToolConfirm } from './planToolConfirm'
import type { PlanMeta } from '../../src/shared/planTypes'
import {
  clearAllProvenanceContexts,
  getOrCreateProvenanceContext,
  recordReadFileForProvenance
} from './runScriptProvenance'

const executingPlan: PlanMeta = {
  planId: 'p1',
  status: 'executing',
  planFilePath: 'plans/a.md',
  currentStepIndex: 0,
  stepsTotal: 3,
  version: 1,
  createdAt: 1,
  approvedAt: 2,
  cancelledAt: null,
  envSnapshot: { gitHead: null, timestamp: 1 }
}

describe('shouldSkipToolConfirm', () => {
  it('skips write_file in implementation + executing + confirm_high_risk', () => {
    expect(
      shouldSkipToolConfirm({
        planToolPhase: 'implementation',
        planMeta: executingPlan,
        policy: 'confirm_high_risk',
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        provenance: null,
        planConfig: DEFAULT_PLAN_CONFIG
      })
    ).toBe(true)
  })

  it('does not skip in planning phase', () => {
    expect(
      shouldSkipToolConfirm({
        planToolPhase: 'planning',
        planMeta: executingPlan,
        policy: 'confirm_high_risk',
        toolName: 'write_file',
        toolInput: {},
        provenance: null,
        planConfig: DEFAULT_PLAN_CONFIG
      })
    ).toBe(false)
  })

  it('does not skip external run_script when auto-approve enabled', () => {
    clearAllProvenanceContexts()
    const provenance = getOrCreateProvenanceContext('r1')
    const code = 'print(1)'
    recordReadFileForProvenance(provenance, 'legacy.py', code)
    expect(
      shouldSkipToolConfirm({
        planToolPhase: 'implementation',
        planMeta: executingPlan,
        policy: 'confirm_high_risk',
        toolName: 'run_script',
        toolInput: { code },
        provenance,
        planConfig: DEFAULT_PLAN_CONFIG
      })
    ).toBe(false)
  })

  it('skips inline run_script when auto-approve enabled', () => {
    clearAllProvenanceContexts()
    const provenance = getOrCreateProvenanceContext('r2')
    expect(
      shouldSkipToolConfirm({
        planToolPhase: 'implementation',
        planMeta: executingPlan,
        policy: 'confirm_high_risk',
        toolName: 'run_script',
        toolInput: { code: 'import os\nos.makedirs("x")' },
        provenance,
        planConfig: DEFAULT_PLAN_CONFIG
      })
    ).toBe(true)
  })

  it('always_confirm never skips', () => {
    expect(
      shouldSkipToolConfirm({
        planToolPhase: 'implementation',
        planMeta: executingPlan,
        policy: 'always_confirm',
        toolName: 'write_file',
        toolInput: {},
        provenance: null,
        planConfig: DEFAULT_PLAN_CONFIG
      })
    ).toBe(false)
  })
})
