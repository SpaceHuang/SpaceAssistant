import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/capability'
import { SafetyGate } from '../src/safetyGate'
import { InMemorySafetyPermitStore } from '../src/safetyPermit'

const binding = {
  requestId: 'req', turnId: 'turn', invocationId: 'inv', toolCallId: 'call', capabilityId: 'files.write',
  inputSnapshotHash: 'input', planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'v1', phase: 'recheck' as const
}

describe('CapabilityRegistry and SafetyGate', () => {
  it('resolves policy per binding for invocation-scoped host facts', async () => {
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['files.write'])
    const evaluate = vi.fn(async (current: typeof binding & { capability: { state: 'known-authorized'; id: string } }) => ({
      kind: 'allow' as const,
      authorizationVersion: current.authorizationVersion
    }))
    const gate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), resolvePolicy: () => ({ evaluate }) })
    await gate.evaluate(binding)
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ invocationId: 'inv', capabilityId: 'files.write', authorizationVersion: 'v1' }))
  })

  it('fails closed for unknown and known unauthorized capabilities', async () => {
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['files.write'])
    const gate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'allow', authorizationVersion: 'v1' }) } })
    await expect(gate.authorize({ ...binding, capabilityId: 'not.listed' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'UNKNOWN_CAPABILITY' })
    capabilities.define('inv', ['files.write'], [])
    await expect(gate.authorize(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'UNAUTHORIZED_CAPABILITY' })
  })

  it('issues a permit only after host policy allows a known capability', async () => {
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv', ['files.write'])
    const gate = new SafetyGate({ capabilities, permitStore: new InMemorySafetyPermitStore(), policy: { evaluate: async () => ({ kind: 'allow', authorizationVersion: 'v1' }) } })
    const decision = await gate.authorize(binding)
    expect(decision.kind).toBe('allow')
    if (decision.kind === 'allow') expect(decision.permitId).toMatch(/^[a-f0-9]{48}$/)
  })
})
