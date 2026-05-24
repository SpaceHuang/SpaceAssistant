import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import { getSession, updateSession } from '../database'
import type {
  PlanDisplayEntry,
  PlanMeta,
  PlanVersionEntry,
  PlanAbortMeta,
  PlanStepResult
} from '../../src/shared/planTypes'
import type { PlanReadResult } from '../../src/shared/api'
import {
  SESSION_META_PLAN,
  SESSION_META_PENDING_PLAN,
  SESSION_META_DISPLAY_PLANS,
  SESSION_META_PLAN_DRAFTING,
  SESSION_META_PLAN_ABORT,
  SESSION_META_PLAN_ABORT_DISMISSED,
  SESSION_META_PLAN_STEP_RESULTS,
  SESSION_META_PLAN_VERSIONS,
  getPlanAbort,
  getPlanMeta,
  getPendingPlanMeta,
  getDisplayPlans,
  isPlanAbortDismissed,
  isPlanDrafting,
  normalizePlanMeta,
  planMetaToDisplayEntry
} from '../../src/shared/planTypes'
import { plansDirAbs, relPlanPathFromAbs, planFileAbs } from './planPaths'
import { parsePlanMarkdown, countPlanSteps, buildPlanApprovalSummary } from './planParser'
import { captureGitHead } from './planGitSnapshot'

function slugFromTitle(title: string): string {
  const s = title
    .replace(/^#+\s*/, '')
    .replace(/计划[：:]\s*/i, '')
    .trim()
    .slice(0, 40)
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s || 'plan'
}

function todayStamp(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function ensurePlanIdInMarkdown(markdown: string, planId: string, version: number): string {
  const { frontmatter, body } = (() => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(markdown)
    if (!match) return { frontmatter: '', body: markdown }
    return { frontmatter: match[1]!, body: match[2]! }
  })()

  const lines = frontmatter ? frontmatter.split(/\r?\n/) : []
  const setKey = (key: string, val: string) => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`))
    const row = `${key}: ${val}`
    if (i >= 0) lines[i] = row
    else lines.push(row)
  }
  setKey('plan_id', planId)
  setKey('version', String(version))
  setKey('status', 'pending')
  const fm = lines.join('\n')
  return `---\n${fm}\n---\n\n${body}`
}

export async function writePlanMarkdown(workDir: string, markdown: string, existingRelPath?: string): Promise<string> {
  await fs.mkdir(plansDirAbs(workDir), { recursive: true })
  const parsed = parsePlanMarkdown(markdown)
  const planId = parsed.frontmatter.plan_id || `plan-${todayStamp()}-${randomUUID().slice(0, 8)}`
  const version = parsed.frontmatter.version ?? 1
  const content = ensurePlanIdInMarkdown(markdown, planId, version)

  let absPath: string
  if (existingRelPath) {
    absPath = planFileAbs(workDir, existingRelPath)
  } else {
    const base = `${todayStamp()}-${slugFromTitle(parsed.title)}.md`
    absPath = path.join(plansDirAbs(workDir), base)
    let n = 1
    while (true) {
      try {
        await fs.access(absPath)
        absPath = path.join(plansDirAbs(workDir), `${todayStamp()}-${slugFromTitle(parsed.title)}-${n}.md`)
        n++
      } catch {
        break
      }
    }
  }

  await fs.writeFile(absPath, content, 'utf8')
  return relPlanPathFromAbs(workDir, absPath)
}

export async function readPlanFile(workDir: string, relPath: string): Promise<string> {
  const abs = planFileAbs(workDir, relPath)
  return await fs.readFile(abs, 'utf8')
}

export function mergePlanMetadata(
  sessionMetadata: Record<string, unknown>,
  patch: {
    plan?: PlanMeta | null
    pending_plan?: PlanMeta | null
    display_plans?: PlanDisplayEntry[] | null
    plan_drafting?: boolean | null
    plan_abort?: PlanAbortMeta | null
    plan_abort_dismissed?: boolean | null
    plan_versions?: PlanVersionEntry[]
    plan_step_results?: PlanStepResult[]
  }
): Record<string, unknown> {
  const next = { ...sessionMetadata }
  if (patch.plan_drafting !== undefined) {
    if (patch.plan_drafting === null || patch.plan_drafting === false) delete next[SESSION_META_PLAN_DRAFTING]
    else next[SESSION_META_PLAN_DRAFTING] = true
  }
  if (patch.plan !== undefined) {
    if (patch.plan === null) delete next[SESSION_META_PLAN]
    else next[SESSION_META_PLAN] = patch.plan
  }
  if (patch.pending_plan !== undefined) {
    if (patch.pending_plan === null) delete next[SESSION_META_PENDING_PLAN]
    else next[SESSION_META_PENDING_PLAN] = patch.pending_plan
  }
  if (patch.display_plans !== undefined) {
    if (patch.display_plans === null || patch.display_plans.length === 0) delete next[SESSION_META_DISPLAY_PLANS]
    else next[SESSION_META_DISPLAY_PLANS] = patch.display_plans
  }
  if (patch.plan_abort !== undefined) {
    if (patch.plan_abort === null) delete next[SESSION_META_PLAN_ABORT]
    else next[SESSION_META_PLAN_ABORT] = patch.plan_abort
  }
  if (patch.plan_abort_dismissed !== undefined) {
    if (patch.plan_abort_dismissed === null || patch.plan_abort_dismissed === false) {
      delete next[SESSION_META_PLAN_ABORT_DISMISSED]
    } else next[SESSION_META_PLAN_ABORT_DISMISSED] = true
  }
  if (patch.plan_versions !== undefined) {
    next[SESSION_META_PLAN_VERSIONS] = patch.plan_versions
  }
  if (patch.plan_step_results !== undefined) {
    next[SESSION_META_PLAN_STEP_RESULTS] = patch.plan_step_results
  }
  return next
}

function syncDisplayPlanStatus(
  displayPlans: PlanDisplayEntry[],
  planId: string,
  status: PlanMeta['status'],
  patch?: Partial<Pick<PlanDisplayEntry, 'currentStepIndex' | 'stepsTotal' | 'approvedAt'>>
): PlanDisplayEntry[] {
  return displayPlans.map((e) =>
    e.planId === planId ? { ...e, status, ...patch } : e
  )
}

export function mergeDisplayPlansOnApprove(
  existing: PlanDisplayEntry[],
  newEntry: PlanDisplayEntry,
  options: { cancelExecuting: boolean }
): PlanDisplayEntry[] {
  let list = [...existing]
  const hadExecuting = list.some((e) => e.status === 'executing')

  if (options.cancelExecuting && hadExecuting) {
    list = list.map((e) =>
      e.status === 'executing' ? { ...e, status: 'cancelled' as const } : e
    )
    return [...list, newEntry]
  }

  if (list.length === 0) return [newEntry]

  if (hadExecuting) {
    return [...list, newEntry]
  }

  if (list.every((e) => e.status === 'completed')) {
    return [newEntry, ...list]
  }

  return [...list, newEntry]
}

function appendFeedbackToPlanMarkdown(raw: string, feedback: string): string {
  const section = '## 8. 审批反馈'
  const block = `\n\n${section}\n\n- ${feedback.trim()}\n`
  if (raw.includes(section)) {
    return `${raw.trim()}\n- ${feedback.trim()}\n`
  }
  return `${raw.trim()}${block}`
}

async function buildDisplayEntryFromPlan(
  workDir: string,
  plan: PlanMeta
): Promise<PlanDisplayEntry> {
  try {
    const raw = await readPlanFile(workDir, plan.planFilePath)
    const summary = buildPlanApprovalSummary(raw)
    return planMetaToDisplayEntry(plan, { title: summary.title, summaryOneLine: summary.goalSummary })
  } catch {
    return planMetaToDisplayEntry(plan)
  }
}

function emptyPlanReadResult(): PlanReadResult {
  return {
    plan: null,
    pendingPlan: null,
    displayPlans: [],
    planDrafting: false,
    planAbortDismissed: false,
    abort: null,
    summary: null,
    raw: null
  }
}

const CRITICAL_PLAN_FLUSH_STATUSES = new Set(['awaiting_approval', 'executing', 'cancelled'])

function planStatusFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const plan = normalizePlanMeta(metadata[SESSION_META_PLAN])
  return plan?.status
}

export function saveSessionMetadata(
  db: AppDatabase,
  sessionId: string,
  metadata: Record<string, unknown>
): ReturnType<typeof updateSession> {
  const session = getSession(db, sessionId)
  const prevStatus = session ? planStatusFromMetadata(session.metadata) : undefined
  const nextStatus = planStatusFromMetadata(metadata)
  const updated = updateSession(db, sessionId, { metadata })
  if (
    nextStatus &&
    nextStatus !== prevStatus &&
    CRITICAL_PLAN_FLUSH_STATUSES.has(nextStatus)
  ) {
    db.flushSave()
  }
  return updated
}

export async function readPlanStateForSession(args: {
  db: AppDatabase
  workDir: string
  sessionId: string
}): Promise<PlanReadResult> {
  const session = getSession(args.db, args.sessionId)
  if (!session) return emptyPlanReadResult()

  let metadata = { ...session.metadata }
  let plan = getPlanMeta(metadata) ?? null
  let pendingPlan = getPendingPlanMeta(metadata) ?? null
  let displayPlans = getDisplayPlans(metadata)
  let migrated = false

  if (!metadata[SESSION_META_PENDING_PLAN] && plan?.status === 'awaiting_approval') {
    metadata = mergePlanMetadata(metadata, { pending_plan: plan, plan: null })
    plan = null
    pendingPlan = getPendingPlanMeta(metadata) ?? null
    migrated = true
  }

  if (displayPlans.length === 0 && plan) {
    const migratable =
      plan.status === 'executing' || plan.status === 'completed' || plan.status === 'cancelled'
    if (migratable) {
      const entry = await buildDisplayEntryFromPlan(args.workDir, plan)
      displayPlans = [entry]
      metadata = mergePlanMetadata(metadata, { display_plans: displayPlans })
      migrated = true
    }
  }

  if (migrated) {
    saveSessionMetadata(args.db, args.sessionId, metadata)
  }

  const abort = getPlanAbort(metadata) ?? null
  const base: PlanReadResult = {
    plan,
    pendingPlan,
    displayPlans,
    planDrafting: isPlanDrafting(metadata),
    planAbortDismissed: isPlanAbortDismissed(metadata),
    abort,
    summary: null,
    raw: null
  }

  const summaryTarget = pendingPlan ?? (plan?.status === 'awaiting_approval' ? plan : null)
  if (!summaryTarget?.planFilePath) return base

  try {
    const raw = await readPlanFile(args.workDir, summaryTarget.planFilePath)
    const summary = buildPlanApprovalSummary(raw)
    return { ...base, summary, raw }
  } catch {
    return base
  }
}

export async function applyPlanDocToSession(args: {
  db: AppDatabase
  sessionId: string
  workDir: string
  planDocMarkdown: string
  existingPlan?: PlanMeta
}): Promise<PlanMeta> {
  const { db, sessionId, workDir, planDocMarkdown, existingPlan } = args
  const session = getSession(db, sessionId)
  if (!session) throw new Error('Session not found')

  const version = (existingPlan?.version ?? 0) + 1
  const relPath = await writePlanMarkdown(workDir, planDocMarkdown, existingPlan?.planFilePath)
  const raw = await readPlanFile(workDir, relPath)
  const stepsTotal = countPlanSteps(raw)
  const parsed = parsePlanMarkdown(raw)
  const planId = parsed.frontmatter.plan_id || existingPlan?.planId || `plan-${randomUUID()}`

  const planMeta: PlanMeta = {
    planId,
    status: 'awaiting_approval',
    planFilePath: relPath,
    currentStepIndex: 0,
    stepsTotal,
    version,
    createdAt: existingPlan?.createdAt ?? Date.now(),
    approvedAt: null,
    cancelledAt: null,
    envSnapshot: existingPlan?.envSnapshot ?? { gitHead: null, timestamp: Date.now() }
  }

  const versions: PlanVersionEntry[] = [
    ...(Array.isArray(session.metadata[SESSION_META_PLAN_VERSIONS])
      ? (session.metadata[SESSION_META_PLAN_VERSIONS] as PlanVersionEntry[])
      : []),
    { version, createdAt: Date.now() }
  ]

  const activePlan = getPlanMeta(session.metadata)
  const metadata = mergePlanMetadata(session.metadata, {
    pending_plan: planMeta,
    plan: activePlan?.status === 'awaiting_approval' ? null : activePlan ?? null,
    plan_drafting: null,
    plan_abort: null,
    plan_versions: versions
  })

  saveSessionMetadata(db, sessionId, metadata)
  return planMeta
}

export async function applyPlanAbortToSession(args: {
  db: AppDatabase
  sessionId: string
  report: string
  reason?: string
}): Promise<void> {
  const session = getSession(args.db, args.sessionId)
  if (!session) throw new Error('Session not found')

  const abort: PlanAbortMeta = {
    reason: args.reason ?? '',
    report: args.report,
    createdAt: Date.now()
  }

  const metadata = mergePlanMetadata(session.metadata, {
    plan: null,
    plan_abort: abort
  })
  saveSessionMetadata(args.db, args.sessionId, metadata)
}

export async function approvePlanInSession(args: {
  db: AppDatabase
  sessionId: string
  workDir: string
  cancelExecuting?: boolean
}): Promise<{ plan: PlanMeta; autoExecute: boolean }> {
  const session = getSession(args.db, args.sessionId)
  if (!session) throw new Error('Session not found')
  const pending =
    normalizePlanMeta(session.metadata[SESSION_META_PENDING_PLAN]) ??
    (() => {
      const p = normalizePlanMeta(session.metadata[SESSION_META_PLAN])
      return p?.status === 'awaiting_approval' ? p : undefined
    })()
  if (!pending) throw new Error('No pending plan')
  if (pending.status !== 'awaiting_approval') throw new Error(`Plan status is ${pending.status}, cannot approve`)

  const displayPlans = getDisplayPlans(session.metadata)
  const hadExecuting = displayPlans.some((e) => e.status === 'executing')
  if (hadExecuting && !args.cancelExecuting) {
    throw new Error('EXECUTING_CONFLICT')
  }

  const gitHead = await captureGitHead(args.workDir)
  const approvedAt = Date.now()
  const next: PlanMeta = {
    ...pending,
    status: 'approved',
    approvedAt,
    envSnapshot: { gitHead, timestamp: approvedAt }
  }

  const entry = await buildDisplayEntryFromPlan(args.workDir, { ...next, status: 'approved' })
  const mergedDisplay = mergeDisplayPlansOnApprove(displayPlans, entry, {
    cancelExecuting: Boolean(args.cancelExecuting)
  })

  const versions = (Array.isArray(session.metadata[SESSION_META_PLAN_VERSIONS])
    ? (session.metadata[SESSION_META_PLAN_VERSIONS] as PlanVersionEntry[])
    : []
  ).map((v) => (v.version === pending.version ? { ...v, approvalResult: 'approved' as const } : v))

  const metadata = mergePlanMetadata(session.metadata, {
    plan: next,
    pending_plan: null,
    display_plans: mergedDisplay,
    plan_versions: versions
  })
  saveSessionMetadata(args.db, args.sessionId, metadata)

  return { plan: next, autoExecute: !hadExecuting }
}

export async function startPlanExecutionInSession(args: {
  db: AppDatabase
  sessionId: string
  workDir: string
}): Promise<PlanMeta> {
  const session = getSession(args.db, args.sessionId)
  if (!session) throw new Error('Session not found')
  const plan = normalizePlanMeta(session.metadata[SESSION_META_PLAN])
  if (!plan) throw new Error('No active plan')
  if (plan.status !== 'approved' && plan.status !== 'executing') {
    throw new Error(`Plan status is ${plan.status}, cannot start execution`)
  }
  if (plan.status === 'executing') return plan

  const gitHead = await captureGitHead(args.workDir)
  const approvedAt = plan.approvedAt ?? Date.now()
  const next: PlanMeta = {
    ...plan,
    status: 'executing',
    approvedAt,
    envSnapshot: { gitHead, timestamp: Date.now() }
  }

  let displayPlans = getDisplayPlans(session.metadata)
  displayPlans = syncDisplayPlanStatus(displayPlans, plan.planId, 'executing', {
    approvedAt,
    currentStepIndex: plan.currentStepIndex,
    stepsTotal: plan.stepsTotal
  })

  const metadata = mergePlanMetadata(session.metadata, { plan: next, display_plans: displayPlans })
  saveSessionMetadata(args.db, args.sessionId, metadata)
  return next
}

export async function dismissPlanAbortInSession(args: {
  db: AppDatabase
  sessionId: string
}): Promise<void> {
  const session = getSession(args.db, args.sessionId)
  if (!session) throw new Error('Session not found')
  const metadata = mergePlanMetadata(session.metadata, { plan_abort_dismissed: true })
  saveSessionMetadata(args.db, args.sessionId, metadata)
}

export async function rejectPlanInSession(args: {
  db: AppDatabase
  sessionId: string
  workDir: string
  feedback: string
}): Promise<void> {
  const session = getSession(args.db, args.sessionId)
  if (!session) throw new Error('Session not found')
  const pending =
    normalizePlanMeta(session.metadata[SESSION_META_PENDING_PLAN]) ??
    (() => {
      const p = normalizePlanMeta(session.metadata[SESSION_META_PLAN])
      return p?.status === 'awaiting_approval' ? p : undefined
    })()
  if (!pending) throw new Error('No pending plan')

  if (args.feedback.trim() && pending.planFilePath) {
    try {
      const raw = await readPlanFile(args.workDir, pending.planFilePath)
      const updated = appendFeedbackToPlanMarkdown(raw, args.feedback)
      await fs.writeFile(planFileAbs(args.workDir, pending.planFilePath), updated, 'utf8')
    } catch {
      /* 写文件失败不阻塞拒绝 */
    }
  }

  const versions = (Array.isArray(session.metadata[SESSION_META_PLAN_VERSIONS])
    ? (session.metadata[SESSION_META_PLAN_VERSIONS] as PlanVersionEntry[])
    : []
  ).map((v) => (v.version === pending.version ? { ...v, approvalResult: 'rejected' as const } : v))

  const metadata = mergePlanMetadata(session.metadata, {
    pending_plan: null,
    plan_versions: versions
  })
  saveSessionMetadata(args.db, args.sessionId, metadata)
}

export async function cancelPlanInSession(args: {
  db: AppDatabase
  sessionId: string
}): Promise<PlanMeta | undefined> {
  const session = getSession(args.db, args.sessionId)
  if (!session) throw new Error('Session not found')
  const plan = normalizePlanMeta(session.metadata[SESSION_META_PLAN])
  if (!plan) return undefined

  const next: PlanMeta = {
    ...plan,
    status: 'cancelled',
    cancelledAt: Date.now()
  }
  let displayPlans = getDisplayPlans(session.metadata)
  displayPlans = syncDisplayPlanStatus(displayPlans, plan.planId, 'cancelled')
  const metadata = mergePlanMetadata(session.metadata, { plan: next, display_plans: displayPlans })
  saveSessionMetadata(args.db, args.sessionId, metadata)
  return next
}

export async function completePlanInSession(args: {
  db: AppDatabase
  sessionId: string
}): Promise<void> {
  const session = getSession(args.db, args.sessionId)
  if (!session) return
  const plan = normalizePlanMeta(session.metadata[SESSION_META_PLAN])
  if (!plan) return
  const next: PlanMeta = { ...plan, status: 'completed' }
  let displayPlans = getDisplayPlans(session.metadata)
  displayPlans = syncDisplayPlanStatus(displayPlans, plan.planId, 'completed', {
    currentStepIndex: plan.currentStepIndex,
    stepsTotal: plan.stepsTotal
  })
  const metadata = mergePlanMetadata(session.metadata, { plan: next, display_plans: displayPlans })
  saveSessionMetadata(args.db, args.sessionId, metadata)
}

export function appendStepResult(
  metadata: Record<string, unknown>,
  result: PlanStepResult
): Record<string, unknown> {
  const prev = Array.isArray(metadata[SESSION_META_PLAN_STEP_RESULTS])
    ? (metadata[SESSION_META_PLAN_STEP_RESULTS] as PlanStepResult[])
    : []
  const filtered = prev.filter((r) => r.stepIndex !== result.stepIndex)
  return mergePlanMetadata(metadata, { plan_step_results: [...filtered, result] })
}

export function advancePlanStep(metadata: Record<string, unknown>, nextIndex: number): Record<string, unknown> {
  const plan = normalizePlanMeta(metadata[SESSION_META_PLAN])
  if (!plan) return metadata
  return mergePlanMetadata(metadata, {
    plan: { ...plan, currentStepIndex: nextIndex }
  })
}
