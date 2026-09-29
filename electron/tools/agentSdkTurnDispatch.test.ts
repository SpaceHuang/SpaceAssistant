import { describe, expect, it, vi } from 'vitest'
import type { ContentFacts, Decision } from '../../src/shared/confirmation/types'
import type { ToolCallGateResult } from '../confirmation/toolCallGate'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { definePlannedTool } from './plannedToolRegistry'
import { createAgentSdkTurnDispatch } from './agentSdkTurnDispatch'

const facts: ContentFacts = { toolName: 'lookup', actionClass: 'read', baseRiskLevel: 'low', signals: [], summary: { text: 'lookup' } }
const gateResult = (decision: Decision, resultFacts = facts): ToolCallGateResult => ({ decision, facts: resultFacts, approvedFactIds: [] })

describe('createAgentSdkTurnDispatch', () => {
  it('在 coordinator execute 前完成一次 fresh gate 与 permit-bound dispatch', async () => {
    const events: string[] = []
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('req', 'desktop')
    const evaluate = vi.fn(async () => {
      events.push('fresh-gate')
      return gateResult({ type: 'require-confirm', ruleId: 'human', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 })
    })
    const dispatch = createAgentSdkTurnDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'policy-v1', currentAuthorizationVersion: () => 'policy-v1',
      targetVersion: 'human:require-confirm', initialRuleId: 'human', initialFacts: facts,
      previouslyConfirmed: true, resolveAuthorizationVersion: () => 'policy-v1',
      isAllowed: () => !revocations.isToolRevoked('req', 'lookup'), isRevoked: () => revocations.isToolRevoked('req', 'lookup'),
      evaluate, toolRevocations: revocations
    })
    const tool = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string }, plan: async (input) => input,
      execute: async () => { events.push('execute'); return 'result' }
    })

    await expect(executeRegisteredTool(tool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'call', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })).resolves.toBe('result')
    expect(events).toEqual(['fresh-gate', 'execute'])
    expect(evaluate).toHaveBeenCalledOnce()
  })

  it('fresh facts 与初始授权不一致时在 executor 前拒绝', async () => {
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('req', 'desktop')
    const changedFacts = { ...facts, summary: { text: 'different target' } }
    const execute = vi.fn(async () => 'must not run')
    const dispatch = createAgentSdkTurnDispatch({
      requestId: 'req', turnId: 'turn', canonicalInput: { query: 'weather' },
      authorizationVersion: 'policy-v1', targetVersion: 'human:require-confirm',
      initialRuleId: 'human', initialFacts: facts, previouslyConfirmed: true,
      resolveAuthorizationVersion: () => 'policy-v1', isAllowed: () => true, isRevoked: () => false,
      evaluate: async () => gateResult({ type: 'require-confirm', ruleId: 'human', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }, changedFacts),
      toolRevocations: revocations
    })
    const tool = definePlannedTool({
      name: 'lookup', parseInput: (raw) => raw as { query: string }, plan: async (input) => input, execute
    })

    await expect(executeRegisteredTool(tool, { query: 'weather' }, {
      requestId: 'req', toolUseId: 'call', signal: new AbortController().signal
    }, { confirm: async () => true, dispatch })).rejects.toThrow('RECHECK_DENIED')
    expect(execute).not.toHaveBeenCalled()
  })
})
