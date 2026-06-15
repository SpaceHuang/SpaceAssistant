import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildToolChatPayload, createToolChatController } from './chatToolSessionService'
import { DEFAULT_TOOLS_CONFIG, CURRENT_SCHEMA_VERSION } from '../../shared/domainTypes'
import type { Message } from '../../shared/domainTypes'

type ToolCbMap = {
  onUse?: (d: { requestId: string; toolUse: { id: string; name: string; input: unknown } }) => void
  onConfirm?: (d: {
    requestId: string
    toolUseId: string
    toolName: string
    input: unknown
    riskLevel: string
    shellSecurityHints?: { canTrust?: boolean; requiresRiskAck: boolean; outsideWorkDirRisk: boolean }
    autoApproveFallback?: { reason: string; reasonCode: string }
  }) => void
}

function installApiMock(handlers: ToolCbMap) {
  window.api = {
    ...(window.api ?? {}),
    toolOnUse: (cb) => {
      handlers.onUse = cb
      return () => {}
    },
    toolOnConfirmRequest: (cb) => {
      handlers.onConfirm = cb
      return () => {}
    },
    toolOnProgress: () => () => {},
    toolOnResult: () => () => {}
  } as typeof window.api
}

describe('chatToolSessionService onConfirmReq', () => {
  const handlers: ToolCbMap = {}

  beforeEach(() => {
    handlers.onUse = undefined
    handlers.onConfirm = undefined
    installApiMock(handlers)
  })

  it('stores shellSecurityHints on confirming record', () => {
    const patches: unknown[] = []
    const controller = createToolChatController({
      dispatch: vi.fn(),
      assistantMessageId: 'msg-1',
      getRequestId: () => 'req-1',
      applyAssistantPatch: (patch) => patches.push(patch)
    })
    controller.subscribe()

    handlers.onUse?.({
      requestId: 'req-1',
      toolUse: { id: 'tool-1', name: 'run_shell', input: { command: 'npm install' } }
    })
    handlers.onConfirm?.({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      toolName: 'run_shell',
      input: { command: 'npm install' },
      riskLevel: 'high',
      shellSecurityHints: { requiresRiskAck: false, outsideWorkDirRisk: false, canTrust: true }
    })

    const lastPatch = patches.at(-1) as { toolCalls?: Array<Record<string, unknown>> }
    expect(lastPatch.toolCalls?.[0]?.shellSecurityHints).toEqual(
      expect.objectContaining({ canTrust: true })
    )
    controller.unsubscribe()
  })

  it('stores autoApproveFallback for file tools', () => {
    const patches: unknown[] = []
    const controller = createToolChatController({
      dispatch: vi.fn(),
      assistantMessageId: 'msg-2',
      getRequestId: () => 'req-2',
      applyAssistantPatch: (patch) => patches.push(patch)
    })
    controller.subscribe()

    handlers.onUse?.({
      requestId: 'req-2',
      toolUse: { id: 'tool-2', name: 'write_file', input: { path: '.env', content: 'x' } }
    })
    handlers.onConfirm?.({
      requestId: 'req-2',
      toolUseId: 'tool-2',
      toolName: 'write_file',
      input: { path: '.env', content: 'x' },
      riskLevel: 'medium',
      autoApproveFallback: { reason: '敏感路径', reasonCode: 'sensitive_path' }
    })

    const lastPatch = patches.at(-1) as { toolCalls?: Array<Record<string, unknown>> }
    expect(lastPatch.toolCalls?.[0]?.autoApproveFallback).toEqual({
      reason: '敏感路径',
      reasonCode: 'sensitive_path'
    })
    controller.unsubscribe()
  })
})

describe('buildToolChatPayload locale', () => {
  const stubMessage: Message = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: 'sess-1',
    role: 'user',
    content: 'hello',
    timestamp: 1,
    status: 'completed',
    schemaVersion: CURRENT_SCHEMA_VERSION
  }

  it('I11: includes locale in payload when provided', () => {
    const payload = buildToolChatPayload({
      requestId: '00000000-0000-4000-8000-000000000002',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      messages: [stubMessage],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      locale: 'en-US'
    })
    expect(payload.locale).toBe('en-US')
  })
})
