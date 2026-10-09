import { buildImQueueScope, type QueueScope } from '../../src/shared/queueScope'
import type { RemoteContext } from '../tools/types'
import type { AppDatabase } from '../database'
import { listImInboxMessages } from '../database/imInbox'
import { ackImInboxMessage, claimImInboxMessage, releaseImInboxMessage, renewImInboxClaim } from '../database/imInbox'
import { defineDirectTool, TypedToolRegistry } from '../tools/plannedToolRegistry'

export type AuthenticatedImToolContext = {
  sessionId: string
  lane: 'feishu' | 'wechat'
  remoteContext: RemoteContext
}

/** Bind Inbox authority exclusively from the authenticated runtime context. */
export function bindImInboxToolContext(
  _modelInput: Record<string, unknown>,
  runtime: AuthenticatedImToolContext
): { input: Record<string, unknown>; sessionId: string; ownerId: string; queueScope: Extract<QueueScope, { kind: 'im' }> } {
  if (runtime.remoteContext.source !== runtime.lane) throw new Error('IM_TOOL_CONTEXT_LANE_MISMATCH')
  const ownerId = runtime.remoteContext.authOwner?.trim()
  if (!ownerId) throw new Error('IM_TOOL_CONTEXT_OWNER_REQUIRED')
  return {
    input: {},
    sessionId: runtime.sessionId,
    ownerId,
    queueScope: buildImQueueScope(runtime.lane, runtime.sessionId) as Extract<QueueScope, { kind: 'im' }>
  }
}

export function createImInboxListTool(db: AppDatabase) {
  return defineDirectTool({
    name: 'im_inbox_list',
    parseInput: (value) => value == null ? {} : value as { limit?: number },
    execute: async (input, context) => {
      const runtime = (context as unknown as { runtimeContext?: Record<string, unknown> }).runtimeContext
      if (!runtime) throw new Error('IM_TOOL_CONTEXT_REQUIRED')
      const bound = bindImInboxToolContext({}, runtime as unknown as AuthenticatedImToolContext)
      return { success: true, messages: listImInboxMessages(db, { queueScope: bound.queueScope, limit: input.limit }) }
    }
  })
}

export function createImInboxListToolRegistry(db: AppDatabase): TypedToolRegistry {
  const registry = new TypedToolRegistry()
  registry.register(createImInboxListTool(db))
  return registry
}

export function createImInboxMutationToolRegistry(db: AppDatabase): TypedToolRegistry {
  const registry = new TypedToolRegistry()
  registry.register(defineDirectTool({
    name: 'im_inbox_claim',
    parseInput: (value) => value as { messageId: string },
    execute: async (input, context) => {
      const bound = trustedInboxContext(context)
      const claim = claimImInboxMessage(db, { queueScope: bound.queueScope, messageId: input.messageId, ownerId: bound.ownerId })
      return { success: Boolean(claim), ...(claim ? { claim } : { error: 'message_unavailable' }) }
    }
  }))
  registry.register(defineDirectTool({
    name: 'im_inbox_ack',
    parseInput: (value) => value as { messageId: string },
    execute: async (input, context) => ({
      success: ackImInboxMessage(db, { ...trustedInboxContext(context), messageId: input.messageId })
    })
  }))
  registry.register(defineDirectTool({
    name: 'im_inbox_release',
    parseInput: (value) => value as { messageId: string },
    execute: async (input, context) => ({
      success: releaseImInboxMessage(db, { ...trustedInboxContext(context), messageId: input.messageId })
    })
  }))
  registry.register(defineDirectTool({
    name: 'im_inbox_renew',
    parseInput: (value) => value as { messageId: string; leaseDurationMs: number },
    execute: async (input, context) => ({
      success: renewImInboxClaim(db, { ...trustedInboxContext(context), messageId: input.messageId, leaseDurationMs: input.leaseDurationMs })
    })
  }))
  return registry
}

function trustedInboxContext(context: import('../tools/plannedToolRegistry').ToolExecutionContext) {
  const runtime = (context as unknown as { runtimeContext?: Record<string, unknown> }).runtimeContext
  if (!runtime) throw new Error('IM_TOOL_CONTEXT_REQUIRED')
  const bound = bindImInboxToolContext({}, runtime as unknown as AuthenticatedImToolContext)
  return { queueScope: bound.queueScope, ownerId: bound.ownerId }
}
