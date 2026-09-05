import { describe, expect, it } from 'vitest'
import { defineDirectTool, definePlannedTool, TypedToolRegistry } from './plannedToolRegistry'

const context = { requestId: 'r1', toolUseId: 'u1' }
const execution = { ...context, signal: new AbortController().signal }

describe('plannedToolRegistry', () => {
  it('TypedToolRegistry 只注册判别式 RegisteredTool 并拒绝重复名称', () => {
    const registry = new TypedToolRegistry()
    const direct = defineDirectTool({ name: 'direct-registry', parseInput: (raw) => raw, execute: async () => 'ok' })
    registry.register(direct)
    expect(registry.get('direct-registry')?.kind).toBe('direct')
    expect(registry.entries()).toHaveLength(1)
    expect(() => registry.register(direct)).toThrow('TOOL_ALREADY_REGISTERED:direct-registry')
  })

  it('legacy direct executor 共享同一 registry 名称唯一性约束', () => {
    const registry = new TypedToolRegistry()
    const executor = { name: 'legacy', execute: async () => ({ success: true }) }
    registry.registerLegacyExecutor(executor)
    expect(registry.getLegacyExecutor('legacy')).toBe(executor)
    expect(registry.get('legacy')?.kind).toBe('direct')
    expect(registry.entries().map((tool) => tool.name)).toEqual(['legacy'])
    expect(registry.legacyEntries()).toEqual([executor])
    expect(() => registry.registerLegacyExecutor(executor)).toThrow('TOOL_ALREADY_REGISTERED:legacy')
    const direct = defineDirectTool({ name: 'direct-duplicate', parseInput: (raw) => raw, execute: async () => 'ok' })
    registry.register(direct)
    expect(registry.get('direct-duplicate')).toBe(direct)
  })

  it('legacy executor 的 typed direct 视图执行时消费 runtimeContext', async () => {
    let received: unknown
    const registry = new TypedToolRegistry()
    registry.registerLegacyExecutor({
      name: 'legacy-runtime',
      execute: async (input, runtime) => {
        received = { input, runtime }
        return { success: true }
      }
    })
    const tool = registry.get('legacy-runtime')
    expect(tool?.kind).toBe('direct')
    const handle = await tool!.begin({ value: 1 }, context)
    handle.confirm()
    const runtime = { requestId: 'r1', toolUseId: 'u1', signal: execution.signal } as never
    await expect(handle.execute({ ...execution, runtimeContext: runtime })).resolves.toEqual({ success: true })
    expect(received).toEqual({ input: { value: 1 }, runtime })
  })

  it('planned registration 可以覆盖先生成的 legacy direct 迁移别名', () => {
    const registry = new TypedToolRegistry()
    registry.registerLegacyExecutor({ name: 'migration-order', execute: async () => ({ success: true }) })
    const planned = definePlannedTool({
      name: 'migration-order',
      parseInput: (raw) => raw,
      plan: async () => ({ frozen: true }),
      execute: async () => 'planned'
    })
    registry.register(planned)
    expect(registry.get('migration-order')).toBe(planned)
    expect(registry.get('migration-order')?.kind).toBe('planned')
    expect(registry.getLegacyExecutor('migration-order')).toBeTruthy()
  })
  it('支持 direct 工具并拒绝未确认和重复执行', async () => {
    const tool = defineDirectTool({ name: 'echo', parseInput: (raw) => String(raw), execute: async (input) => input })
    const handle = await tool.begin('ok', context)
    await expect(handle.execute(execution)).rejects.toThrow('INVOCATION_NOT_CONFIRMED')
    handle.confirm()
    await expect(handle.execute(execution)).resolves.toBe('ok')
    await expect(handle.execute(execution)).rejects.toThrow('INVOCATION_ALREADY_EXECUTED')
  })

  it('failed 是终态：失败后不能再次 execute，重复 fail 不改变终态', async () => {
    const tool = defineDirectTool({ name: 'failed-terminal', parseInput: (raw) => raw, execute: async () => 'never' })
    const handle = await tool.begin({}, context)
    handle.confirm()
    handle.fail()
    handle.fail()
    expect(handle.state).toBe('failed')
    await expect(handle.execute(execution)).rejects.toThrow('INVOCATION_ALREADY_FAILED')
  })

  it('拒绝跨 request/toolUse identity 复用 invocation', async () => {
    const tool = defineDirectTool({ name: 'identity', parseInput: (raw) => raw, execute: async () => 'ok' })
    const handle = await tool.begin({}, context)
    handle.confirm()
    await expect(handle.execute({ ...execution, requestId: 'other-request' })).rejects.toThrow('INVOCATION_IDENTITY_MISMATCH')
    await expect(handle.execute(execution)).resolves.toBe('ok')
  })

  it('拒绝跨工具复用 invocation', async () => {
    const tool = defineDirectTool({ name: 'source-tool', parseInput: (raw) => raw, execute: async () => 'ok' })
    const handle = await tool.begin({}, context)
    handle.confirm()
    await expect(handle.execute({ ...execution, toolName: 'other-tool' })).rejects.toThrow('INVOCATION_TOOL_IDENTITY_MISMATCH')
  })

  it('planned 工具只把私有 plan 交给 execute，plan 失败不降级', async () => {
    let received: unknown
    const tool = definePlannedTool({
      name: 'planned', parseInput: (raw) => ({ raw }),
      plan: async (input) => ({ canonical: input.raw }),
      execute: async (plan) => { received = plan; return 'done' }
    })
    const handle = await tool.begin('value', context)
    expect(handle.state).toBe('planned')
    handle.awaitConfirmation()
    expect(handle.stateHistory).toEqual(['planning', 'planned', 'awaiting-confirm'])
    handle.confirm()
    await expect(handle.execute(execution)).resolves.toBe('done')
    expect(received).toEqual({ canonical: 'value' })
    expect(handle.prepared.kind).toBe('planned')
    expect(handle.prepared.requestId).toBe('r1')
    expect(handle.prepared.toolUseId).toBe('u1')
    expect(Object.isFrozen(handle.prepared)).toBe(true)
    expect(Reflect.ownKeys(handle.prepared).some((key) => typeof key === 'symbol')).toBe(true)
  })

  it('深度冻结 planned payload，确认后外部修改不会改变执行事实', async () => {
    const input = { nested: { value: 'before' } }
    let received: any
    const tool = definePlannedTool({
      name: 'freeze', parseInput: (raw) => raw as typeof input,
      plan: async (raw) => ({ nested: raw.nested }),
      execute: async (plan) => { received = plan; return 'ok' }
    })
    const handle = await tool.begin(input, context)
    input.nested.value = 'after'
    handle.awaitConfirmation()
    handle.confirm()
    await handle.execute(execution)
    expect(received.nested.value).toBe('before')
    expect(Object.isFrozen(received.nested)).toBe(true)
  })

  it('plan 失败直接向调用方传播', async () => {
    const tool = definePlannedTool({ name: 'broken', parseInput: (raw) => raw, plan: async () => { throw new Error('PLAN_FAILED') }, execute: async () => 'never' })
    await expect(tool.begin({}, context)).rejects.toThrow('PLAN_FAILED')
  })

  it('planning handle 可观察 planning、planned 和 failed 状态', async () => {
    let releasePlan!: () => void
    const tool = definePlannedTool({
      name: 'observable-planning',
      parseInput: (raw) => raw,
      plan: async () => new Promise<{ ok: true }>((resolve) => { releasePlan = () => resolve({ ok: true }) }),
      execute: async () => 'ok'
    })
    const planning = tool.beginPlanning({}, context)
    expect(planning.state).toBe('planning')
    expect(planning.stateHistory).toEqual(['planning'])
    releasePlan()
    const handle = await planning.result
    expect(handle.state).toBe('planned')
    expect(planning.stateHistory).toEqual(['planning', 'planned'])

    const failed = definePlannedTool({
      name: 'observable-failed',
      parseInput: (raw) => raw,
      plan: async () => { throw new Error('PLAN_FAILED_OBSERVABLE') },
      execute: async () => 'never'
    }).beginPlanning({}, context)
    await expect(failed.result).rejects.toThrow('PLAN_FAILED_OBSERVABLE')
    expect(failed.state).toBe('failed')
    expect(failed.stateHistory).toEqual(['planning', 'failed'])
  })

  it('planned validator 在 execute 前运行，失败时不执行工具副作用', async () => {
    let executed = false
    const tool = definePlannedTool({
      name: 'stale-plan',
      parseInput: (raw) => raw,
      plan: async () => ({ revision: 'old' }),
      validate: async (plan) => {
        expect(plan.revision).toBe('old')
        throw new Error('PLAN_STALE')
      },
      execute: async () => { executed = true; return 'unexpected' }
    })
    const handle = await tool.begin({}, context)
    handle.awaitConfirmation()
    handle.confirm()
    await expect(handle.execute(execution)).rejects.toThrow('PLAN_STALE')
    expect(executed).toBe(false)
    expect(handle.state).toBe('failed')
  })

  it('planning 使用调用方 AbortSignal，取消后不生成执行句柄', async () => {
    const controller = new AbortController()
    const tool = definePlannedTool({
      name: 'cancel-plan', parseInput: (raw) => raw,
      plan: async (_raw, planningContext) => { controller.abort(); expect(planningContext.signal).toBe(controller.signal); return { ok: true } },
      execute: async () => 'never'
    })
    await expect(tool.begin({}, { ...context, signal: controller.signal })).rejects.toThrow('PLAN_CANCELLED')
  })

  it('planDigest 使用稳定 SHA-256，键顺序不影响摘要且修改会失效', async () => {
    const first = definePlannedTool({
      name: 'digest', parseInput: (raw) => raw as { a: number; b: number },
      plan: async (input) => ({ a: input.a, b: input.b }), execute: async () => 'ok'
    })
    const second = definePlannedTool({
      name: 'digest', parseInput: (raw) => raw as { a: number; b: number },
      plan: async (input) => ({ b: input.b, a: input.a }), execute: async () => 'ok'
    })
    const a = await first.begin({ a: 1, b: 2 }, context)
    const b = await second.begin({ a: 1, b: 2 }, context)
    expect(a.prepared.planDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(a.prepared.planDigest).toBe(b.prepared.planDigest)
    const changed = await first.begin({ a: 1, b: 3 }, context)
    expect(changed.prepared.planDigest).not.toBe(a.prepared.planDigest)
  })

  it('绑定 factsDigest 和 displayDigest，事实或展示投影变化会失效', async () => {
    const tool = definePlannedTool({
      name: 'projection', parseInput: (raw) => raw as { command: string },
      plan: async (input) => ({ command: input.command, cwd: '/tmp' }),
      facts: (plan) => ({ cwd: plan.cwd, command: plan.command }),
      display: (plan) => ({ text: `运行：${plan.command}` }),
      execute: async () => 'ok'
    })
    const first = await tool.begin({ command: 'echo a' }, context)
    const second = await tool.begin({ command: 'echo b' }, context)
    expect(first.prepared.factsDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.prepared.displayDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.prepared.factsDigest).not.toBe(second.prepared.factsDigest)
    expect(first.prepared.displayDigest).not.toBe(second.prepared.displayDigest)
  })
})
