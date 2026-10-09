import { describe, expect, it } from 'vitest'
import { createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { getWorkflowState } from '../database/workflowState'
import type { ToolExecutionContext } from '../tools/plannedToolRegistry'
import { createImWorkflowStateToolRegistry } from './imWorkflowStateTools'

describe('生产 IM workflow state tools', () => {
  it('以认证 runtime session 读写 workflow revision，不接受模型提供的 session 身份', async () => {
    const db = createMemoryAppDb()
    const trustedSessionId = createSession(db, { name: 'workflow-state-trusted' }).id
    const forgedSessionId = createSession(db, { name: 'workflow-state-forged' }).id
    const registry = createImWorkflowStateToolRegistry(db)
    const runtimeContext = { sessionId: trustedSessionId, lane: 'feishu', remoteContext: { source: 'feishu', authOwner: 'owner-1' } }
    const put = registry.get('im_workflow_state_put')!
    const handle = await put.begin({ workflowId: 'workflow-1', expectedRevision: null,
      data: { status: 'awaiting-confirmation', planRevision: 1 }, sessionId: forgedSessionId }, { requestId: 'r', toolUseId: 'u' })
    handle.confirm()
    await expect(handle.execute({ requestId: 'r', toolUseId: 'u', sessionId: trustedSessionId, runtimeContext } as unknown as ToolExecutionContext))
      .resolves.toMatchObject({ success: true, state: { sessionId: trustedSessionId, workflowId: 'workflow-1', revision: 1 } })
    expect(getWorkflowState(db, { sessionId: trustedSessionId, workflowId: 'workflow-1' })?.data.planRevision).toBe(1)
    expect(getWorkflowState(db, { sessionId: forgedSessionId, workflowId: 'workflow-1' })).toBeNull()

    const get = registry.get('im_workflow_state_get')!
    const read = await get.begin({ workflowId: 'workflow-1', sessionId: forgedSessionId }, { requestId: 'r2', toolUseId: 'u2' })
    read.confirm()
    await expect(read.execute({ requestId: 'r2', toolUseId: 'u2', sessionId: trustedSessionId, runtimeContext } as unknown as ToolExecutionContext))
      .resolves.toMatchObject({ success: true, state: { sessionId: trustedSessionId, workflowId: 'workflow-1' } })
    db.close()
  })

  it('通过 expectedRevision 拒绝并发覆盖', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'workflow-state-cas' }).id
    const registry = createImWorkflowStateToolRegistry(db)
    const tool = registry.get('im_workflow_state_put')!
    const call = (data: Record<string, unknown>) => tool.begin({ workflowId: 'workflow-cas', expectedRevision: null, data }, { requestId: 'r', toolUseId: 'u' })
    const first = await call({ revision: 1 }); first.confirm()
    const second = await call({ revision: 2 }); second.confirm()
    const context = { requestId: 'r', toolUseId: 'u', sessionId, runtimeContext: { sessionId, lane: 'wechat', remoteContext: { source: 'wechat', authOwner: 'owner' } } }
    await expect(first.execute(context as unknown as ToolExecutionContext)).resolves.toMatchObject({ success: true })
    await expect(second.execute(context as unknown as ToolExecutionContext)).resolves.toMatchObject({ success: false, error: 'revision_conflict' })
    db.close()
  })
})
