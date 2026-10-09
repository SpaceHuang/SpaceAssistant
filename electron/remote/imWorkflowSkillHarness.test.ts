import { describe, expect, it, vi } from 'vitest'
import { createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getWorkflowState } from '../database/workflowState'
import { appendImInboxMessage, listImInboxMessages } from '../database/imInbox'
import { buildImQueueScope } from '../../src/shared/queueScope'
import { processImWorkflowInbound, runImWorkflowSkillFlow, type ImWorkflowDecision, type ImWorkflowModel } from './imWorkflowSkillHarness'
import { isRequestLeaseOwner, releaseRemoteSession, resetRunningRemoteAgentRegistryForTests, tryClaimRemoteSession } from './remoteAgentRegistry'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'

function fakeModel(...decisions: ImWorkflowDecision[]): ImWorkflowModel {
  let index = 0
  return {
    decide: async () => {
      const decision = decisions[index++]
      if (!decision) throw new Error('FAKE_MODEL_DECISION_EXHAUSTED')
      return decision
    }
  }
}

describe('IM orchestration Skill flow with fake model', () => {
  afterEach(() => resetRunningRemoteAgentRegistryForTests())
  it('answers a lightweight question directly without creating workflow state', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-lightweight' }).id
    const result = await runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'weather-question', message: 'What is 2 + 2?',
      model: fakeModel({ kind: 'answer', text: '4' })
    })
    expect(result).toEqual({ kind: 'answer', text: '4' })
    expect(getWorkflowState(db, { sessionId, workflowId: 'weather-question' })).toBeNull()
    db.close()
  })

  it('persists complex plans for confirmation, clarifies missing information, and revises changed goals', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-plan' }).id
    const first = await runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'travel-plan', message: 'Plan a weekend trip',
      model: fakeModel({ kind: 'plan', summary: 'Draft a trip plan', steps: ['Find options'], assumptions: ['Nearby'] })
    })
    expect(first).toMatchObject({ kind: 'waiting-confirmation', state: { revision: 1, data: { planRevision: 1 } } })

    const clarification = await runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'travel-plan', message: 'Book the trip',
      model: fakeModel({ kind: 'clarify', question: 'Which dates and budget should I use?' })
    })
    expect(clarification).toMatchObject({ kind: 'waiting-clarification', state: { revision: 2, data: { status: 'awaiting-clarification' } } })

    const revised = await runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'travel-plan', message: 'Make it a day trip instead',
      model: fakeModel({ kind: 'plan', summary: 'Revise to a day trip', steps: ['Find day trips'], assumptions: [] })
    })
    expect(revised).toMatchObject({ kind: 'waiting-confirmation', state: { revision: 3, data: { objective: 'Make it a day trip instead', planRevision: 2 } } })
    expect(getWorkflowState(db, { sessionId, workflowId: 'travel-plan' })).toEqual(revised.state)
    db.close()
  })

  it('persists waiting state before ack, ends the loop, and restores it on the next inbound reply', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-resume' }).id
    const queueScope = buildImQueueScope('feishu', 'resume-remote-session')
    const firstInbound = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'resume-first', content: 'Prepare a project plan'
    })
    const ownerId = 'resume-loop-owner'
    const firstFlow = await processImWorkflowInbound({
      db, sessionId, workflowId: 'project-task', message: 'Prepare a project plan',
      queueScope, messageId: firstInbound.messageId, ownerId, maxParallel: 3,
      model: fakeModel({ kind: 'plan', summary: 'Draft project plan', steps: ['Scope'], assumptions: [] })
    })
    expect(firstFlow.kind).toBe('waiting-confirmation')
    expect(getWorkflowState(db, { sessionId, workflowId: 'project-task' })?.data.status).toBe('awaiting-confirmation')
    expect(firstFlow.inboundAcknowledged).toBe(true)
    expect(isRequestLeaseOwner(sessionId, ownerId)).toBe(false)
    expect(tryClaimRemoteSession(sessionId, 'next-loop', 3)).toBe('ok')
    releaseRemoteSession(sessionId, 'next-loop')

    const reply = appendImInboxMessage(db, {
      sessionId, channel: 'feishu', queueScope, channelMessageId: 'resume-reply', content: 'Please make it a one week plan'
    })
    const resumed = await processImWorkflowInbound({
      db, sessionId, workflowId: 'project-task', message: 'Please make it a one week plan',
      queueScope, messageId: reply.messageId, ownerId: 'resume-loop-owner-2', maxParallel: 3,
      model: fakeModel({ kind: 'plan', summary: 'One week plan', steps: ['Scope week'], assumptions: [] })
    })
    expect(resumed).toMatchObject({ kind: 'waiting-confirmation', state: { revision: 2, data: { planRevision: 2 } } })
    expect(resumed.inboundAcknowledged).toBe(true)
    expect(isRequestLeaseOwner(sessionId, 'resume-loop-owner-2')).toBe(false)
    db.close()
  })

  it('keeps multiple arrivals during a loop and lets the next Skill decision interpret the pending set', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-batched-arrivals' }).id
    const queueScope = buildImQueueScope('wechat', 'batched-arrival-session')
    const first = appendImInboxMessage(db, {
      sessionId, channel: 'wechat', queueScope, channelMessageId: 'batch-first', content: 'Start project A'
    })
    let releaseFirst!: () => void
    let signalFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve })
    const firstDecision: ImWorkflowModel = {
      decide: async () => {
        signalFirst()
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return { kind: 'plan', summary: 'Project A plan', steps: ['Scope A'], assumptions: [] }
      }
    }
    const firstLoop = processImWorkflowInbound({
      db, sessionId, workflowId: 'project-a', message: 'Start project A', queueScope,
      messageId: first.messageId, ownerId: 'batch-owner-1', maxParallel: 2, model: firstDecision
    })
    await firstStarted
    const second = appendImInboxMessage(db, {
      sessionId, channel: 'wechat', queueScope, channelMessageId: 'batch-second', content: 'Also add project B'
    })
    const third = appendImInboxMessage(db, {
      sessionId, channel: 'wechat', queueScope, channelMessageId: 'batch-third', content: 'Actually clarify project B budget'
    })
    expect(listImInboxMessages(db, { queueScope }).map(({ messageId }) => messageId)).toEqual([
      first.messageId, second.messageId, third.messageId
    ])
    releaseFirst()
    await firstLoop

    let skillInput: { message: string; current: ReturnType<typeof getWorkflowState>; inboxMessages: Array<{ messageId: string; content: string }> } | undefined
    const nextLoop = await processImWorkflowInbound({
      db, sessionId, workflowId: 'project-a', message: 'Also add project B', queueScope,
      messageId: second.messageId, ownerId: 'batch-owner-2', maxParallel: 2,
      model: {
        decide: async (input) => {
          skillInput = input as typeof skillInput
          return { kind: 'clarify', question: 'What budget should I use for project B?' }
        }
      }
    })
    expect(skillInput?.inboxMessages.map(({ messageId }) => messageId)).toEqual([second.messageId, third.messageId])
    expect(nextLoop.kind).toBe('waiting-clarification')
    expect(listImInboxMessages(db, { queueScope }).map(({ messageId }) => messageId)).toEqual([third.messageId])
    db.close()
  })

  it('rejects a step marked completed while its deferred dependency is unresolved', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-partial-progress' }).id
    await expect(runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'partial-progress', message: 'Continue independent work',
      model: fakeModel({ kind: 'plan', summary: 'Partial progress', steps: [
        { stepId: 'independent', instruction: 'Collect public facts', status: 'completed', dependsOn: [] },
        { stepId: 'publish', instruction: 'Publish the result', status: 'deferred', dependsOn: ['independent'], todoId: 'publish-todo' },
        { stepId: 'announce', instruction: 'Announce publication', status: 'completed', dependsOn: ['publish'] }
      ] as never, assumptions: [] })
    })).rejects.toThrow('IM_WORKFLOW_DEPENDENCY_UNRESOLVED')
    db.close()
  })

  it('preserves independently completed work beside a deferred step', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-independent-progress' }).id
    const result = await runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'independent-progress', message: 'Collect facts and defer publication',
      model: fakeModel({ kind: 'plan', summary: 'Partial progress', steps: [
        { stepId: 'research', instruction: 'Collect public facts', status: 'completed', dependsOn: [] },
        { stepId: 'publish', instruction: 'Publish the result', status: 'deferred', dependsOn: [], todoId: 'publish-todo' }
      ], assumptions: [] })
    })
    expect(result).toMatchObject({ kind: 'waiting-confirmation', state: { data: { steps: [
      { stepId: 'research', status: 'completed' }, { stepId: 'publish', status: 'deferred', todoId: 'publish-todo' }
    ] } } })
    db.close()
  })

  it('restores a safely completed deferred result before continuing pending steps through a fresh safety gate', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-deferred-completion' }).id
    await runImWorkflowSkillFlow({ db, sessionId, workflowId: 'deferred-completion-flow', message: 'Publish then notify',
      model: fakeModel({ kind: 'plan', summary: 'Publish then notify', steps: [
        { stepId: 'publish', instruction: 'Publish', status: 'deferred', todoId: 'completed-todo' },
        { stepId: 'notify', instruction: 'Notify', status: 'pending', dependsOn: ['publish'] }
      ], assumptions: [] }) })
    const resultStore = createDeferredExecutionResultStore(db)
    resultStore.beginDispatch({ todoId: 'completed-todo', invocationId: 'completed-invocation', dispatchKey: 'completed-dispatch' })
    resultStore.commitResult('completed-todo', { kind: 'completed', outputRef: 'safe-output-ref' })
    const safetyGate = vi.fn(async (_toolName: string, _args: Record<string, unknown>) => ({ allowed: false }))
    const first = await runImWorkflowSkillFlow({
      db, sessionId, workflowId: 'deferred-completion-flow', message: 'Continue the workflow', safetyGate,
      model: {
        decide: async ({ current, safetyGate: checkTool }) => {
          expect(current?.data.completedDeferredResults).toEqual({ 'completed-todo': { kind: 'completed', outputRef: 'safe-output-ref' } })
          expect(current?.data.steps).toEqual([
            { stepId: 'publish', instruction: 'Publish', status: 'completed', todoId: 'completed-todo', resultRef: 'safe-output-ref' },
            { stepId: 'notify', instruction: 'Notify', status: 'pending', dependsOn: ['publish'] }
          ])
          const authorization = await checkTool!('send_message', { channel: 'wechat', text: 'Published' })
          expect(authorization.allowed).toBe(false)
          return { kind: 'plan', summary: 'Continue after publication', steps: [
            { stepId: 'publish', instruction: 'Publish', status: 'completed', todoId: 'completed-todo', resultRef: 'safe-output-ref' },
            { stepId: 'notify', instruction: 'Notify', status: 'pending', dependsOn: ['publish'] }
          ], assumptions: [] }
        }
      }
    })
    expect(first).toMatchObject({ kind: 'waiting-confirmation', state: { data: {
      completedDeferredResults: { 'completed-todo': { kind: 'completed', outputRef: 'safe-output-ref' } },
      steps: [{ stepId: 'publish', status: 'completed' }, { stepId: 'notify', status: 'pending' }]
    } } })
    expect(safetyGate).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('keeps a failed deferred action failed when reconciling its durable result', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'im-flow-deferred-failure' }).id
    await runImWorkflowSkillFlow({ db, sessionId, workflowId: 'deferred-failure-flow', message: 'Publish then notify',
      model: fakeModel({ kind: 'plan', summary: 'Publish then notify', steps: [
        { stepId: 'publish', instruction: 'Publish', status: 'deferred', todoId: 'failed-todo' },
        { stepId: 'notify', instruction: 'Notify', status: 'pending', dependsOn: ['publish'] }
      ], assumptions: [] }) })
    const resultStore = createDeferredExecutionResultStore(db)
    resultStore.beginDispatch({ todoId: 'failed-todo', invocationId: 'failed-invocation', dispatchKey: 'failed-dispatch' })
    resultStore.commitResult('failed-todo', { kind: 'failed', outputRef: 'failed-result-ref', error: 'provider rejected action' })

    const reconciled = await runImWorkflowSkillFlow({ db, sessionId, workflowId: 'deferred-failure-flow', message: 'Continue the workflow',
      model: { decide: async ({ current }) => {
        expect(current?.data.steps).toEqual([
          { stepId: 'publish', instruction: 'Publish', status: 'failed', todoId: 'failed-todo', resultRef: 'failed-result-ref' },
          { stepId: 'notify', instruction: 'Notify', status: 'pending', dependsOn: ['publish'] }
        ])
        return { kind: 'answer', text: 'The approved action failed; notify step remains pending.' }
      } } })
    expect(reconciled).toMatchObject({ kind: 'answer' })
    db.close()
  })
})
