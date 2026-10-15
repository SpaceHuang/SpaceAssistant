import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff, markAgentSdkSafetyDecisionConfirmed } from '../confirmation/agentSdkSafetyPolicy'
import { createWriteFileRegisteredTools } from './writeFileRegisteredTools'
import { createRegisteredAgentTurnTools } from './registeredAgentTurnTools'
import { TypedToolRegistry } from './plannedToolRegistry'

const route = { routeId: 'write-reapproval-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }

async function* stream(...chunks: StreamChunk[]) { yield* chunks }

describe('synchronous reapproval of a changed write target', () => {
  it('replans the real write adapter against the newly approved target and dispatches once', async () => {
    const invocationId = 'write-reapproval-invocation'
    const toolCallId = 'write-reapproval-call'
    const call = { invocationId, toolCallId, toolName: 'write_file', input: { path: 'a.txt', content: 'new text' } }
    const execution = vi.fn(async (_input: Record<string, unknown>, context: { writeExecutionPermit?: { target: { identity?: { ino?: number } } } }) => ({
      success: true,
      data: { approvedTargetInode: context.writeExecutionPermit?.target.identity?.ino }
    }))
    const registry = new TypedToolRegistry()
    registry.register(createWriteFileRegisteredTools({
      writeFile: { name: 'write_file', execute: execution } as never,
      editFile: { name: 'edit_file', execute: execution } as never
    })[0]!)
    const permits = new InMemorySafetyPermitStore()
    const tools = createRegisteredAgentTurnTools({
      requestId: 'write-reapproval-request', turnId: 'write-reapproval-turn', registry, permits,
      admission: new InMemoryExecutionAdmissionCoordinator(),
      createExecutionContext: () => ({ workDir: '/workspace', requestId: 'write-reapproval-request' }),
      resolveAuthorizationVersion: () => 'policy-v1'
    })
    let targetChanged = false
    const target = (ino: number) => ({
      rawPath: 'a.txt', normalizedPath: '/workspace/a.txt', zone: 'workdir-normal', targetKind: 'file',
      parentReal: '/workspace', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 2 },
      identity: { dev: 1, ino, mode: 0o100644, size: 4, mtimeMs: 1, nlink: 1 }
    })
    const gateArgs = { toolName: call.toolName, toolInput: call.input, workDir: '/workspace', userDataDir: '/tmp', toolsConfig: {}, lane: 'desktop' } as never
    const handoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: tools.updateExecutionContext })
    const policy = createAgentSdkSafetyPolicy({
      resolveToolCall: () => call,
      resolveGateArgs: async () => gateArgs,
      evaluateGate: async () => {
        const inode = targetChanged ? 4 : 3
        const facts = { targetInode: inode }
        return {
          decision: { type: 'require-confirm', ruleId: 'write-confirm', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: null, disposition: 'human-required' },
          facts, approvedFactIds: [], writePathFact: target(inode)
        } as never
      },
      ...handoff
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['write_file'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy })
    const providers = new ModelProviderRegistry()
    let requests = 0
    providers.register(route, { providerId: 'write-reapproval-provider', stream: (request) => {
      requests += 1
      if (request.request.messages.some((message) => message.role === 'tool')) {
        return stream({ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'stop' })
      }
      return stream(
        { type: 'tool-call', toolCallId, toolName: 'write_file', input: call.input },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    let confirmationCount = 0
    const history = new MemoryHistory()
    await runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId: 'write-reapproval-turn',
      request: { messages: [{ role: 'user', content: 'write the file' }], maxTokens: 50 },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, history, maxModelTurns: 2,
      confirmation: async () => {
        confirmationCount += 1
        if (confirmationCount === 1) targetChanged = true
        markAgentSdkSafetyDecisionConfirmed(policy, call, 'user')
        return { kind: 'approved', receipt: `user-approved-${confirmationCount}`, answerer: 'user' }
      }
    })

    expect(confirmationCount).toBe(2)
    expect(execution).toHaveBeenCalledOnce()
    expect(execution.mock.calls[0]?.[1].writeExecutionPermit?.target.identity?.ino).toBe(4)
    expect(requests).toBe(2)
    expect((await history.read(invocationId)).events).not.toContainEqual(expect.objectContaining({ kind: 'tool-call-not-dispatched', payload: expect.objectContaining({ reasonCode: 'WRITE_PREPARED_PERMIT_CHANGED' }) }))
  })
})
