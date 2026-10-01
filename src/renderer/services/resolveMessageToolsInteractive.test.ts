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

  it('同一 pending 工具已存在于另一条助手消息时不在目标消息复制确认卡', () => {
    const earlier = { ...confirmingMessage, id: 'earlier-message', toolCalls: [{ ...confirmingMessage.toolCalls![0]!, status: 'confirming' as const }] }
    const latest = { ...confirmingMessage, id: 'latest-message', toolCalls: [] }
    const restored = restorePendingConfirmToolCalls([earlier, latest], [pendingItem])

    expect(restored[0]?.toolCalls).toHaveLength(1)
    expect(restored[1]?.toolCalls).toEqual([])
  })

  it('按投影记录的助手消息和工具位置恢复缺失卡片，不追加到最新消息末尾', () => {
    const origin: Message = {
      ...confirmingMessage,
      id: 'origin-message',
      contentSegments: [{ content: 'before', startTime: 1 }],
      toolCalls: [{ id: 'later-tool', toolName: 'lookup', input: {}, status: 'calling', riskLevel: 'low' }],
      activity: [
        { kind: 'text', segmentIndex: 0 },
        { kind: 'tool', toolId: 'later-tool' }
      ]
    }
    const latest: Message = { ...confirmingMessage, id: 'latest-message', toolCalls: [] }
    const positionedPending = {
      ...pendingItem,
      toolUseId: 'restored-tool',
      assistantMessageId: origin.id,
      toolIndex: 0,
      activityIndex: 0
    }

    const restored = restorePendingConfirmToolCalls([origin, latest], [positionedPending])

    expect(restored[0]?.toolCalls?.map((tool) => [tool.id, tool.status])).toEqual([
      ['restored-tool', 'confirming'],
      ['later-tool', 'calling']
    ])
    expect(restored[0]?.activity).toEqual([
      { kind: 'tool', toolId: 'restored-tool' },
      { kind: 'text', segmentIndex: 0 },
      { kind: 'tool', toolId: 'later-tool' }
    ])
    expect(restored[1]?.toolCalls).toEqual([])
  })

  it('按 toolUseId 把旧状态快照提升为原消息中的确认卡', () => {
    const origin: Message = {
      ...confirmingMessage,
      id: 'origin-message',
      status: 'completed',
      toolCalls: [
        { id: 'before', toolName: 'lookup', input: {}, status: 'completed', riskLevel: 'low' },
        { ...confirmingMessage.toolCalls![0]!, status: 'executing' },
        { id: 'after', toolName: 'lookup', input: {}, status: 'calling', riskLevel: 'low' }
      ],
      activity: [
        { kind: 'tool', toolId: 'before' },
        { kind: 'tool', toolId: pendingItem.toolUseId },
        { kind: 'tool', toolId: 'after' }
      ]
    }
    const latest: Message = { ...confirmingMessage, id: 'latest-message', toolCalls: [] }

    const restored = restorePendingConfirmToolCalls([origin, latest], [{ ...pendingItem, assistantMessageId: origin.id }])

    expect(restored[0]?.toolCalls?.map((tool) => [tool.id, tool.status])).toEqual([
      ['before', 'completed'],
      [pendingItem.toolUseId, 'confirming'],
      ['after', 'calling']
    ])
    expect(restored[1]?.toolCalls).toEqual([])
  })

  it.each(['calling', 'executing', 'completed', 'failed'] as const)(
    'pending 状态覆盖原消息中的 %s 快照并留在原位置',
    (status) => {
      const earlier = {
        ...confirmingMessage,
        id: 'earlier-message',
        status: 'completed' as const,
        toolCalls: [{ ...confirmingMessage.toolCalls![0]!, status }]
      }
      const latest = { ...confirmingMessage, id: 'latest-message', toolCalls: [] }
      const restored = restorePendingConfirmToolCalls([earlier, latest], [pendingItem])

      expect(restored[0]?.toolCalls?.[0]?.status).toBe('confirming')
      expect(restored[1]?.toolCalls).toEqual([])
    }
  )
  it('detects confirming tools on message', () => {
    expect(messageHasConfirmingTool(confirmingMessage)).toBe(true)
    expect(messageHasConfirmingTool({ ...confirmingMessage, toolCalls: [] })).toBe(false)
  })

  it('审批 Agent 的 confirming 项不提供人工交互标量', () => {
    const agentMessage: Message = {
      ...confirmingMessage,
      toolCalls: [{ ...confirmingMessage.toolCalls[0]!, autoAnswerer: true }]
    }

    expect(messageHasConfirmingTool(agentMessage)).toBe(false)
    expect(resolveMessageToolsInteractive({
      message: agentMessage,
      sessionId: 'sess-1',
      pendingItems: [],
      streamingAssistantId: 'msg-1',
      streamingRequestId: 'req-live'
    })).toBeUndefined()
  })

  it('旧 pending 条目与 autoAnswerer 工具同 id 时仍不恢复人工 requestId', () => {
    const agentMessage: Message = {
      ...confirmingMessage,
      toolCalls: [{ ...confirmingMessage.toolCalls[0]!, autoAnswerer: true }]
    }

    expect(resolveMessageToolsInteractive({
      message: agentMessage,
      sessionId: 'sess-1',
      pendingItems: [pendingItem],
      streamingAssistantId: 'msg-1',
      streamingRequestId: 'req-live'
    })).toBeUndefined()
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
      pendingItems: [pendingItem],
      streamingAssistantId: 'msg-2',
      streamingRequestId: null
    })
    expect(interactive).toEqual({ requestId: 'req-pending' })
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
        pendingItems: [pendingItem],
        streamingRequestId: null
      })
    ).toEqual({ requestId: 'req-pending' })
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
        pendingItems: [],
        streamingAssistantId: 'msg-exec',
        streamingRequestId: 'req-live'
      })
    ).toEqual({ requestId: 'req-live' })
  })
})
