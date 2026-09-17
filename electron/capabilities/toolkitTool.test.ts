import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CapabilityDescriptor } from './types'
import { CapabilityRegistry } from './registry'
import { createToolkitFindExecutor, createToolkitCallExecutor } from './toolkitTool'
import type { ToolExecutorResult } from '../tools/types'

function desc(overrides: Partial<CapabilityDescriptor> & { id: string; summary: string }): CapabilityDescriptor {
  return {
    family: 'env',
    keywords: [],
    paramsSchema: z.object({}).passthrough(),
    paramsDoc: '{ "id": "env.x" }；无参数',
    returnsDoc: '{ os: string }',
    risk: 'read',
    handler: async () => ({}),
    ...overrides
  }
}

const registry = new CapabilityRegistry()
registry.register(desc({ id: 'env.system', summary: '获取操作系统信息', keywords: ['系统', 'os'], notes: ['结果缓存 10 分钟'] }))
registry.register(
  desc({
    id: 'action.mcp.add',
    summary: '添加 MCP 连接',
    keywords: ['mcp'],
    family: 'action',
    risk: 'act',
    paramsDoc: '{ "name": "string", "transport": "http" }'
  })
)

const findExecutor = createToolkitFindExecutor(registry)
const callExecutor = createToolkitCallExecutor(registry)

describe('toolkit.find 执行器', () => {
  it('命中时返回 matches（usage 由 paramsDoc 生成）与调用提示', async () => {
    const result = await findExecutor({ query: 'env.system' })
    expect(result.success).toBe(true)
    const data = result.data as { ok: boolean; matches: Array<{ id: string; usage: string; risk: string; notes: string[] }>; hint: string }
    expect(data.ok).toBe(true)
    expect(data.matches).toHaveLength(1)
    expect(data.matches[0]!.id).toBe('env.system')
    expect(data.matches[0]!.usage).toContain('toolkit.call 入参')
    expect(data.matches[0]!.risk).toBe('read')
    expect(data.matches[0]!.notes).toEqual(['结果缓存 10 分钟'])
    expect(data.hint).toContain('toolkit.call')
  })

  it('未命中时返回全量紧凑索引与重查提示', async () => {
    const result = await findExecutor({ query: '完全无关 quantum' })
    const data = result.data as { ok: boolean; matches: unknown[]; index: Array<{ id: string; summary: string }>; hint: string }
    expect(data.ok).toBe(true)
    expect(data.matches).toHaveLength(0)
    expect(data.index).toHaveLength(2)
    expect(data.hint).toContain('toolkit.find')
  })

  it('family 过滤生效', async () => {
    const result = await findExecutor({ query: 'mcp', family: 'action' })
    const data = result.data as { matches: Array<{ id: string }> }
    expect(data.matches[0]!.id).toBe('action.mcp.add')
  })

  it('query 缺失返回失败结果', async () => {
    const result = await findExecutor({})
    expect(result.success).toBe(false)
  })
})

describe('toolkit.call 执行器', () => {
  const runtimeContext = {
    workDir: '/work',
    userDataDir: '/user',
    sessionId: 's1',
    requestId: 'r1',
    signal: new AbortController().signal
  } as unknown as import('../tools/types').ToolExecutionContext

  it('调用具体能力并封装结果', async () => {
    const localRegistry = new CapabilityRegistry()
    localRegistry.register(desc({ id: 'env.echo', summary: '回显', handler: async () => ({ got: true }) }))
    const executor = createToolkitCallExecutor(localRegistry)
    const result = await executor({ id: 'env.echo', params: {} }, runtimeContext)
    expect(result.success).toBe(true)
    const data = result.data as { ok: boolean; id: string }
    expect(data.ok).toBe(true)
    expect(data.id).toBe('env.echo')
  })

  it('未知能力返回结构化错误（含索引兜底）', async () => {
    const result = await callExecutor({ id: 'env.nope', params: {} }, runtimeContext)
    expect(result.success).toBe(true) // 工具执行成功，业务结果为 ok:false
    const data = result.data as { ok: boolean; error: { code: string; index: unknown[] } }
    expect(data.ok).toBe(false)
    expect(data.error.code).toBe('unknown-capability')
    expect(data.error.index).toHaveLength(2)
  })

  it('缺少运行时上下文返回失败', async () => {
    const result = await callExecutor({ id: 'env.system', params: {} })
    expect(result.success).toBe(false)
  })
})
