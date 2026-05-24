import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, createSession, getSession } from '../database'
import type { AppDatabase } from '../database'
import type { PlanMeta } from '../../src/shared/planTypes'
import {
  SESSION_META_DISPLAY_PLANS,
  SESSION_META_PENDING_PLAN,
  SESSION_META_PLAN,
  getDisplayPlans,
  getPendingPlanMeta,
  getPlanMeta
} from '../../src/shared/planTypes'
import {
  applyPlanDocToSession,
  approvePlanInSession,
  mergeDisplayPlansOnApprove,
  readPlanStateForSession,
  rejectPlanInSession
} from './planManager'
import { plansDirAbs } from './planPaths'

const SAMPLE_PLAN = `---
plan_id: plan-test
version: 1
---

# 计划：测试

## 3. 推荐方案
方案 A

## 4. 执行步骤
- [ ] 步骤一
`

function basePlanMeta(overrides: Partial<PlanMeta> = {}): PlanMeta {
  return {
    planId: 'plan-1',
    status: 'executing',
    planFilePath: '.spaceassistant/plans/test.md',
    currentStepIndex: 2,
    stepsTotal: 5,
    version: 1,
    createdAt: 1000,
    approvedAt: 2000,
    cancelledAt: null,
    envSnapshot: { gitHead: null, timestamp: 2000 },
    ...overrides
  }
}

describe('mergeDisplayPlansOnApprove', () => {
  it('prepends new plan when all existing are completed', () => {
    const existing = [
      {
        planId: 'old',
        planFilePath: 'a.md',
        title: '旧',
        status: 'completed' as const,
        version: 1,
        createdAt: 1,
        approvedAt: 2,
        currentStepIndex: 5,
        stepsTotal: 5
      }
    ]
    const neu = { ...existing[0]!, planId: 'new', title: '新', status: 'approved' as const }
    const merged = mergeDisplayPlansOnApprove(existing, neu, { cancelExecuting: false })
    expect(merged[0]!.planId).toBe('new')
    expect(merged[1]!.planId).toBe('old')
  })

  it('cancels executing and appends when cancelExecuting', () => {
    const existing = [
      {
        planId: 'run',
        planFilePath: 'r.md',
        title: '执行中',
        status: 'executing' as const,
        version: 1,
        createdAt: 1,
        approvedAt: 2,
        currentStepIndex: 2,
        stepsTotal: 5
      }
    ]
    const neu = { ...existing[0]!, planId: 'new', title: '新', status: 'approved' as const }
    const merged = mergeDisplayPlansOnApprove(existing, neu, { cancelExecuting: true })
    expect(merged[0]!.status).toBe('cancelled')
    expect(merged[1]!.planId).toBe('new')
  })
})

describe('planManager session flows', () => {
  let db: AppDatabase
  let workDir: string
  let sessionId: string
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-plan-test-'))
    workDir = path.join(tmpRoot, 'work')
    await fs.mkdir(workDir, { recursive: true })
    await fs.mkdir(plansDirAbs(workDir), { recursive: true })
    db = openDatabase(path.join(tmpRoot, 'db.json'))
    const session = createSession(db, { name: 'test' })
    sessionId = session.id
  })

  afterEach(async () => {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('applyPlanDoc writes pending_plan without clearing display snapshot', async () => {
    const executing = basePlanMeta()
    const display = [
      {
        planId: executing.planId,
        planFilePath: executing.planFilePath,
        title: '执行中计划',
        status: 'executing' as const,
        version: 1,
        createdAt: 1,
        approvedAt: 2,
        currentStepIndex: 2,
        stepsTotal: 5
      }
    ]
    const session = getSession(db, sessionId)!
    const metadata = {
      ...session.metadata,
      [SESSION_META_PLAN]: executing,
      [SESSION_META_DISPLAY_PLANS]: display
    }
    const { updateSession } = await import('../database')
    updateSession(db, sessionId, { metadata })

    await applyPlanDocToSession({
      db,
      sessionId,
      workDir,
      planDocMarkdown: SAMPLE_PLAN
    })

    const updated = getSession(db, sessionId)!
    expect(getPendingPlanMeta(updated.metadata)?.status).toBe('awaiting_approval')
    expect(getPlanMeta(updated.metadata)?.planId).toBe('plan-1')
    expect(getDisplayPlans(updated.metadata)).toHaveLength(1)
  })

  it('reject clears pending_plan and keeps display_plans', async () => {
    await applyPlanDocToSession({ db, sessionId, workDir, planDocMarkdown: SAMPLE_PLAN })
    const before = getSession(db, sessionId)!
    const displayLen = getDisplayPlans(before.metadata).length

    await rejectPlanInSession({
      db,
      sessionId,
      workDir,
      feedback: '需要更多细节'
    })

    const after = getSession(db, sessionId)!
    expect(getPendingPlanMeta(after.metadata)).toBeUndefined()
    expect(getDisplayPlans(after.metadata)).toHaveLength(displayLen)
  })

  it('approve with completed old plan puts new on top', async () => {
    const completed = basePlanMeta({ status: 'completed', currentStepIndex: 5 })
    const { updateSession } = await import('../database')
    updateSession(db, sessionId, {
      metadata: {
        [SESSION_META_PLAN]: completed,
        [SESSION_META_DISPLAY_PLANS]: [
          {
            planId: completed.planId,
            planFilePath: completed.planFilePath,
            title: '已完成',
            status: 'completed',
            version: 1,
            createdAt: 1,
            approvedAt: 2,
            currentStepIndex: 5,
            stepsTotal: 5
          }
        ]
      }
    })

    await applyPlanDocToSession({ db, sessionId, workDir, planDocMarkdown: SAMPLE_PLAN })
    const result = await approvePlanInSession({ db, sessionId, workDir })
    expect(result.autoExecute).toBe(true)
    const after = getSession(db, sessionId)!
    const list = getDisplayPlans(after.metadata)
    expect(list[0]!.title).toContain('测试')
    expect(list.some((p) => p.title === '已完成')).toBe(true)
  })

  it('approve throws EXECUTING_CONFLICT without cancelExecuting', async () => {
    const executing = basePlanMeta()
    const { updateSession } = await import('../database')
    updateSession(db, sessionId, {
      metadata: {
        [SESSION_META_PLAN]: executing,
        [SESSION_META_DISPLAY_PLANS]: [
          {
            planId: executing.planId,
            planFilePath: executing.planFilePath,
            title: '执行中',
            status: 'executing',
            version: 1,
            createdAt: 1,
            approvedAt: 2,
            currentStepIndex: 2,
            stepsTotal: 5
          }
        ]
      }
    })
    await applyPlanDocToSession({ db, sessionId, workDir, planDocMarkdown: SAMPLE_PLAN })
    await expect(approvePlanInSession({ db, sessionId, workDir })).rejects.toThrow('EXECUTING_CONFLICT')
  })

  it('migrates legacy completed plan into display_plans on read', async () => {
    const completed = basePlanMeta({ status: 'completed' })
    const { updateSession } = await import('../database')
    updateSession(db, sessionId, {
      metadata: { [SESSION_META_PLAN]: completed }
    })
    await fs.writeFile(path.join(workDir, completed.planFilePath), SAMPLE_PLAN, 'utf8')
    await fs.mkdir(path.dirname(path.join(workDir, completed.planFilePath)), { recursive: true })

    const state = await readPlanStateForSession({ db, workDir, sessionId })
    expect(state.displayPlans.length).toBeGreaterThanOrEqual(1)
    const saved = getSession(db, sessionId)!
    expect(getDisplayPlans(saved.metadata).length).toBeGreaterThanOrEqual(1)
  })
})
