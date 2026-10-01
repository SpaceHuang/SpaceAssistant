import { describe, expect, it } from 'vitest'
import { computeDeferredPlan, computeEffectiveTools, type DeferredPlan } from './effectiveTools'
import type { McpToolSnapshot, McpToolSnapshotEntry } from './mcp/mcpToolRegistry'
import { MCP_TOOLS_PER_ROUND_MAX, MCP_TOOLS_TOTAL_BYTES_MAX, type McpServerProfile } from '../src/shared/mcpTypes'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

function makeProfile(overrides: Partial<McpServerProfile> & { id: string; name: string; enabledToolNames: string[] }): McpServerProfile {
  return {
    enabled: true,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none' },
    status: 'connected',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as McpServerProfile
}

let entrySeq = 0
function makeEntry(overrides: Partial<McpToolSnapshotEntry> & { serverId?: string; serverName?: string } = {}): McpToolSnapshotEntry {
  entrySeq += 1
  const originalName = overrides.originalName ?? `tool_${entrySeq}`
  const serverId = overrides.serverId ?? 'srv1'
  const serverName = overrides.serverName ?? '服务一'
  return {
    serverId,
    serverName,
    originalName,
    mappedName: overrides.mappedName ?? `mcp_${serverId}_${originalName}_${String(entrySeq).padStart(8, '0')}`,
    description: overrides.description ?? `工具 ${originalName} 的描述`,
    inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} }
  }
}

function makeSnapshot(entries: McpToolSnapshotEntry[]): McpToolSnapshot {
  return { entries: new Map(entries.map((entry) => [entry.mappedName, entry])), budgetDropped: [] }
}

const THRESHOLD = 16 * 1024

describe('computeDeferredPlan（FR5 策略三档 / §6.5）', () => {
  it('off 档恒为 eager（现状路径，含既有裁剪由快照层负责）', () => {
    const entries = [makeEntry(), makeEntry()]
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot(entries),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: entries.map((e) => e.originalName) })],
      mode: 'off',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('eager')
    // off 档不携带广告面预算：快照层已按现状裁剪，computeEffectiveTools 不重复裁（逐字节兼容）
    expect((plan as Extract<DeferredPlan, { mode: 'eager' }>).eagerAdvertiseBudget).toBeUndefined()
  })

  it('快照为空 → eager，无论档位', () => {
    for (const mode of ['auto', 'always'] as const) {
      const plan = computeDeferredPlan({
        mcpSnapshot: makeSnapshot([]),
        profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: ['x'] })],
        mode,
        thresholdBytes: THRESHOLD
      })
      expect(plan.mode).toBe('eager')
    }
  })

  it('always 档：非覆盖条目全部 deferred', () => {
    const entries = [makeEntry(), makeEntry()]
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot(entries),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: entries.map((e) => e.originalName) })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('deferred')
    if (plan.mode !== 'deferred') return
    expect([...plan.deferredNames]).toEqual(entries.map((e) => e.mappedName))
    expect(plan.deferredEntries.map((e) => e.mappedName)).toEqual(entries.map((e) => e.mappedName))
  })

  it('auto 档：小快照（字节 ≤ 阈值且数量 ≤ 64）→ eager', () => {
    const entries = [makeEntry(), makeEntry()]
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot(entries),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: entries.map((e) => e.originalName) })],
      mode: 'auto',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('eager')
    // auto-eager 由广告面组装处执行既有裁剪（FR11/§6.5）：快照准入已放宽
    expect((plan as Extract<DeferredPlan, { mode: 'eager' }>).eagerAdvertiseBudget).toEqual({
      maxCount: MCP_TOOLS_PER_ROUND_MAX,
      maxTotalBytes: MCP_TOOLS_TOTAL_BYTES_MAX
    })
  })

  it('auto 档：字节超阈值 → 全部转延迟（D8 不做单工具拆分）', () => {
    const bigSchema = { type: 'object', properties: { pad: { type: 'string', description: 'x'.repeat(THRESHOLD) } } }
    const entries = [makeEntry({ inputSchema: bigSchema }), makeEntry()]
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot(entries),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: entries.map((e) => e.originalName) })],
      mode: 'auto',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('deferred')
    if (plan.mode !== 'deferred') return
    expect(plan.deferredNames.size).toBe(entries.length)
  })

  it('auto 档：数量 > 64（即使字节 ≤ 阈值）→ 转延迟（D8 数量双条件 / 10.1.11）', () => {
    const tiny = Array.from({ length: 65 }, () => makeEntry({ description: '短' }))
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot(tiny),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: tiny.map((e) => e.originalName) })],
      mode: 'auto',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('deferred')
    if (plan.mode !== 'deferred') return
    expect(plan.deferredNames.size).toBe(65)
  })

  it('alwaysLoad 服务永远 eager，其条目不入 deferred 集合（FR6 / §6.5 规则 2）', () => {
    const a = makeEntry({ serverId: 'srvA', serverName: '服务A' })
    const b = makeEntry({ serverId: 'srvB', serverName: '服务B' })
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a, b]),
      profiles: [
        makeProfile({ id: 'srvA', name: '服务A', enabledToolNames: [a.originalName], alwaysLoad: true }),
        makeProfile({ id: 'srvB', name: '服务B', enabledToolNames: [b.originalName] })
      ],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('deferred')
    if (plan.mode !== 'deferred') return
    expect(plan.deferredNames).toEqual(new Set([b.mappedName]))
    expect(plan.deferredEntries.map((e) => e.mappedName)).toEqual([b.mappedName])
  })

  it('auto 档：仅 alwaysLoad 服务条目 → eager（非覆盖条目为空）', () => {
    const a = makeEntry({ serverId: 'srvA', serverName: '服务A' })
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a]),
      profiles: [makeProfile({ id: 'srvA', name: '服务A', enabledToolNames: [a.originalName], alwaysLoad: true })],
      mode: 'auto',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('eager')
  })

  it('deferred 集合为空（全部 alwaysLoad）不生效', () => {
    const a = makeEntry({ serverId: 'srvA' })
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a]),
      profiles: [makeProfile({ id: 'srvA', name: '服务A', enabledToolNames: [a.originalName], alwaysLoad: true })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    expect(plan.mode).toBe('eager')
  })

  it('auto 档阈值判定基于非覆盖条目的 JSON 字节（§6.5 规则 3）', () => {
    // 单条目序列化后恰好在阈值边缘：直接构造一个序列化字节超过阈值的条目
    const entry = makeEntry({ description: 'd'.repeat(THRESHOLD) })
    const planOver = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([entry]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: [entry.originalName] })],
      mode: 'auto',
      thresholdBytes: THRESHOLD
    })
    expect(planOver.mode).toBe('deferred')

    const planUnder = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([makeEntry()]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: ['tool_2'] })],
      mode: 'auto',
      thresholdBytes: Number.MAX_SAFE_INTEGER
    })
    expect(planUnder.mode).toBe('eager')
  })
})

describe('computeEffectiveTools 广告/授权面分离（FR3 / FR11 / O3 / O5）', () => {
  it('off 档（无 plan）：行为与现状一致——MCP 快照全量进 tools 数组，tool_search 不占广告面（§6.5 规则 4）', () => {
    const a = makeEntry()
    const result = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot([a])
    })
    const names = result.tools.map((t) => (t as { name?: string }).name)
    expect(names).toContain(a.mappedName)
    expect(names).not.toContain('tool_search')
    expect(result.authorizedToolNames.has(a.mappedName)).toBe(true)
    expect(result.deferredToolNames.size).toBe(0)
    expect(result.eagerBudgetDropped).toEqual([])
  })

  it('deferred 生效时 tool_search 进广告面（FR2）', () => {
    const a = makeEntry()
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: [a.originalName] })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot([a]),
      deferredPlan: plan
    })
    expect(result.tools.map((t) => (t as { name?: string }).name)).toContain('tool_search')
  })

  it('deferred 模式：延迟名不在 tools 数组、在授权面与 deferredToolNames 中（FR3）', () => {
    const a = makeEntry({ serverId: 'srvA', serverName: '服务A' })
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a]),
      profiles: [makeProfile({ id: 'srvA', name: '服务A', enabledToolNames: [a.originalName] })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot([a]),
      deferredPlan: plan
    })
    const names = result.tools.map((t) => (t as { name?: string }).name)
    expect(names).not.toContain(a.mappedName)
    expect(result.toolNames).not.toContain(a.mappedName)
    expect(result.authorizedToolNames.has(a.mappedName)).toBe(true)
    expect(result.deferredToolNames.has(a.mappedName)).toBe(true)
  })

  it('deferred 模式下 alwaysLoad 服务条目仍进 tools 数组并计入授权面', () => {
    const a = makeEntry({ serverId: 'srvA', serverName: '服务A' })
    const b = makeEntry({ serverId: 'srvB', serverName: '服务B' })
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a, b]),
      profiles: [
        makeProfile({ id: 'srvA', name: '服务A', enabledToolNames: [a.originalName], alwaysLoad: true }),
        makeProfile({ id: 'srvB', name: '服务B', enabledToolNames: [b.originalName] })
      ],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot([a, b]),
      deferredPlan: plan
    })
    const names = result.tools.map((t) => (t as { name?: string }).name)
    expect(names).toContain(a.mappedName)
    expect(names).not.toContain(b.mappedName)
    expect(result.authorizedToolNames.has(a.mappedName)).toBe(true)
    expect(result.authorizedToolNames.has(b.mappedName)).toBe(true)
  })

  it('auto-eager 不触顶：快照全量进广告面、eagerBudgetDropped 恒空', () => {
    const entries = [makeEntry(), makeEntry()]
    // auto 档小快照：computeDeferredPlan 给出带预算的 eager plan（快照准入已放宽）
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot(entries),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: entries.map((e) => e.originalName) })],
      mode: 'auto',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot(entries),
      deferredPlan: plan
    })
    const names = result.tools.map((t) => (t as { name?: string }).name)
    // 小快照不触顶：全部 MCP 条目保留、无裁剪
    for (const entry of entries) expect(names).toContain(entry.mappedName)
    expect(result.eagerBudgetDropped).toEqual([])
  })

  it('off 档与 auto-eager 同输入同裁剪结果（O3）：超预算条目同样被跳过', () => {
    // auto-eager 场景：快照（放宽准入后）含 96KiB 以上的聚合体积 → 广告面裁剪
    const pad = 'y'.repeat(40 * 1024)
    const bigSchema = { type: 'object', properties: { pad: { type: 'string', const: pad } } }
    const entries = [makeEntry({ inputSchema: bigSchema }), makeEntry({ inputSchema: bigSchema }), makeEntry({ inputSchema: bigSchema })]
    const eagerPlan: DeferredPlan = { mode: 'eager', eagerAdvertiseBudget: { maxCount: MCP_TOOLS_PER_ROUND_MAX, maxTotalBytes: MCP_TOOLS_TOTAL_BYTES_MAX } }
    const snapshot = makeSnapshot(entries)
    const autoEager = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: snapshot,
      deferredPlan: eagerPlan
    })
    // 等价的 off 档现状路径：快照层裁剪后（kept 前两个、丢第三个）
    const offSnapshot = makeSnapshot([entries[0]!, entries[1]!])
    const offResult = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: offSnapshot
    })
    const mcpNames = (result: { tools: unknown[] }) => result.tools.map((t) => (t as { name?: string }).name).filter((n) => n.startsWith('mcp_'))
    expect(mcpNames(autoEager)).toEqual(mcpNames(offResult))
    // 第三条被裁且记录 eagerBudgetDropped（bytes）
    expect(mcpNames(autoEager)).not.toContain(entries[2]!.mappedName)
    expect(autoEager.eagerBudgetDropped).toEqual([{ mappedName: entries[2]!.mappedName, reason: 'bytes' }])
    // 被裁条目保持「三无」：不授权（现状语义）
    expect(autoEager.authorizedToolNames.has(entries[2]!.mappedName)).toBe(false)
  })

  it('tool_search 被裁出广告面时整体回退 eager（O4 / 边界 11）', () => {
    const a = makeEntry()
    // allowedTools 封闭集合不含 tool_search → tool_search 进不了广告面 → 延迟计划失效
    const cfg = { ...DEFAULT_TOOLS_CONFIG, allowedTools: ['read_file'] }
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: [a.originalName] })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: cfg,
      mcpSnapshot: makeSnapshot([a]),
      deferredPlan: plan
    })
    const names = result.tools.map((t) => (t as { name?: string }).name)
    // 回退 eager：延迟工具重新全量注入、无 tool_search、无 deferredToolNames
    expect(names).toContain(a.mappedName)
    expect(names).not.toContain('tool_search')
    expect(result.deferredToolNames.size).toBe(0)
    expect(result.deferredDegradedToEager).toBe(true)
  })

  it('deniedTools 命中 tool_search 同样回退 eager（O4）', () => {
    const a = makeEntry()
    const cfg = { ...DEFAULT_TOOLS_CONFIG, deniedTools: ['tool_search'] }
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: [a.originalName] })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: cfg,
      mcpSnapshot: makeSnapshot([a]),
      deferredPlan: plan
    })
    expect(result.deferredDegradedToEager).toBe(true)
    expect(result.deferredToolNames.size).toBe(0)
  })

  it('trim（P7）约束延迟条目：deny 命中者从延迟集合剔除；allow 封闭集合仅保留 allow 内的延迟名（§6.6）', () => {
    const a = makeEntry({ originalName: 'alpha', mappedName: 'mcp_srv1_alpha_00000001' })
    const b = makeEntry({ originalName: 'beta', mappedName: 'mcp_srv1_beta_00000002' })
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a, b]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: [a.originalName, b.originalName] })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot([a, b]),
      deferredPlan: plan,
      trim: { deny: [b.mappedName] }
    })
    expect(result.deferredToolNames.has(a.mappedName)).toBe(true)
    expect(result.deferredToolNames.has(b.mappedName)).toBe(false)
    expect(result.authorizedToolNames.has(b.mappedName)).toBe(false)

    const allowResult = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot([a, b]),
      deferredPlan: plan,
      trim: { allow: [a.mappedName] }
    })
    expect(allowResult.deferredToolNames).toEqual(new Set([a.mappedName]))
  })

  it('撞名守卫遍历广告面 ∪ 延迟集（O5）：两个延迟名归一同一 compat 名时构建期报错', () => {
    // mappedName 字符集正常由 slugify 保证无点号；此处直接构造点号/下划线对
    // 验证守卫的遍历范围确实覆盖延迟集（而非仅广告面）。
    const a = makeEntry({ originalName: 'x', mappedName: 'history.read' })
    const b = makeEntry({ originalName: 'y', mappedName: 'history_read' })
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a, b]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: [a.originalName, b.originalName] })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    expect(() => computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      mcpSnapshot: makeSnapshot([a, b]),
      deferredPlan: plan
    })).toThrow(/compat 名撞名/)
  })

  it('remoteContext lane：延迟计划不生效（边界 6）', () => {
    const a = makeEntry()
    const plan = computeDeferredPlan({
      mcpSnapshot: makeSnapshot([a]),
      profiles: [makeProfile({ id: 'srv1', name: '服务一', enabledToolNames: [a.originalName] })],
      mode: 'always',
      thresholdBytes: THRESHOLD
    })
    const result = computeEffectiveTools({
      builtinConfig: { ...DEFAULT_TOOLS_CONFIG },
      remoteContext: { source: 'feishu', messageId: 'm1', confirmPolicy: 'always' },
      mcpSnapshot: makeSnapshot([a]),
      deferredPlan: plan
    })
    expect(result.deferredToolNames.size).toBe(0)
  })
})
