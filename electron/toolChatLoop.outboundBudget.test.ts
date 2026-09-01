import { describe, expect, it } from 'vitest'
import { evaluateToolCallGate, isOutboundWriteTool, type ToolCallGateArgs } from './confirmation/toolCallGate'
import {
  createRemoteTaskBudgetState,
  recordOutboundWrite,
  type RemoteTaskBudgetState
} from './remote/remoteTaskBudget'
import { DEFAULT_FEISHU_CONFIG } from '../src/shared/feishuTypes'
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../src/shared/domainTypes'
import type { RemoteContext } from './tools/types'

const feishuRemote: RemoteContext = {
  source: 'feishu',
  messageId: 'm1',
  confirmPolicy: 'always'
}
const wechatRemote: RemoteContext = {
  source: 'wechat',
  messageId: 'm1',
  confirmPolicy: 'always'
}

const larkMessageSend = { args: ['message', 'send', '--receive-id', 'ou_1'] }
const larkDocGet = { args: ['doc', 'get', '--token', 't'] }

const toolsConfig: ToolsConfig = { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] }

function gateArgs(
  toolName: string,
  toolInput: Record<string, unknown>,
  overrides: Partial<ToolCallGateArgs> = {}
): ToolCallGateArgs {
  return {
    toolName,
    toolInput,
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig,
    audit: { record: () => undefined },
    ...overrides
  }
}

/** 模拟主循环：gate 判定通过且为出站写工具时记账（recordOutboundWrite 留执行链路）。 */
async function gateAndRecord(state: RemoteTaskBudgetState, toolName: string, input: Record<string, unknown>, ctx: RemoteContext) {
  const r = await evaluateToolCallGate(
    gateArgs(toolName, input, { remoteContext: ctx, remoteBudgetState: state })
  )
  if (r.decision.type !== 'deny' && isOutboundWriteTool(toolName, input)) {
    recordOutboundWrite(state)
  }
  return r
}

function budgetState(maxConsecutiveOutboundWrites: number): RemoteTaskBudgetState {
  return createRemoteTaskBudgetState('task-1', {
    maxToolCalls: 100,
    maxExecutionWallSec: 900,
    maxConcurrentExecutions: 1,
    maxConsecutiveOutboundWrites
  })
}

describe('outbound write budget gate (经 toolCallGate + 规则 remote-outbound-budget-pause-*)', () => {
  it('allows N consecutive outbound writes then blocks N+1 without recording', async () => {
    const state = budgetState(3)

    for (let i = 0; i < 3; i++) {
      const r = await gateAndRecord(state, 'run_lark_cli', larkMessageSend, feishuRemote)
      expect(r.decision.type).not.toBe('deny')
    }
    expect(state.consecutiveOutboundWrites).toBe(3)

    const blocked = await gateAndRecord(state, 'wechat_reply', { text: 'hi' }, wechatRemote)
    expect(blocked.decision.type).toBe('deny')
    expect(blocked.decision.ruleId).toBe('remote-outbound-budget-pause-wechat')
    expect(blocked.budgetPause?.reason).toBe('consecutive_outbound_writes')
    expect(blocked.budgetPause?.message).toMatch(/连续外部写已达 3 次/)
    expect(blocked.budgetPause?.message).toMatch(/继续/)
    // gate 只读 peek 不记账；主循环对 deny 不记账 → 计数不变
    expect(state.consecutiveOutboundWrites).toBe(3)
  })

  it('does not count lark read ops against consecutive outbound writes', async () => {
    const state = budgetState(1)
    for (let i = 0; i < 20; i++) {
      const r = await gateAndRecord(state, 'run_lark_cli', larkDocGet, feishuRemote)
      expect(r.decision.type).toBe('auto-allow')
    }
    expect(state.consecutiveOutboundWrites).toBe(0)
    const w1 = await gateAndRecord(state, 'run_lark_cli', larkMessageSend, feishuRemote)
    expect(w1.decision.type).not.toBe('deny')
    expect(state.consecutiveOutboundWrites).toBe(1)
    const w2 = await gateAndRecord(state, 'run_lark_cli', larkMessageSend, feishuRemote)
    expect(w2.decision.type).toBe('deny')
  })

  it('counts unknown / non-string lark argv as outbound writes (fail closed)', async () => {
    const state = budgetState(1)
    const r1 = await gateAndRecord(state, 'run_lark_cli', { args: ['doc', 1] }, feishuRemote)
    expect(r1.decision.type).not.toBe('deny')
    expect(state.consecutiveOutboundWrites).toBe(1)
    const r2 = await gateAndRecord(state, 'run_lark_cli', { args: [1] }, feishuRemote)
    expect(r2.decision.type).toBe('deny')
  })

  it('ignores non-outbound tools', async () => {
    const state = budgetState(1)
    const r0 = await gateAndRecord(state, 'read_file', {}, wechatRemote)
    expect(r0.decision.type).not.toBe('deny')
    expect(state.consecutiveOutboundWrites).toBe(0)
    const r1 = await gateAndRecord(state, 'wechat_send', { text: 'x' }, wechatRemote)
    expect(r1.decision.type).not.toBe('deny')
    expect(state.consecutiveOutboundWrites).toBe(1)
    const r2 = await gateAndRecord(state, 'wechat_send', { text: 'x' }, wechatRemote)
    expect(r2.decision.type).toBe('deny')
  })
})

describe('denyOutbound uses impact classifier (规则 remote-deny-lark-write-outbound)', () => {
  const denyCfg = { ...DEFAULT_FEISHU_CONFIG, remoteDenyOutbound: true }

  it('blocks doc delete / permission even when old write-pair list misses them', async () => {
    for (const input of [{ args: ['doc', 'delete', '--token', 't'] }, { args: ['doc', 'permission', 'update'] }]) {
      const r = await evaluateToolCallGate(
        gateArgs('run_lark_cli', input, { remoteContext: feishuRemote, feishuConfig: denyCfg })
      )
      expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'remote-deny-lark-write-outbound' })
      expect(r.decision.type === 'deny' && r.decision.reason).toMatch(/禁止/)
    }
    const read = await evaluateToolCallGate(
      gateArgs('run_lark_cli', larkDocGet, { remoteContext: feishuRemote, feishuConfig: denyCfg })
    )
    expect(read.decision.type).not.toBe('deny')
  })

  it('non-string args are rejected without throwing when denyOutbound', async () => {
    const r = await evaluateToolCallGate(
      gateArgs('run_lark_cli', { args: [1] }, { remoteContext: feishuRemote, feishuConfig: denyCfg })
    )
    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'remote-deny-lark-write-outbound' })
  })
})
