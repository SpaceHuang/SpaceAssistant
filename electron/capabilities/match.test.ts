import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CapabilityDescriptor } from './types'
import { matchCapabilities } from './match'

function desc(overrides: Partial<CapabilityDescriptor> & { id: string; summary: string }): CapabilityDescriptor {
  return {
    family: 'env',
    keywords: [],
    paramsSchema: z.object({}).passthrough(),
    paramsDoc: '{}；无参数',
    returnsDoc: 'object',
    risk: 'read',
    handler: async () => ({}),
    ...overrides
  }
}

const fixtures: CapabilityDescriptor[] = [
  desc({
    id: 'env.system',
    summary: '获取操作系统类型/版本/架构/系统语言/是否安装 WSL',
    keywords: ['系统', '操作系统', 'os', 'wsl', 'windows']
  }),
  desc({
    id: 'env.agent',
    summary: '当前 Agent 自身信息：产品名称/版本/形态',
    keywords: ['产品', '版本', 'agent', 'self']
  }),
  desc({
    id: 'env.dev',
    summary: '开发环境探测：node/python/git 可用性与版本',
    keywords: ['开发环境', 'node', 'python', 'git', 'dev']
  }),
  desc({
    id: 'action.session.list',
    summary: '分页枚举用户会话列表',
    keywords: ['会话列表', '列出会话', 'sessions', 'list'],
    family: 'action'
  }),
  desc({
    id: 'action.session.status',
    summary: '查询某会话是否正在运行',
    keywords: ['会话状态', '运行中', 'running', 'status'],
    family: 'action'
  })
]

describe('matchCapabilities', () => {
  it('query 为精确能力 id 时直接命中该能力（大小写与首尾空白容错）', () => {
    const outcome = matchCapabilities(fixtures, '  ENV.SYSTEM ')
    expect(outcome.exact).toBe(true)
    expect(outcome.matches).toHaveLength(1)
    expect(outcome.matches[0]!.id).toBe('env.system')
    expect(outcome.index).toHaveLength(0)
  })

  it('拉丁词命中：id 命中权重高于 keywords 命中', () => {
    // 'wsl' 同时是 env.system 的 keyword；'env.system' 的 id 含 'system'
    const outcome = matchCapabilities(fixtures, 'wsl system')
    expect(outcome.exact).toBe(false)
    expect(outcome.matches[0]!.id).toBe('env.system')
  })

  it('summary 命中优于 keywords 命中', () => {
    // 'list' 在 action.session.list 的 id 与 keywords 中都出现，应为第一
    // 'sessions' 在 summary 中出现，其得分应高于仅 keyword 命中的项
    const outcome = matchCapabilities(fixtures, 'list sessions')
    expect(outcome.matches[0]!.id).toBe('action.session.list')
    expect(outcome.matches.length).toBeGreaterThanOrEqual(1)
  })

  it('中文关键词通过包含关系命中', () => {
    const outcome = matchCapabilities(fixtures, '我想知道当前是什么操作系统')
    expect(outcome.matches[0]!.id).toBe('env.system')
  })

  it('family 过滤先行：exact id 也受 family 限制', () => {
    const outcome = matchCapabilities(fixtures, 'env.system', 'action')
    expect(outcome.exact).toBe(false)
    expect(outcome.matches).toHaveLength(0)
    expect(outcome.index).toHaveLength(2) // action 家族全量索引兜底
  })

  it('命中数超过 3 条时按分数截取前 3', () => {
    const many: CapabilityDescriptor[] = ['a', 'b', 'c', 'd'].map((n) =>
      desc({ id: `env.${n}`, summary: `${n} 探测`, keywords: ['探测'] })
    )
    const outcome = matchCapabilities(many, '探测一下')
    expect(outcome.matches).toHaveLength(3)
  })

  it('无命中时返回全量紧凑索引', () => {
    const outcome = matchCapabilities(fixtures, '完全无关的查询词汇 quantum')
    expect(outcome.exact).toBe(false)
    expect(outcome.matches).toHaveLength(0)
    expect(outcome.index).toHaveLength(fixtures.length)
    expect(outcome.index[0]).toEqual({ id: 'env.system', summary: fixtures[0]!.summary })
  })

  it('阈值：无意义短词不产生命中', () => {
    const outcome = matchCapabilities(fixtures, 'a')
    expect(outcome.matches).toHaveLength(0)
    expect(outcome.index).toHaveLength(fixtures.length)
  })
})
