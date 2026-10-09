import { describe, expect, it } from 'vitest'
import { createSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { putTaskControlRecord } from '../database/taskControl'
import type { ToolExecutionContext } from '../tools/plannedToolRegistry'
import { createImTaskControlToolRegistry } from './imTaskControlTools'

describe('IM task control tools', () => {
  it('binds session and owner to authenticated runtime context and strips forged scope fields', async () => {
    const db = createMemoryAppDb()
    const sessionId = createSession(db, { name: 'task-control-tool-auth' }).id
    putTaskControlRecord(db, {
      sessionId, ownerId: 'trusted-owner', workflowId: 'workflow-1', taskId: 'task-1',
      planRevision: 1, expectedRevision: null, data: { status: 'active' }
    })
    const invalidationCalls: Array<Record<string, unknown>> = []
    const registry = createImTaskControlToolRegistry(db, {
      invalidateTask: async (request) => { invalidationCalls.push(request); return { invalidated: [] } },
      dispatchDeferred: async () => ({ dispatched: true })
    })
    const tool = registry.get('task_cancel')!
    const handle = await tool.begin({
      workflowId: 'workflow-1', taskId: 'task-1', expectedRevision: 1,
      sessionId: 'forged-session', ownerId: 'forged-owner'
    }, { requestId: 'tool-request', toolUseId: 'tool-use' })
    handle.confirm()
    const result = await handle.execute({
      requestId: 'tool-request', toolUseId: 'tool-use', sessionId,
      runtimeContext: {
        sessionId, lane: 'feishu', remoteContext: { source: 'feishu', authOwner: 'trusted-owner' }
      }
    } as unknown as ToolExecutionContext)

    expect(result).toMatchObject({ success: true, status: 'cancelled' })
    expect(invalidationCalls).toHaveLength(1)
    expect(invalidationCalls[0]).toMatchObject({ sessionId, ownerId: 'trusted-owner' })
    expect(invalidationCalls[0]).not.toMatchObject({ sessionId: 'forged-session', ownerId: 'forged-owner' })
    db.close()
  })
})
