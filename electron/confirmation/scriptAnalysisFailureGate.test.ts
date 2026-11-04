import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const scriptAnalysisMocks = vi.hoisted(() => ({ parsePythonModule: vi.fn(), collectPatternHits: vi.fn() }))
vi.mock('../shell/scriptContentSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shell/scriptContentSecurity')>()
  return { ...actual, parsePythonModule: scriptAnalysisMocks.parsePythonModule, collectPatternHits: scriptAnalysisMocks.collectPatternHits }
})

import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { createAgentSdkSafetyPolicy } from './agentSdkSafetyPolicy'
import { TypedToolRegistry } from '../tools/plannedToolRegistry'
import { createRunScriptRegisteredTool } from '../tools/runScriptRegisteredTool'
import { createRegisteredAgentTurnTools } from '../tools/registeredAgentTurnTools'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'

let workDir = ''
const unlocatedWriteIr = {
  body: [{
    kind: 'expr',
    value: {
      kind: 'call',
      callee: { kind: 'name', id: 'open' },
      args: [{ kind: 'string', value: 'out.txt' }, { kind: 'string', value: 'w' }],
      kwargs: []
    }
  }]
}
const locatedWriteIr = {
  body: [{
    kind: 'expr', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 21 },
    value: {
      kind: 'call', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 21 },
      callee: { kind: 'name', id: 'open', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 5 } },
      args: [
        { kind: 'string', value: 'out.txt', range: { startLine: 1, startCol: 6, endLine: 1, endCol: 15 } },
        { kind: 'string', value: 'w', range: { startLine: 1, startCol: 17, endLine: 1, endCol: 20 } }
      ],
      kwargs: []
    }
  }]
}
const unlocatedWriteWithNetworkIr = {
  body: [
    { kind: 'import', names: [{ module: 'requests' }] },
    unlocatedWriteIr.body[0],
    {
      kind: 'expr', range: { startLine: 3, startCol: 1, endLine: 3, endCol: 33 },
      value: {
        kind: 'call', range: { startLine: 3, startCol: 1, endLine: 3, endCol: 33 },
        callee: { kind: 'attr', base: { kind: 'name', id: 'requests' }, attr: 'get' },
        args: [{ kind: 'string', value: 'https://example.com' }], kwargs: []
      }
    }
  ]
}

beforeEach(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'script-analysis-failure-gate-')))
  scriptAnalysisMocks.parsePythonModule.mockReturnValue(unlocatedWriteIr)
  scriptAnalysisMocks.collectPatternHits.mockReturnValue([])
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function args(lane: 'desktop' | 'automation' = 'desktop', code = "open('out.txt', 'w')"): ToolCallGateArgs {
  const cache = { lookup: () => null, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }
  const taskAccessPermissions = {
    directories: [workDir],
    tools: ['run_script'],
    authorizationRecord: {
      id: 'script-analysis-failure-test', actor: 'user-confirmation', source: 'task-preflight-confirmation',
      approvedAt: 1, taskRevision: 1,
      permissions: [{ kind: 'run-script', scopeRoots: [workDir], scriptHashBinding: 'per-invocation' }]
    }
  }
  return {
    toolName: 'run_script', toolInput: { code }, sessionId: 'failure-session',
    requestId: `failure-${lane}`, toolUseId: `failure-tool-${lane}`, lane, workDir,
    userDataDir: path.join(workDir, '.userdata'), toolsConfig: DEFAULT_TOOLS_CONFIG,
    effectiveRules: DEFAULT_POLICY_RULES, lanePackage: 'standard',
    decisionCache: cache, shellPrecheck: { touchTrustedCommand: () => undefined },
    audit: { record: () => undefined }, ...(lane === 'automation' ? { taskAccessPermissions } : {})
  } as unknown as ToolCallGateArgs
}

describe('script analysis failure in the real tool-call gate', () => {
  it('missing finding position makes desktop use the locked human rule despite complete path facts', async () => {
    const result = await evaluateToolCallGate(args())
    expect(result.facts.signals).toContainEqual(expect.objectContaining({ kind: 'script-analysis', coverage: 'failed', findings: [], totalCount: 0 }))
    expect(result.facts.signals).toContainEqual(expect.objectContaining({ kind: 'extraction-failed', reason: 'script-analysis-location-unavailable' }))
    expect(result.facts.signals).toContainEqual(expect.objectContaining({ kind: 'script-path-extraction', completeness: 'complete' }))
    expect(result.decision).toMatchObject({ type: 'require-confirm', ruleId: 'script-analysis-incomplete-confirm', answerer: 'user' })
    expect(result.policyDecision).toMatchObject({
      ruleIds: expect.arrayContaining(['script-analysis-incomplete-confirm']),
      causes: expect.arrayContaining([{ ruleId: 'script-analysis-incomplete-confirm', relation: 'matched' }]),
      answerer: 'user'
    })
  })

  it('unlocated findings are discarded atomically while incomplete content still requires a human', async () => {
    const code = "import requests\nopen('out.txt', 'w')\nrequests.get('https://example.com')"
    scriptAnalysisMocks.parsePythonModule.mockReturnValue(unlocatedWriteWithNetworkIr)
    scriptAnalysisMocks.collectPatternHits.mockReturnValue([{ pattern: 'A6' }])
    const result = await evaluateToolCallGate(args('desktop', code))
    expect(result.facts.signals).toContainEqual(expect.objectContaining({ kind: 'script-analysis', coverage: 'failed', findings: [], totalCount: 0 }))
    expect(result.facts.signals).toContainEqual(expect.objectContaining({ kind: 'extraction-failed' }))
    expect(result.decision).toMatchObject({ type: 'require-confirm', ruleId: 'script-analysis-incomplete-confirm', answerer: 'user' })
  })

  it('does not enter the registered script executor before human approval', async () => {
    const invocationId = 'script-analysis-failure-e2e'
    const route = { routeId: 'script-analysis-failure', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test' }
    const executor = vi.fn(async () => ({ success: true, data: 'executed' }))
    const typedRegistry = new TypedToolRegistry()
    typedRegistry.register(createRunScriptRegisteredTool({ name: 'run_script', execute: executor } as never))
    const permits = new InMemorySafetyPermitStore()
    const registered = createRegisteredAgentTurnTools({
      requestId: invocationId, turnId: 'turn', registry: typedRegistry, permits,
      admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: (call) => ({ workDir, userDataDir: path.join(workDir, '.userdata'), requestId: invocationId,
        toolUseId: call.toolCallId, sessionId: 'failure-session', lane: 'desktop', toolsConfig: DEFAULT_TOOLS_CONFIG } as never),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['run_script'])
    const policy = createAgentSdkSafetyPolicy({
      resolveToolCall: registered.getPreparedCall,
      resolveGateArgs: async (_binding, call) => ({
        toolName: call!.toolName, toolInput: call!.input, sessionId: 'failure-session', workDir,
        userDataDir: path.join(workDir, '.userdata'), toolsConfig: DEFAULT_TOOLS_CONFIG,
        effectiveRules: DEFAULT_POLICY_RULES, lanePackage: 'standard',
        decisionCache: { lookup: () => null }, shellPrecheck: { touchTrustedCommand: () => undefined }
      } as never),
      evaluateGate: evaluateToolCallGate
    })
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy })
    const providers = new ModelProviderRegistry()
    async function* stream(...chunks: StreamChunk[]) { yield* chunks }
    const responses = [
      stream({ type: 'tool-call', toolCallId: 'script-failure-call', toolName: 'run_script', input: { code: "open('out.txt', 'w')" } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }),
      stream({ type: 'text-delta', text: 'stopped' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
    ]
    providers.register(route, { providerId: 'script-analysis-failure', stream: () => responses.shift()! })
    const history = new MemoryHistory()
    const confirmation = vi.fn(async () => ({ kind: 'denied' as const }))
    try {
      await expect(runAgentTurn({
        registry: providers, routeId: route.routeId, invocationId, turnId: 'turn',
        request: { messages: [{ role: 'user', content: 'run the script' }], maxTokens: 30 }, safetyGate,
        prepareTool: registered.prepareTool, discardPreparedTool: registered.discardPreparedTool,
        toolExecution: registered.toolExecution, confirmation, history, maxModelTurns: 2, maxConcurrentTools: 1
      })).rejects.toThrow('CONFIRMATION_DENIED')
      expect(confirmation).toHaveBeenCalledWith(expect.objectContaining({ answerer: 'user', reasonCode: 'script-analysis-incomplete-confirm' }))
      expect(executor).not.toHaveBeenCalled()
    } finally {
      registered.discardPreparedTool({ invocationId, toolCallId: 'script-failure-call', toolName: 'run_script', input: { code: "open('out.txt', 'w')" } })
    }
  })
})
