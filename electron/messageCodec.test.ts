import { describe, expect, it, vi } from 'vitest'
import { deserializeSkillHintsFromDb, deserializeToolCallsFromDb, serializeSkillHintsForDb, serializeToolCallsForDb } from './messageCodec'

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn()
}))

import { logAgentEvent } from './agentLogger/agentLogger'

describe('persisted operation status hints', () => {
  it('round-trips the typed continuation status needed for localized rendering after reload', () => {
    const hints = [{ id: 'stable-status-hint', text: '', shownAt: 10, category: 'status' as const, status: 'continuation-started' as const }]
    expect(deserializeSkillHintsFromDb(serializeSkillHintsForDb(hints))).toEqual(hints)
  })
})

describe('deserializeToolCallsFromDb', () => {
  it('compacts oversized string tool results before persisting them and restores the truncation marker', () => {
    const full = `head-${'x'.repeat(40_000)}-tail`
    const raw = serializeToolCallsForDb([{
      id: 'oversized-result', toolName: 'read_file', input: {}, status: 'completed', riskLevel: 'low',
      result: { success: true, data: full }
    }])!
    expect(raw).not.toContain('x'.repeat(40_000))
    const restored = deserializeToolCallsFromDb(raw)?.[0]?.result?.data
    expect(restored).toContain('head-')
    expect(restored).toContain('-tail')
    expect(restored).toContain('tool_result truncated')
  })
  it('round-trips MCP displayData for historical cards', () => {
    const raw = serializeToolCallsForDb([{
      id: 'mcp-1', toolName: 'mcp_x_y_abc', input: {}, status: 'completed', riskLevel: 'low',
      result: { success: true, data: '[model]', displayData: { text: '可读结果', blocks: [{ kind: 'text', text: '可读结果' }], isEmpty: false } }
    }])
    expect(deserializeToolCallsFromDb(raw)?.[0]?.result?.displayData?.text).toBe('可读结果')
  })
  it('round-trips notExecuted so restored denied tools remain distinguishable from execution failures', () => {
    const raw = serializeToolCallsForDb([{
      id: 'denied-1', toolName: 'run_shell', input: { command: 'whoami' }, status: 'rejected', riskLevel: 'high',
      result: { success: false, data: 'Tool call was not dispatched (POLICY_DENIED).', notExecuted: true }
    }])
    expect(deserializeToolCallsFromDb(raw)?.[0]?.result).toMatchObject({ success: false, notExecuted: true })
  })
  it('round-trips canonical audit correlation and user-facing tool result metadata', () => {
    const raw = serializeToolCallsForDb([{
      id: 'audited-1', toolName: 'write_file', input: { path: 'a.txt' }, status: 'completed', riskLevel: 'high',
      result: { success: true, data: { bytesWritten: 4 }, auditRef: 'audit:turn-1:call-1', decisionRuleId: 'policy-write-confirm', userMessage: '文件已写入' }
    }])
    expect(deserializeToolCallsFromDb(raw)?.[0]?.result).toMatchObject({
      success: true, data: { bytesWritten: 4 }, auditRef: 'audit:turn-1:call-1', decisionRuleId: 'policy-write-confirm', userMessage: '文件已写入'
    })
  })
  it('round-trips structured browser recovery and auto-approved write result metadata', () => {
    const dependencyRecovery = {
      errorCode: 'chromium_missing' as const, errorMessage: 'Chromium missing', recommendedCwd: '/workspace',
      installCommand: 'npx playwright install chromium',
      detectResult: { stagehand: { installed: true }, playwright: { installed: true, browsers: [] }, chromium: { ready: false }, node: { version: '22', meetsRequirement: true }, canInitialize: false, primaryFailure: 'chromium_missing' as const, errors: ['Chromium missing'], recommendedCwd: '/workspace', installContext: 'development' as const }
    }
    const autoApprovedWrite = { path: 'a.txt', added: 1, removed: 0, bytesWritten: 4 }
    const raw = serializeToolCallsForDb([{
      id: 'metadata-1', toolName: 'write_file', input: { path: 'a.txt' }, status: 'completed', riskLevel: 'low',
      result: { success: false, dependencyRecovery, autoApprovedWrite }
    }])
    expect(deserializeToolCallsFromDb(raw)?.[0]?.result).toMatchObject({ dependencyRecovery, autoApprovedWrite })
  })
  it('round-trips approval and confirmation-card metadata needed after restart', () => {
    const call = {
      id: 'approval-call-1', toolName: 'run_shell', input: { command: 'npm test' }, status: 'confirming' as const, riskLevel: 'high' as const,
      approval: { schemaVersion: 1 as const, approvalId: 'approval-1', attemptId: 'attempt-1', toolUseId: 'approval-call-1', answerer: 'user' as const, status: 'awaiting-user' as const, requestedAt: 10, revision: 1 },
      memoryTiers: [{ key: 'session' as const, label: '本会话' }], autoAnswerer: true,
      shellSecurityHints: { requiresRiskAck: true, outsideWorkDirRisk: false, warnings: ['检查命令副作用'], canTrust: true },
      autoApproveFallback: { reason: '自动批准失败', reasonCode: 'approval_unavailable' },
      currentPageUrl: 'https://example.com', dangerInfo: { userReason: '可能提交表单', consequence: 'file' as const, source: 'target-effect' as const },
      sessionTrustedHint: true as const
    }
    const restored = deserializeToolCallsFromDb(serializeToolCallsForDb([call]))?.[0]
    expect(restored).toMatchObject({
      approval: call.approval, memoryTiers: call.memoryTiers, autoAnswerer: true, shellSecurityHints: call.shellSecurityHints,
      autoApproveFallback: call.autoApproveFallback, currentPageUrl: call.currentPageUrl, dangerInfo: call.dangerInfo, sessionTrustedHint: true
    })
  })
  it('13: returns corrupted placeholder and logs on parse failure', () => {
    const result = deserializeToolCallsFromDb('not-valid-json{{{')
    expect(result).toHaveLength(1)
    expect(result![0]!.corrupted).toBe(true)
    expect(result![0]!.status).toBe('failed')
    expect(result![0]!.result?.success).toBe(false)
    expect(logAgentEvent).toHaveBeenCalledWith(
      'warn',
      'db.tool_calls.deserialize_failed',
      expect.objectContaining({ error: expect.any(String) })
    )
  })

  it('deserializes valid tool_calls including interrupted flag', () => {
    const raw = JSON.stringify([
      {
        id: 't1',
        toolName: 'read_file',
        input: '{}',
        status: 'failed',
        riskLevel: 'low',
        interrupted: true,
        result: { success: false, error: 'interrupted', data: undefined }
      }
    ])
    const result = deserializeToolCallsFromDb(raw)
    expect(result).toHaveLength(1)
    expect(result![0]!.interrupted).toBe(true)
    expect(result![0]!.input).toEqual({})
  })

  it('round-trips MCP metadata on tool calls (P0-B 持久化)', () => {
    const call = {
      id: 't-mcp',
      toolName: 'mcp_github_create_issue_12345678',
      input: { title: 'x' },
      status: 'completed' as const,
      riskLevel: 'medium' as const,
      mcp: { serverId: 'server-1', serverName: 'GitHub', originalToolName: 'create_issue' },
      result: { success: true, data: { ok: true } }
    }
    const serialized = serializeToolCallsForDb([call])
    const restored = deserializeToolCallsFromDb(serialized)
    expect(restored).toHaveLength(1)
    expect(restored![0]!.mcp).toEqual({
      serverId: 'server-1',
      serverName: 'GitHub',
      originalToolName: 'create_issue'
    })
    expect(restored![0]!.toolName).toBe('mcp_github_create_issue_12345678')
    expect(restored![0]!.result).toEqual({ success: true, data: { ok: true } })
  })

  it('round-trips shell process identity for restart orphan cleanup', () => {
    const call = {
      id: 't-shell', toolName: 'run_shell', input: { command: 'sleep 30' }, status: 'executing' as const,
      riskLevel: 'high' as const, processPid: 4321, processGroupId: 4321, processOwnerToken: 'request:t-shell'
    }
    const restored = deserializeToolCallsFromDb(serializeToolCallsForDb([call]))
    expect(restored?.[0]).toMatchObject({ processPid: 4321, processGroupId: 4321, processOwnerToken: 'request:t-shell' })
  })
})

describe('serializeToolCallsForDb：toolkit.call 凭据持久化净化（H3）', () => {
  it('toolkit.call 的 accessToken/headerValue/env 落库前布尔化（明文不进 messages.tool_calls）', () => {
    const raw = serializeToolCallsForDb([
      {
        id: 'tu-1',
        toolName: 'toolkit.call',
        input: {
          id: 'action.mcp.add',
          params: {
            name: 'srv',
            endpoint: 'https://example.com/mcp',
            accessToken: 'sk-secret-value',
            headerValue: 'Bearer xyz',
            env: { TOKEN: 'plain-secret' }
          }
        },
        status: 'completed'
      }
    ])
    const parsed = JSON.parse(raw!) as Array<{ input: string }>
    const input = JSON.parse(parsed[0]!.input) as { params: Record<string, unknown> }
    expect(input.params.accessToken).toBe(true)
    expect(input.params.headerValue).toBe(true)
    expect(JSON.stringify(input.params)).not.toContain('sk-secret-value')
    expect(JSON.stringify(input.params)).not.toContain('plain-secret')
    // 非凭据字段原样保留
    expect(input.params.endpoint).toBe('https://example.com/mcp')
    expect(input.params.name).toBe('srv')
  })

  it('非 toolkit 工具的 input 不净化（行为不变）', () => {
    const raw = serializeToolCallsForDb([
      { id: 'tu-2', toolName: 'write_file', input: { path: 'a.txt', content: 'x' }, status: 'completed' }
    ])
    expect(raw).toContain('a.txt')
  })
})
