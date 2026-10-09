import { getWorkflowState, putWorkflowState, type WorkflowState } from '../database/workflowState'
import { ackImInboxMessage, claimImInboxMessage, listImInboxMessages } from '../database/imInbox'
import type { AppDatabase } from '../database/sqliteStore'
import { releaseRemoteSession, tryClaimRemoteSession } from './remoteAgentRegistry'
import type { QueueScope } from '../../src/shared/queueScope'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'

type ImQueueScope = Extract<QueueScope, { kind: 'im' }>

export type ImWorkflowDecision =
  | { kind: 'answer'; text: string }
  | { kind: 'plan'; summary: string; steps: Array<string | ImWorkflowStep>; assumptions: string[] }
  | { kind: 'clarify'; question: string }

export type ImWorkflowStep = Readonly<{
  stepId: string
  instruction: string
  status?: 'pending' | 'running' | 'completed' | 'deferred' | 'failed'
  dependsOn?: readonly string[]
  todoId?: string
  resultRef?: string
}>

export interface ImWorkflowModel {
  decide(input: {
    message: string
    current: WorkflowState | null
    inboxMessages: ReturnType<typeof listImInboxMessages>
    safetyGate?: ImWorkflowToolSafetyGate
  }): Promise<ImWorkflowDecision>
}

export type ImWorkflowToolSafetyGate = (toolName: string, args: Record<string, unknown>) => Promise<{ allowed: boolean }>

export type ImWorkflowFlowResult =
  | { kind: 'answer'; text: string }
  | { kind: 'waiting-confirmation'; state: WorkflowState }
  | { kind: 'waiting-clarification'; state: WorkflowState }

export type ImWorkflowInboundResult = ImWorkflowFlowResult & { inboundAcknowledged: true }

/** Owns one IM inbound claim and session slot through durable workflow update and acknowledgement. */
export async function processImWorkflowInbound(input: {
  db: AppDatabase
  sessionId: string
  workflowId: string
  message: string
  queueScope: ImQueueScope
  messageId: string
  ownerId: string
  maxParallel: number
  model: ImWorkflowModel
}): Promise<ImWorkflowInboundResult> {
  const slot = tryClaimRemoteSession(input.sessionId, input.ownerId, input.maxParallel)
  if (slot !== 'ok') throw new Error(`IM_SESSION_SLOT_${slot.toUpperCase()}`)
  try {
    const claim = claimImInboxMessage(input.db, {
      queueScope: input.queueScope, messageId: input.messageId, ownerId: input.ownerId
    })
    if (!claim) throw new Error('IM_INBOX_CLAIM_FAILED')
    const result = await runImWorkflowSkillFlow({ ...input, queueScope: input.queueScope })
    const acknowledged = ackImInboxMessage(input.db, {
      queueScope: input.queueScope, messageId: input.messageId, ownerId: input.ownerId
    })
    if (!acknowledged) throw new Error('IM_INBOX_ACK_FAILED')
    return { ...result, inboundAcknowledged: true }
  } finally {
    releaseRemoteSession(input.sessionId, input.ownerId)
  }
}

/** Drives the Skill's decisions while keeping intent policy in the injected Skill/model. */
export async function runImWorkflowSkillFlow(input: {
  db: AppDatabase
  sessionId: string
  workflowId: string
  message: string
  queueScope?: Extract<QueueScope, { kind: 'im' }>
  safetyGate?: ImWorkflowToolSafetyGate
  model: ImWorkflowModel
}): Promise<ImWorkflowFlowResult> {
  const loaded = getWorkflowState(input.db, { sessionId: input.sessionId, workflowId: input.workflowId })
  const current = reconcileDeferredWorkflowCompletion(input.db, loaded)
  const inboxMessages = input.queueScope
    ? listImInboxMessages(input.db, { queueScope: input.queueScope })
    : []
  const decision = await input.model.decide({ message: input.message, current, inboxMessages, safetyGate: input.safetyGate })
  if (decision.kind === 'answer') return decision

  const currentData = current?.data ?? {}
  if (decision.kind === 'plan') validateWorkflowSteps(decision.steps)
  const nextData = decision.kind === 'plan'
    ? {
        ...currentData,
        status: 'awaiting-confirmation',
        objective: input.message,
        summary: decision.summary,
        steps: decision.steps,
        assumptions: decision.assumptions,
        planRevision: Number(currentData.planRevision ?? 0) + 1
      }
    : { ...currentData, status: 'awaiting-clarification', objective: input.message, question: decision.question }
  const stored = putWorkflowState(input.db, {
    sessionId: input.sessionId,
    workflowId: input.workflowId,
    expectedRevision: current?.revision ?? null,
    data: nextData
  })
  if (!stored.ok) throw new Error('IM_WORKFLOW_STATE_CONFLICT')
  return decision.kind === 'plan'
    ? { kind: 'waiting-confirmation', state: stored.state }
    : { kind: 'waiting-clarification', state: stored.state }
}

function reconcileDeferredWorkflowCompletion(db: AppDatabase, current: WorkflowState | null): WorkflowState | null {
  if (!current) return null
  const completedResults = current.data.completedDeferredResults && typeof current.data.completedDeferredResults === 'object'
    ? current.data.completedDeferredResults as Record<string, unknown> : {}
  type MutableStep = { -readonly [Key in keyof ImWorkflowStep]: ImWorkflowStep[Key] } & Record<string, unknown>
  const steps = Array.isArray(current.data.steps) ? current.data.steps as MutableStep[] : []
  const results = createDeferredExecutionResultStore(db)
  let changed = false
  for (const step of steps) {
    if (step.status !== 'deferred' || typeof step.todoId !== 'string' || completedResults[step.todoId]) continue
    const completion = results.listCompletionOutbox(step.todoId).find(({ state }) => state === 'pending' || state === 'delivered')
    const execution = results.getByTodo(step.todoId)
    if (!completion || !execution || (execution.state !== 'completion_outboxed' && execution.state !== 'delivered') ||
      execution.invocationId.trim() === '' || completion.dispatchKey !== execution.dispatchKey) continue
    completedResults[step.todoId] = completion.result
    step.status = completion.result.kind === 'failed' ? 'failed' : 'completed'
    const outputRef = completion.result.outputRef
    if (typeof outputRef === 'string') step.resultRef = outputRef
    changed = true
    if (completion.state === 'pending') results.markCompletionDelivered(step.todoId)
  }
  if (!changed) return current
  const stored = putWorkflowState(db, {
    sessionId: current.sessionId, workflowId: current.workflowId, version: current.version,
    expectedRevision: current.revision,
    data: { ...current.data, completedDeferredResults: completedResults, steps }
  })
  if (!stored.ok) throw new Error('IM_WORKFLOW_COMPLETION_REVISION_CONFLICT')
  return stored.state
}

function validateWorkflowSteps(steps: readonly (string | ImWorkflowStep)[]): void {
  const byId = new Map<string, ImWorkflowStep>()
  for (const [index, value] of steps.entries()) {
    if (typeof value === 'string') continue
    if (!value || typeof value !== 'object' || !value.stepId.trim() || !value.instruction.trim() || byId.has(value.stepId)) {
      throw new Error('IM_WORKFLOW_STEP_INVALID')
    }
    byId.set(value.stepId, value)
  }
  for (const step of byId.values()) {
    for (const dependencyId of step.dependsOn ?? []) {
      const dependency = byId.get(dependencyId)
      if (!dependency) throw new Error('IM_WORKFLOW_DEPENDENCY_MISSING')
      if (step.status === 'completed' && dependency.status !== 'completed') throw new Error('IM_WORKFLOW_DEPENDENCY_UNRESOLVED')
    }
    if (step.status === 'deferred' && (!step.todoId || !step.todoId.trim())) throw new Error('IM_WORKFLOW_DEFERRED_TODO_REQUIRED')
  }
}
