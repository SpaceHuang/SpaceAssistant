import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CapabilityDescriptor } from './types'
import type { CapabilityContext } from './types'
import { callCapability } from './callCapability'
import { CapabilityRegistry } from './registry'

function baseCtx(): CapabilityContext {
  return {
    workDir: '/work',
    userDataDir: '/user',
    sessionId: 's1',
    requestId: 'r1',
    signal: new AbortController().signal
  }
}

function makeRegistry(descriptors: CapabilityDescriptor[]): CapabilityRegistry {
  const registry = new CapabilityRegistry()
  for (const d of descriptors) registry.register(d)
  return registry
}

const echo: CapabilityDescriptor = {
  id: 'env.echo',
  family: 'env',
  summary: '回显参数',
  keywords: ['echo'],
  paramsSchema: z.object({ text: z.string() }),
  paramsDoc: '{ "text": "string" }',
  returnsDoc: '{ text: string }',
  risk: 'read',
  handler: async (params) => ({ echoed: (params as { text: string }).text })
}

const boom: CapabilityDescriptor = {
  id: 'env.boom',
  family: 'env',
  summary: '总是抛错',
  keywords: ['boom'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{}；无参数',
  returnsDoc: 'never',
  risk: 'read',
  handler: async () => {
    throw new Error('探测失败：磁盘不可读')
  }
}

const slow: CapabilityDescriptor = {
  id: 'env.slow',
  family: 'env',
  summary: '慢速探测',
  keywords: ['slow'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{}；无参数',
  returnsDoc: 'never',
  risk: 'read',
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    return 'done'
  }
}

const secret: CapabilityDescriptor = {
  id: 'env.secret',
  family: 'env',
  summary: '返回凭据形态字段',
  keywords: ['secret'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{}；无参数',
  returnsDoc: 'object',
  risk: 'read',
  handler: async () => ({
    token: 'sk-ant-abcdefghijklmnop',
    nested: { apiKey: 'value', present: false },
    text: 'Authorization: Bearer abc.def.ghi',
    count: 3
  })
}

const risky: CapabilityDescriptor = {
  id: 'action.mutate',
  family: 'action',
  summary: '变更类动作',
  keywords: ['mutate'],
  paramsSchema: z.object({}).passthrough(),
  paramsDoc: '{}；无参数',
  returnsDoc: 'object',
  risk: 'act',
  handler: async () => ({ done: true })
}

describe('callCapability', () => {
  it('未知 id 返回 unknown-capability，并附全量索引兜底提示', async () => {
    const registry = makeRegistry([echo])
    const result = await callCapability(registry, 'env.nope', {}, baseCtx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unknown-capability')
    expect(result.error.index).toEqual([{ id: 'env.echo', summary: echo.summary }])
    expect(result.error.hint).toContain('toolkit.find')
  })

  it('zod 校验失败返回 invalid-params，message 含字段摘要', async () => {
    const registry = makeRegistry([echo])
    const result = await callCapability(registry, 'env.echo', { text: 42 }, baseCtx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid-params')
    expect(result.error.message).toContain('text')
  })

  it('handler 抛错返回 failed，message 含错误摘要', async () => {
    const registry = makeRegistry([boom])
    const result = await callCapability(registry, 'env.boom', {}, baseCtx())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('failed')
    expect(result.error.message).toContain('磁盘不可读')
  })

  it('handler 超时返回 timeout（使用注入的短超时）', async () => {
    const registry = makeRegistry([slow])
    const result = await callCapability(registry, 'env.slow', {}, baseCtx(), { timeoutMs: 20 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('timeout')
  })

  it('act 能力未经确认返回 denied', async () => {
    const registry = makeRegistry([risky])
    const result = await callCapability(registry, 'action.mutate', {}, baseCtx(), { allowed: false })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('denied')
  })

  it('act 能力经确认后正常执行', async () => {
    const registry = makeRegistry([risky])
    const result = await callCapability(registry, 'action.mutate', {}, baseCtx(), { allowed: true })
    expect(result.ok).toBe(true)
  })

  it('lane 不匹配返回 denied', async () => {
    const registry = makeRegistry([risky])
    const result = await callCapability(registry, 'action.mutate', {}, { ...baseCtx(), lane: 'feishu' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('denied')
  })

  it('成功结果封装为 { ok, id, data }', async () => {
    const registry = makeRegistry([echo])
    const result = await callCapability(registry, 'env.echo', { text: 'hi' }, baseCtx())
    expect(result).toEqual({ ok: true, id: 'env.echo', data: { echoed: 'hi' } })
  })

  it('超尺寸结果被截断并附提示', async () => {
    const big: CapabilityDescriptor = {
      ...echo,
      id: 'env.big',
      summary: '返回超大结果',
      paramsSchema: z.object({}).passthrough(),
      // 用 '-' 填充：不属于 [A-Za-z0-9+/]，不会被长 base64 打码规则收缩
      handler: async () => ({ blob: '-'.repeat(200 * 1024) })
    }
    const registry = makeRegistry([big])
    const result = await callCapability(registry, 'env.big', {}, baseCtx(), { maxResultBytes: 64 * 1024 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data as { _truncated: boolean })._truncated).toBe(true)
    expect((result.data as { _originalBytes: number })._originalBytes).toBeGreaterThan(64 * 1024)
  })

  it('凭据类字段只出布尔存在性，字符串中凭据形态被打码', async () => {
    const registry = makeRegistry([secret])
    const result = await callCapability(registry, 'env.secret', {}, baseCtx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as Record<string, unknown>
    expect(data.token).toBe(true)
    const nested = data.nested as Record<string, unknown>
    expect(nested.apiKey).toBe(true)
    expect(nested.present).toBe(false)
    expect(data.text).not.toContain('abc.def.ghi')
    expect(data.text).toContain('[REDACTED]')
    expect(data.count).toBe(3)
  })
})
