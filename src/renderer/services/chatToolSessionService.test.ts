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
  onRedirect?: (d: { requestId: string; toolUseId: string; originalPath: string; newPath: string }) => void
  onPathResolved?: (d: {
    requestId: string
    toolUseId: string
    path: string
    metadata: import('../../shared/artifactTypes').ArtifactToolResultMeta
  }) => void
}

function installApiMock(handlers: ToolCbMap) {
  window.api = {
    ...(window.api ?? {}),
    toolOnUse: (cb) => {
      handlers.onUse = cb
      return () => {}
    },
    toolOnRedirect: (cb) => {
      handlers.onRedirect = cb
      return () => {}
    },
    toolOnPathResolved: (cb) => {
      handlers.onPathResolved = cb
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
    handlers.onRedirect = undefined
    handlers.onPathResolved = undefined
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

  it('rewrites input.path on tool:path-resolved with artifact metadata', () => {
    const patches: unknown[] = []
    const controller = createToolChatController({
      dispatch: vi.fn(),
      assistantMessageId: 'msg-path',
      getRequestId: () => 'req-path',
      applyAssistantPatch: (patch) => patches.push(patch)
    })
    controller.subscribe()

    handlers.onUse?.({
      requestId: 'req-path',
      toolUse: { id: 'tool-path', name: 'write_file', input: { path: 'agent/scratch.sh', content: 'x' } }
    })
    handlers.onPathResolved?.({
      requestId: 'req-path',
      toolUseId: 'tool-path',
      path: '.spaceassistant/runs/s1/script/scratch.sh',
      metadata: {
        artifactId: 'artifact-1',
        container: 'scratch',
        role: 'scratch',
        pathKind: 'file',
        requestedPath: 'agent/scratch.sh',
        finalPath: '.spaceassistant/runs/s1/script/scratch.sh',
        provenance: { pathSource: 'system-assigned' }
      }
    })

    const lastPatch = patches.at(-1) as { toolCalls?: Array<{ input: { path: string }; artifactMeta?: unknown }> }
    expect(lastPatch.toolCalls?.[0]?.input.path).toBe('.spaceassistant/runs/s1/script/scratch.sh')
    expect(lastPatch.toolCalls?.[0]?.artifactMeta).toEqual(expect.objectContaining({ artifactId: 'artifact-1' }))
    controller.unsubscribe()
  })

  it('rewrites input.path on tool:redirect', () => {
    const patches: unknown[] = []
    const controller = createToolChatController({
      dispatch: vi.fn(),
      assistantMessageId: 'msg-3',
      getRequestId: () => 'req-3',
      applyAssistantPatch: (patch) => patches.push(patch)
    })
    controller.subscribe()

    handlers.onUse?.({
      requestId: 'req-3',
      toolUse: { id: 'tool-3', name: 'write_file', input: { path: 'foo.py', content: 'x' } }
    })
    handlers.onRedirect?.({
      requestId: 'req-3',
      toolUseId: 'tool-3',
      originalPath: 'foo.py',
      newPath: 'Script/foo.py'
    })

    const lastPatch = patches.at(-1) as { toolCalls?: Array<{ input: { path: string } }> }
    expect(lastPatch.toolCalls?.[0]?.input.path).toBe('Script/foo.py')
    controller.unsubscribe()
  })

  it('ignores tool:redirect for mismatched requestId', () => {
    const patches: unknown[] = []
    const controller = createToolChatController({
      dispatch: vi.fn(),
      assistantMessageId: 'msg-4',
      getRequestId: () => 'req-4',
      applyAssistantPatch: (patch) => patches.push(patch)
    })
    controller.subscribe()

    handlers.onUse?.({
      requestId: 'req-4',
      toolUse: { id: 'tool-4', name: 'write_file', input: { path: 'foo.py', content: 'x' } }
    })
    const before = patches.length
    handlers.onRedirect?.({
      requestId: 'other-req',
      toolUseId: 'tool-4',
      originalPath: 'foo.py',
      newPath: 'Script/foo.py'
    })

    expect(patches.length).toBe(before)
    const lastPatch = patches.at(-1) as { toolCalls?: Array<{ input: { path: string } }> }
    expect(lastPatch.toolCalls?.[0]?.input.path).toBe('foo.py')
    controller.unsubscribe()
  })
})

describe('buildToolChatPayload', () => {
  const stubMessage: Message = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: 'sess-1',
    role: 'user',
    content: 'hello',
    timestamp: 1,
    status: 'completed',
    schemaVersion: CURRENT_SCHEMA_VERSION
  }

  const assistantMessage: Message = {
    id: '00000000-0000-4000-8000-000000000002',
    sessionId: 'sess-1',
    role: 'assistant',
    content: 'hi there',
    timestamp: 2,
    status: 'completed',
    schemaVersion: CURRENT_SCHEMA_VERSION
  }

  it('includes locale in payload when provided', () => {
    const payload = buildToolChatPayload({
      requestId: '00000000-0000-4000-8000-000000000003',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      messages: [stubMessage],
      currentUserMessageId: stubMessage.id,
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      locale: 'en-US'
    })
    expect(payload.locale).toBe('en-US')
  })

  it('passes sourceMessages and currentUserMessageId for main-process image hydration', () => {
    const messages = [stubMessage, assistantMessage]
    const payload = buildToolChatPayload({
      requestId: '00000000-0000-4000-8000-000000000004',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-20250514',
      messages,
      currentUserMessageId: stubMessage.id,
      toolsConfig: DEFAULT_TOOLS_CONFIG
    })
    expect(payload.sourceMessages).toBe(messages)
    expect(payload.currentUserMessageId).toBe(stubMessage.id)
  })
})
