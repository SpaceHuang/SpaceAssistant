import { describe, expect, it } from 'vitest'
import {
  evaluateOutboundWriteBudgetGateForTests,
  evaluateRemoteToolBlockForTests
} from './toolChatLoop'
import { createRemoteTaskBudgetState } from './remote/remoteTaskBudget'
import { DEFAULT_FEISHU_CONFIG } from '../src/shared/feishuTypes'
import type { RemoteContext } from './tools/types'

const feishuRemote: RemoteContext = {
  source: 'feishu',
  messageId: 'm1',
  confirmPolicy: 'always'
}

const larkMessageSend = { args: ['message', 'send', '--receive-id', 'ou_1'] }
const larkDocGet = { args: ['doc', 'get', '--token', 't'] }

describe('outbound write budget gate (tool loop)', () => {
  it('allows N consecutive outbound writes then blocks N+1 without recording', () => {
    const state = createRemoteTaskBudgetState('task-1', {
      maxToolCalls: 100,
      maxExecutionWallSec: 900,
      maxConcurrentExecutions: 1,
      maxConsecutiveOutboundWrites: 3
    })

    for (let i = 0; i < 3; i++) {
      const gate = evaluateOutboundWriteBudgetGateForTests(state, 'run_lark_cli', larkMessageSend)
      expect(gate.allow).toBe(true)
    }
    expect(state.consecutiveOutboundWrites).toBe(3)

    const blocked = evaluateOutboundWriteBudgetGateForTests(state, 'wechat_reply', { text: 'hi' })
    expect(blocked.allow).toBe(false)
    if (!blocked.allow) {
      expect(blocked.reason).toBe('consecutive_outbound_writes')
      expect(blocked.message).toMatch(/连续外部写已达 3 次/)
      expect(blocked.message).toMatch(/继续/)
    }
    // Failed gate must not increment, otherwise subsequent writes would keep passing.
    expect(state.consecutiveOutboundWrites).toBe(3)
  })

  it('does not count lark read ops against consecutive outbound writes', () => {
    const state = createRemoteTaskBudgetState('task-1', {
      maxToolCalls: 100,
      maxExecutionWallSec: 900,
      maxConcurrentExecutions: 1,
      maxConsecutiveOutboundWrites: 1
    })
    for (let i = 0; i < 20; i++) {
      expect(evaluateOutboundWriteBudgetGateForTests(state, 'run_lark_cli', larkDocGet).allow).toBe(
        true
      )
    }
    expect(state.consecutiveOutboundWrites).toBe(0)
    // A real write still consumes budget after many reads.
    expect(evaluateOutboundWriteBudgetGateForTests(state, 'run_lark_cli', larkMessageSend).allow).toBe(
      true
    )
    expect(state.consecutiveOutboundWrites).toBe(1)
    expect(evaluateOutboundWriteBudgetGateForTests(state, 'run_lark_cli', larkMessageSend).allow).toBe(
      false
    )
  })

  it('counts unknown / non-string lark argv as outbound writes (fail closed)', () => {
    const state = createRemoteTaskBudgetState('task-1', {
      maxToolCalls: 100,
      maxExecutionWallSec: 900,
      maxConcurrentExecutions: 1,
      maxConsecutiveOutboundWrites: 1
    })
    expect(
      evaluateOutboundWriteBudgetGateForTests(state, 'run_lark_cli', { args: ['doc', 1] }).allow
    ).toBe(true)
    expect(state.consecutiveOutboundWrites).toBe(1)
    expect(
      evaluateOutboundWriteBudgetGateForTests(state, 'run_lark_cli', { args: [1] }).allow
    ).toBe(false)
  })

  it('ignores non-outbound tools', () => {
    const state = createRemoteTaskBudgetState('task-1', {
      maxToolCalls: 100,
      maxExecutionWallSec: 900,
      maxConcurrentExecutions: 1,
      maxConsecutiveOutboundWrites: 1
    })
    expect(evaluateOutboundWriteBudgetGateForTests(state, 'read_file').allow).toBe(true)
    expect(state.consecutiveOutboundWrites).toBe(0)
    expect(evaluateOutboundWriteBudgetGateForTests(state, 'wechat_send', { text: 'x' }).allow).toBe(
      true
    )
    expect(state.consecutiveOutboundWrites).toBe(1)
    expect(evaluateOutboundWriteBudgetGateForTests(state, 'wechat_send', { text: 'x' }).allow).toBe(
      false
    )
  })
})

describe('denyOutbound uses impact classifier', () => {
  it('blocks doc delete / permission even when old write-pair list misses them', () => {
    const denyCfg = { ...DEFAULT_FEISHU_CONFIG, remoteDenyOutbound: true }
    expect(
      evaluateRemoteToolBlockForTests(
        'run_lark_cli',
        { args: ['doc', 'delete', '--token', 't'] },
        feishuRemote,
        denyCfg
      )
    ).toMatch(/禁止/)
    expect(
      evaluateRemoteToolBlockForTests(
        'run_lark_cli',
        { args: ['doc', 'permission', 'update'] },
        feishuRemote,
        denyCfg
      )
    ).toMatch(/禁止/)
    expect(
      evaluateRemoteToolBlockForTests(
        'run_lark_cli',
        { args: ['doc', 'get', '--token', 't'] },
        feishuRemote,
        denyCfg
      )
    ).toBeNull()
  })

  it('non-string args are rejected without throwing when denyOutbound', () => {
    const denyCfg = { ...DEFAULT_FEISHU_CONFIG, remoteDenyOutbound: true }
    expect(() =>
      evaluateRemoteToolBlockForTests('run_lark_cli', { args: [1] }, feishuRemote, denyCfg)
    ).not.toThrow()
    expect(
      evaluateRemoteToolBlockForTests('run_lark_cli', { args: [1] }, feishuRemote, denyCfg)
    ).toMatch(/禁止/)
  })
})
