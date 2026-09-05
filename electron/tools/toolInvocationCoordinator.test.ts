import { describe, expect, it } from 'vitest'
import { defineDirectTool, definePlannedTool } from './plannedToolRegistry'
import { executeRegisteredTool } from './toolInvocationCoordinator'

const context = { requestId: 'r', toolUseId: 'u', signal: new AbortController().signal }

describe('executeRegisteredTool', () => {
  it('按 confirm → validate → execute 顺序运行 planned tool', async () => {
    const events: string[] = []
    const tool = definePlannedTool({
      name: 'ordered', parseInput: (raw) => raw,
      plan: async () => { events.push('plan'); return { ok: true } },
      execute: async () => { events.push('execute'); return 'done' }
    })
    const result = await executeRegisteredTool(tool, 'raw', context, {
      confirm: async (handle) => { events.push(`confirm:${handle.state}`); return true },
      validate: async (handle) => { events.push(`validate:${handle.state}`) }
    })
    expect(result).toBe('done')
    expect(events).toEqual(['plan', 'confirm:awaiting-confirm', 'validate:validating', 'execute'])
  })

  it('计划阶段可读取 runtime context，但 execute 阶段不会收到原始 runtime context', async () => {
    const runtime = { shellConfig: { shellDefaultTimeoutSec: 7 } }
    let plannedRuntime: unknown
    let executedContext: Record<string, unknown> | undefined
    const tool = definePlannedTool({
      name: 'runtime-bound',
      parseInput: (raw) => raw,
      plan: async (_input, planning) => {
        plannedRuntime = planning.executionContext
        return { timeout: (planning.executionContext as { shellConfig?: { shellDefaultTimeoutSec?: number } } | undefined)?.shellConfig?.shellDefaultTimeoutSec }
      },
      execute: async (_plan, execution) => {
        executedContext = execution as unknown as Record<string, unknown>
        return 'ok'
      }
    })
    await executeRegisteredTool(tool, {}, { ...context, executionContext: runtime as never }, { confirm: async () => true })
    expect(plannedRuntime).toBe(runtime)
    expect(executedContext).not.toHaveProperty('executionContext')
  })

  it('拒绝确认时不执行 direct tool', async () => {
    let executed = false
    const tool = defineDirectTool({ name: 'direct', parseInput: (raw) => raw, execute: async () => { executed = true } })
    await expect(executeRegisteredTool(tool, {}, context, { confirm: async () => false })).rejects.toThrow('INVOCATION_NOT_CONFIRMED')
    expect(executed).toBe(false)
  })

  it('gate 只接收 sealed prepared invocation，拒绝时不进入 confirm/execute', async () => {
    let confirmed = false
    let executed = false
    const tool = defineDirectTool({ name: 'gated', parseInput: (raw) => raw, execute: async () => { executed = true; return 'bad' } })
    await expect(executeRegisteredTool(tool, {}, context, {
      decide: async (prepared) => {
        expect(prepared.toolName).toBe('gated')
        expect(Object.isFrozen(prepared)).toBe(true)
        return false
      },
      confirm: async () => { confirmed = true; return true }
    })).rejects.toThrow('INVOCATION_GATE_REJECTED')
    expect(confirmed).toBe(false)
    expect(executed).toBe(false)
  })

  it('gate 超时或调用取消时不进入 confirm/execute', async () => {
    let executed = false
    const tool = defineDirectTool({ name: 'gate-timeout', parseInput: (raw) => raw, execute: async () => { executed = true; return 'bad' } })
    await expect(executeRegisteredTool(tool, {}, context, {
      decide: async () => new Promise<boolean>(() => undefined),
      confirm: async () => true,
      phaseTimeoutMs: { gate: 5 }
    })).rejects.toThrow('GATE_TIMEOUT')
    expect(executed).toBe(false)

    const controller = new AbortController()
    const pending = executeRegisteredTool(tool, {}, { ...context, signal: controller.signal }, {
      decide: async () => new Promise<boolean>(() => undefined),
      confirm: async () => true
    })
    controller.abort()
    await expect(pending).rejects.toThrow('GATE_CANCELLED')
    expect(executed).toBe(false)
  })

  it('阶段超时会阻止后续 execute，并返回可判定错误码', async () => {
    let executed = false
    const tool = defineDirectTool({ name: 'slow', parseInput: (raw) => raw, execute: async () => { executed = true; return 'ok' } })
    await expect(executeRegisteredTool(tool, {}, context, {
      confirm: async () => new Promise<boolean>(() => undefined),
      phaseTimeoutMs: { confirm: 5 }
    })).rejects.toThrow('CONFIRM_TIMEOUT')
    expect(executed).toBe(false)
  })

  it('planning 超时不会降级为 direct 执行', async () => {
    let executed = false
    const tool = definePlannedTool({
      name: 'slow-plan', parseInput: (raw) => raw,
      plan: async () => new Promise(() => undefined),
      execute: async () => { executed = true; return 'bad' }
    })
    await expect(executeRegisteredTool(tool, {}, context, { phaseTimeoutMs: { plan: 5 }, confirm: async () => true })).rejects.toThrow('PLAN_TIMEOUT')
    expect(executed).toBe(false)
  })

  it('调用级 AbortSignal 会取消等待中的 confirm', async () => {
    const controller = new AbortController()
    const tool = defineDirectTool({ name: 'cancel-confirm', parseInput: (raw) => raw, execute: async () => 'never' })
    const pending = executeRegisteredTool(tool, {}, { ...context, signal: controller.signal }, {
      confirm: async () => new Promise<boolean>(() => undefined)
    })
    controller.abort()
    await expect(pending).rejects.toThrow('CONFIRM_CANCELLED')
  })
})
