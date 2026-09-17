/**
 * P2-2 审批执行链：复用管家模式（createSession internal/hidden → resolveTrustedTurnExecutionConfig
 * → runToolChatSession），Profile 有界（轮数 ≤3、超时 30s），输出两态裁决，失败一律 deny。
 * P2-7 准入死锁禁令：审批调用绝不经过 butlerAdmission 取票。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockRunToolChatSession = vi.fn()
const mockCreateSession = vi.fn()

vi.mock('../toolChatLoop', () => ({
  runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...args)
}))

vi.mock('../database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database')>()
  return {
    ...actual,
    createSession: (...args: unknown[]) => mockCreateSession(...args)
  }
})

import { runApprovalAgent } from './approvalAgent'
import type { ApprovalCluePack, ApprovalInvocation } from '../../src/shared/confirmation/types'

function clue(overrides: Partial<ApprovalCluePack> = {}): ApprovalCluePack {
  return {
    toolName: 'write_file',
    actionClass: 'write',
    riskLevel: 'medium',
    summary: 'write_file out.txt',
    signals: ['path-target'],
    targetPath: 'out.txt',
    ...overrides
  }
}

function invocation(overrides: Partial<ApprovalInvocation> = {}): ApprovalInvocation {
  return {
    clue: clue(),
    lane: 'automation',
    sessionId: 'sess-outer',
    requestId: 'req-outer',
    invocationId: 'inv-1',
    profileId: 'approval-default',
    timeoutMs: 30_000,
    ...overrides
  }
}

const deps = {
  db: {} as never,
  workDir: '/tmp/wd',
  userDataDir: '/tmp/ud',
  getToolsConfig: () => ({}) as never,
  getShellConfig: () => null,
  getBrowserConfig: () => undefined,
  getUserDataPath: () => '/tmp/ud',
  resolveWorkDirForSession: () => '/tmp/wd',
  getWorkDir: () => '/tmp/wd'
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateSession.mockImplementation(() => ({ id: 'sess-approval-1', name: '审批', createdAt: 1 }))
})

describe('runApprovalAgent（P2-2 审批执行链）', () => {
  it('approve 裁决：两态 JSON 解析为 verdict', async () => {
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: '前置说明\n{"kind":"approve","reason":{"summary":"常规写入，风险可控"}}' }]
    })
    const res = await runApprovalAgent(deps, invocation())
    expect(res).toMatchObject({ ok: true, verdict: { kind: 'approve' } })
    expect(res.ok === true && res.verdict.reason.summary).toBe('常规写入，风险可控')
  })

  it('deny 裁决：同理解析', async () => {
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: '{"kind":"deny","reason":{"summary":"敏感路径，拒绝"}}' }]
    })
    const res = await runApprovalAgent(deps, invocation())
    expect(res).toMatchObject({ ok: true, verdict: { kind: 'deny' } })
  })

  it('输出不可解析（非两态 JSON）→ deny + cause=unparsable（I4，无中间态）', async () => {
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: '我觉得风险不大，可以执行。' }]
    })
    const res = await runApprovalAgent(deps, invocation())
    expect(res).toEqual({ ok: false, cause: 'unparsable' })
  })

  it('runToolChatSession 失败 → deny + cause=unavailable', async () => {
    mockRunToolChatSession.mockResolvedValue({ ok: false, error: 'LLM 不可用' })
    const res = await runApprovalAgent(deps, invocation())
    expect(res).toEqual({ ok: false, cause: 'unavailable' })
  })

  it('内层抛错 → deny + cause=unavailable（不向上抛）', async () => {
    mockRunToolChatSession.mockRejectedValue(new Error('boom'))
    const res = await runApprovalAgent(deps, invocation())
    expect(res).toEqual({ ok: false, cause: 'unavailable' })
  })

  it('超时上界：内层挂起 → inv.timeoutMs 到期 deny + cause=timeout', async () => {
    vi.useFakeTimers()
    mockRunToolChatSession.mockReturnValue(new Promise(() => undefined))
    const pending = runApprovalAgent(deps, invocation({ timeoutMs: 50 }))
    const done = vi.fn()
    void pending.then(done)
    await vi.advanceTimersByTimeAsync(80)
    expect(done).toHaveBeenCalled()
    const res = await pending
    expect(res).toEqual({ ok: false, cause: 'timeout' })
    vi.useRealTimers()
  })

  it('执行链形态：internal/hidden 会话 + automation lane + 递归豁免标记 + 轮数≤3 + 封闭只读工具集', async () => {
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: '{"kind":"deny","reason":{"summary":"x"}}' }]
    })
    await runApprovalAgent(deps, invocation())
    // 会话归属：审批内部会话 internal/hidden（复用管家 P3 机制）
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownership: 'internal', visibility: 'hidden' })
    )
    const args = mockRunToolChatSession.mock.calls[0]![0] as Record<string, unknown>
    expect(args.lane).toBe('automation')
    expect(args.internalConfirmExemption).toBe('approval-agent')
    expect(args.maxToolLoopRounds).toBeLessThanOrEqual(3)
    const toolsConfig = args.toolsConfig as { allowedTools: string[] }
    // 封闭只读集合：只含侦查类只读工具，无写/执行工具
    for (const t of toolsConfig.allowedTools) {
      expect(['read_file', 'list_directory', 'grep', 'list_work_dirs', 'history.read', 'skills.read']).toContain(t)
    }
    // 输入形态：facts + 线索包（单条 user 消息，不给全量会话）
    const messages = args.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content).toContain('write_file')
    expect(messages[0]!.content).toContain('out.txt')
  })

  it('P2-7 准入死锁禁令：外层持票（并发=1）状态下审批调用限时完成、不复取票', async () => {
    // 真 ButlerAdmission，外层先取唯一票据；若审批链再取票即被拒/排队，限时完成即证明不取票
    const { ButlerAdmission } = await import('../butler/butlerAdmission')
    const admission = new ButlerAdmission()
    const outer = await admission.acquire('outer-req')
    if (!outer.ok) throw new Error('外层取票应成功')
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: '{"kind":"approve","reason":{"summary":"ok"}}' }]
    })
    const res = await Promise.race([
      runApprovalAgent(deps, invocation()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('审批在持票状态下未限时完成')), 2000))
    ])
    expect(res).toMatchObject({ ok: true })
    outer.release()
  })
})
