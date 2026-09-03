import { describe, expect, it } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import {
  messageHasConfirmingTool,
  restorePendingConfirmToolCalls,
  resolveMessageToolsInteractive,
  resolveRequestIdForConfirmingMessage
} from './resolveMessageToolsInteractive'
import type { PendingConfirmItem } from './pendingConfirmStore'

const confirmingMessage: Message = {
  id: 'msg-1',
  sessionId: 'sess-1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  status: 'streaming',
  toolCalls: [
    {
      id: 'tool-1',
      toolName: 'browser',
      input: { action: 'act', instruction: 'click' },
      status: 'confirming',
      riskLevel: 'medium'
    }
  ]
}

const pendingItem: PendingConfirmItem = {
  sessionId: 'sess-1',
  requestId: 'req-pending',
  toolUseId: 'tool-1',
  toolName: 'browser',
  input: { action: 'act' },
  riskLevel: 'medium',
  createdAt: Date.now()
}

describe('resolveMessageToolsInteractive', () => {
  it('补回数据库消息中尚未出现的 pending tool call', () => {
    const restored = restorePendingConfirmToolCalls(
      [{ ...confirmingMessage, toolCalls: [] }],
      [pendingItem]
    )
    expect(restored[0]?.toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-1', status: 'confirming', toolName: 'browser' })
    ])
  })

  it('恢复危险浏览器确认的风险与会话信任元数据', () => {
    const dangerInfo = { userReason: '会提交订单', consequence: 'money' as const, source: 'page-effect' as const }
    const item: PendingConfirmItem = {
      ...pendingItem,
      dangerInfo,
      sessionTrustedHint: true,
      currentPageUrl: 'https://shop.example.test/checkout'
    }
    const restored = restorePendingConfirmToolCalls([{ ...confirmingMessage, toolCalls: [] }], [item])[0]!.toolCalls![0]!
    expect(restored).toMatchObject({ dangerInfo, sessionTrustedHint: true, currentPageUrl: item.currentPageUrl })
  })

  it('恢复 MCP 确认的完整来源元数据', () => {
    const mcp = {
      serverId: 'server-1', serverName: 'CRM', originalToolName: 'create_contact',
      description: 'Create a contact', maskedArgs: { email: '[REDACTED]' }
    }
    const item: PendingConfirmItem = {
      ...pendingItem,
      toolName: 'mcp',
      input: { email: 'sk-live-secret-token' },
      mcp
    }
    const restored = restorePendingConfirmToolCalls([{ ...confirmingMessage, toolCalls: [] }], [item])[0]!.toolCalls![0]!
    expect(restored.mcp).toEqual({
      serverId: mcp.serverId,
      serverName: mcp.serverName,
      originalToolName: mcp.originalToolName,
      description: mcp.description
    })
    expect(restored.input).toEqual(mcp.maskedArgs)
    expect(JSON.stringify(restored.input)).not.toContain('sk-live-secret-token')
    expect(restored.mcp).not.toHaveProperty('maskedArgs')
  })

  it('恢复 auto-approve fallback 元数据', () => {
    const autoApproveFallback = { reason: 'diff_unavailable' } as PendingConfirmItem['autoApproveFallback']
    const item: PendingConfirmItem = { ...pendingItem, autoApproveFallback }
    const restored = restorePendingConfirmToolCalls([{ ...confirmingMessage, toolCalls: [] }], [item])[0]!.toolCalls![0]!
    expect(restored.autoApproveFallback).toEqual(autoApproveFallback)
  })

  it('保留不需要恢复的历史消息引用', () => {
    const history = { ...confirmingMessage, id: 'history', status: 'completed' as const, toolCalls: [] }
    const restored = restorePendingConfirmToolCalls(
      [history, { ...confirmingMessage, id: 'streaming', status: 'streaming' }],
      [pendingItem]
    )
    expect(restored[0]).toBe(history)
    expect(restored[1]).not.toBe(restored[0])
  })
  it('detects confirming tools on message', () => {
    expect(messageHasConfirmingTool(confirmingMessage)).toBe(true)
    expect(messageHasConfirmingTool({ ...confirmingMessage, toolCalls: [] })).toBe(false)
  })

  it('prefers pending store over streaming request id for active assistant', () => {
    expect(
      resolveRequestIdForConfirmingMessage({
        sessionId: 'sess-1',
        message: confirmingMessage,
        pendingItems: [pendingItem],
        streamingAssistantId: 'msg-1',
        streamingRequestId: 'req-live'
      })
    ).toBe('req-pending')
  })

  it('uses streaming request id when pending store has no entry', () => {
    expect(
      resolveRequestIdForConfirmingMessage({
        sessionId: 'sess-1',
        message: confirmingMessage,
        pendingItems: [],
        streamingAssistantId: 'msg-1',
        streamingRequestId: 'req-live'
      })
    ).toBe('req-live')
  })

  it('falls back to pending store when streaming request id is missing', () => {
    expect(
      resolveRequestIdForConfirmingMessage({
        sessionId: 'sess-1',
        message: confirmingMessage,
        pendingItems: [pendingItem],
        streamingAssistantId: 'msg-1',
        streamingRequestId: null
      })
    ).toBe('req-pending')
  })

  it('falls back to streaming request id when pending store missed IPC', () => {
    expect(
      resolveRequestIdForConfirmingMessage({
        sessionId: 'sess-1',
        message: confirmingMessage,
        pendingItems: [],
        streamingAssistantId: 'msg-other',
        streamingRequestId: 'req-live'
      })
    ).toBe('req-live')
  })

  it('returns tools interactive scalars for confirming message', () => {
    const interactive = resolveMessageToolsInteractive({
      message: confirmingMessage,
      sessionId: 'sess-1',
      toolsEnabled: true,
      confirmMode: 'diff',
      pendingItems: [pendingItem],
      streamingAssistantId: 'msg-2',
      streamingRequestId: null
    })
    expect(interactive).toEqual({ requestId: 'req-pending', confirmMode: 'diff' })
  })

  it('restores interaction when a reloaded message status is stale but the pending store still has the tool', () => {
    const reloadedMessage: Message = {
      ...confirmingMessage,
      toolCalls: [{ ...confirmingMessage.toolCalls![0], status: 'calling' }]
    }
    expect(
      resolveMessageToolsInteractive({
        message: reloadedMessage,
        sessionId: 'sess-1',
        toolsEnabled: true,
        confirmMode: 'diff',
        pendingItems: [pendingItem],
        streamingRequestId: null
      })
    ).toEqual({ requestId: 'req-pending', confirmMode: 'diff' })
  })

  it('returns scalars for executing tool on streaming assistant', () => {
    const executing: Message = {
      ...confirmingMessage,
      id: 'msg-exec',
      toolCalls: [
        {
          id: 'tool-2',
          toolName: 'run_shell',
          input: { command: 'ls' },
          status: 'executing',
          riskLevel: 'medium'
        }
      ]
    }
    expect(
      resolveMessageToolsInteractive({
        message: executing,
        sessionId: 'sess-1',
        toolsEnabled: true,
        confirmMode: 'diff',
        pendingItems: [],
        streamingAssistantId: 'msg-exec',
        streamingRequestId: 'req-live'
      })
    ).toEqual({ requestId: 'req-live', confirmMode: 'diff' })
  })
})
