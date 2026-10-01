import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeMcpSnapshotForExecutors, buildSnapshotTools, type McpToolSnapshot, type McpToolSnapshotEntry } from '../mcp/mcpToolRegistry'
import type { McpServerProfile } from '../../src/shared/mcpTypes'
import { setConfigValue, getConfigValue } from '../database'
import { MCP_CONFIG_KEYS } from '../mcp/mcpConfigStore'
import { cacheTools } from '../mcp/mcpToolRegistry'
import { createMemoryAppDb } from '../database/testHelpers'
import type { AppDatabase } from '../database'
import { createAgentRuntime } from './agentRuntime'
import { resetDefaultAgentRuntimeForTests, setDefaultAgentRuntime } from './agentRuntimeDefaults'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { assembleInvocation } from './invocationAssembler'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { TypedToolRegistry } from '../tools/plannedToolRegistry'
import type { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

// FR13 崩溃向量模拟：executor 解析对坏条目 throw（对应 oauth provider 构造失败 / gate 获取失败等真实向量）。
vi.mock('../mcp/mcpToolExecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/mcpToolExecutor')>()
  return {
    ...actual,
    createMcpToolExecutor: (entry: { serverId: string }, deps: never, gate: never) => {
      if (entry.serverId === 'srvGhost') throw new Error('SIMULATED_EXECUTOR_FAILURE')
      return actual.createMcpToolExecutor(entry as never, deps, gate)
    }
  }
})

function makeProfile(overrides: Partial<McpServerProfile> & { id: string }): McpServerProfile {
  return {
    name: overrides.id,
    enabled: true,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none', secretPresent: false },
    stdio: { command: 'echo', args: [], env: [] },
    enabledToolNames: [],
    status: 'connected',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as McpServerProfile
}

function entry(serverId: string, name: string): McpToolSnapshotEntry {
  return {
    serverId,
    serverName: serverId,
    originalName: name,
    mappedName: `mcp_${serverId}_${name}_deadbeef`,
    description: `${name} 描述`,
    inputSchema: { type: 'object', properties: {} }
  }
}

describe('sanitizeMcpSnapshotForExecutors（FR13 / B6：全档位装配期快照清洗）', () => {
  const snapshot = (): McpToolSnapshot => ({
    entries: new Map([
      ['mcp_good_ok_1', entry('srvOk', 'ok')],
      ['mcp_bad_ghost_1', entry('srvGhost', 'ghost')]
    ]),
    budgetDropped: []
  })

  it('坏条目快照层剔除，好条目保留（禁止弱剔除）', () => {
    const drops: Array<{ mappedName: string; reason: string }> = []
    const cleaned = sanitizeMcpSnapshotForExecutors(
      snapshot(),
      (e) => e.serverId !== 'srvGhost',
      (drop) => drops.push(drop)
    )
    expect([...cleaned.entries.keys()]).toEqual(['mcp_good_ok_1'])
    expect(drops).toEqual([{ mappedName: 'mcp_bad_ghost_1', reason: 'executor_unavailable' }])
  })

  it('canResolve 抛错视为不可解析（不向上穿透）', () => {
    const cleaned = sanitizeMcpSnapshotForExecutors(snapshot(), () => {
      throw new Error('runtime gate unavailable')
    })
    expect(cleaned.entries.size).toBe(0)
  })

  it('空快照恒安全', () => {
    const cleaned = sanitizeMcpSnapshotForExecutors({ entries: new Map(), budgetDropped: [] }, () => true)
    expect(cleaned.entries.size).toBe(0)
    expect(cleaned.budgetDropped).toEqual([])
  })
})

describe('FR13 装配级：executor 不可解析条目使 invoke 降级继续（三档同路径，off 档含降级偏离）', () => {
  let db: AppDatabase
  let runtime: ReturnType<typeof createAgentRuntime>
  let warnEvents: Array<{ event: string; payload: Record<string, unknown> }>

  beforeEach(() => {
    db = createMemoryAppDb('zh-CN')
    resetDefaultAgentRuntimeForTests()
    runtime = createAgentRuntime({ toolRevocations: new ToolRevocationRegistry() })
    setDefaultAgentRuntime(runtime)
    warnEvents = []
  })

  afterEach(() => {
    resetDefaultAgentRuntimeForTests()
  })

  function seedDbWithOneGoodOneBad(): void {
    const good = makeProfile({ id: 'srvOk', name: '好服务', enabledToolNames: ['ok'] })
    // 坏条目：profile 存在（快照构建通过），但 executor 解析在装配期 throw（见顶部 mock）
    const bad = makeProfile({ id: 'srvGhost', name: '坏服务', enabledToolNames: ['ghost'] })
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([good, bad]))
    cacheTools(db, 'srvOk', {
      tools: [{ serverId: 'srvOk', originalName: 'ok', mappedName: 'mcp_srvok_ok_1', description: '好工具', inputSchema: { type: 'object' }, discoveredAt: '2026-01-01T00:00:00.000Z' }],
      protocolVersion: '2025-06-18',
      discoveredAt: '2026-01-01T00:00:00.000Z'
    })
    cacheTools(db, 'srvGhost', {
      tools: [{ serverId: 'srvGhost', originalName: 'ghost', mappedName: 'mcp_srvghost_ghost_1', description: '幽灵工具', inputSchema: { type: 'object' }, discoveredAt: '2026-01-01T00:00:00.000Z' }],
      protocolVersion: '2025-06-18',
      discoveredAt: '2026-01-01T00:00:00.000Z'
    })
  }

  function assemble(): ReturnType<typeof assembleInvocation> {
    return assembleInvocation({
      requestId: 'req-fr13', sessionId: 'session-fr13', turnId: 'turn-fr13', model: 'test-model', providerRouteId: 'route-fr13',
      locale: 'zh-CN', messages: [{ role: 'user', content: 'hi' }], toolsConfig: { enabled: true, allowedTools: [], deniedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60 },
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'k', appDb: db, agentSdkHistory: new MemoryHistory(),
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
  }

  it('invoke 正常完成：坏条目不进快照（索引/deferredNames/授权面/注册表天然同步）', async () => {
    seedDbWithOneGoodOneBad()
    const { ports } = assemble()
    const snapshot = ports.mcp?.snapshot
    expect(snapshot).toBeDefined()
    // 好条目保留
    expect(snapshot!.entries.has('mcp_srvok_ok_1')).toBe(true)
    // 坏条目被剔除（若残留，hostedMcpRegistry 构建期会 throw MCP_REGISTERED_EXECUTOR_UNAVAILABLE）
    expect(snapshot!.entries.has('mcp_srvghost_ghost_1')).toBe(false)
    // 现状下（未清洗）该快照经 createHostedMcpToolRegistry 会 throw；现在装配降级继续
    const composed = assemble().agentSdk.createHostedTurnRuntime({ registry: new TypedToolRegistry(), authorizedToolNames: new Set(['mcp_srvok_ok_1']) })
    expect(composed.host).toBeDefined()
    await composed.dispose()
  })

  function assemble(toolsOverrides: Record<string, unknown> = {}): ReturnType<typeof assembleInvocation> {
    return assembleInvocation({
      requestId: 'req-fr13', sessionId: 'session-fr13', turnId: 'turn-fr13', model: 'test-model', providerRouteId: 'route-fr13',
      locale: 'zh-CN', messages: [{ role: 'user', content: 'hi' }],
      toolsConfig: { enabled: true, allowedTools: [], deniedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60, ...toolsOverrides },
      workDir: '/tmp', userDataDir: '/tmp', getApiKey: async () => 'k', appDb: db, agentSdkHistory: new MemoryHistory(),
      emitFactEvent: vi.fn(), emitSessionEvent: vi.fn()
    })
  }

  function seedDbWith65Tools(): void {
    const names = Array.from({ length: 65 }, (_, i) => `t${String(i).padStart(2, '0')}`)
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([
      makeProfile({ id: 'srvBig', name: '大服务', enabledToolNames: names })
    ]))
    cacheTools(db, 'srvBig', {
      tools: names.map((n) => ({
        serverId: 'srvBig', originalName: n, mappedName: `mcp_srvbig_${n}_deadbeef`, description: `工具 ${n}`,
        inputSchema: { type: 'object', properties: {} }, discoveredAt: '2026-01-01T00:00:00.000Z'
      })),
      protocolVersion: '2025-06-18', discoveredAt: '2026-01-01T00:00:00.000Z'
    })
  }

  it('FR11/10.1.12：always 档 65 工具走真实快照路径——全部准入、快照层 budgetDropped 恒空', () => {
    seedDbWith65Tools()
    const { ports } = assemble({ mcpDeferredLoading: 'always' })
    const snapshot = ports.mcp?.snapshot
    expect(snapshot).toBeDefined()
    // 偏执上限内（512）白名单全准入：65 个工具全部进快照
    expect(snapshot!.entries.size).toBe(65)
    // 恒空不变量：延迟模式下快照层不产生预算裁剪
    expect(snapshot!.budgetDropped).toEqual([])
    // 第 65 个工具可被检索（不静默丢失）
    expect(snapshot!.entries.has('mcp_srvbig_t64_deadbeef')).toBe(true)
  })

  it('FR11：off 档 65 工具走现状路径——64 个准入、第 65 个落快照层 budgetDropped', () => {
    seedDbWith65Tools()
    const { ports } = assemble({ mcpDeferredLoading: 'off' })
    const snapshot = ports.mcp?.snapshot
    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.size).toBe(64)
    expect(snapshot!.budgetDropped).toEqual([{ mappedName: 'mcp_srvbig_t64_deadbeef', reason: 'count' }])
  })

  it('FR11：auto 档快照准入同样放宽（eager/deferred 判定在 plan 层）', () => {
    seedDbWith65Tools()
    const { ports } = assemble({ mcpDeferredLoading: 'auto' })
    const snapshot = ports.mcp?.snapshot
    expect(snapshot).toBeDefined()
    expect(snapshot!.entries.size).toBe(65)
    expect(snapshot!.budgetDropped).toEqual([])
  })

  it('剔除落 executor 源诊断（budgetDiagnostics 数据源），好条目不受影响', () => {
    seedDbWithOneGoodOneBad()
    const { ports } = assemble()
    expect(ports.mcp?.snapshot.executorDropped).toEqual([{ mappedName: 'mcp_srvghost_ghost_1', reason: 'executor_unavailable' }])
    expect(ports.mcp?.snapshot.entries.has('mcp_srvok_ok_1')).toBe(true)
  })

  it('快照层数据源与 buildSnapshotTools 的现状口径不冲突（off 档 budgetDropped 语义不变）', () => {
    const profiles = [makeProfile({ id: 'srv1', enabledToolNames: ['a', 'b'] })]
    const caches = new Map([
      ['srv1', { tools: [
        { serverId: 'srv1', originalName: 'a', mappedName: 'mcp_srv1_a_1', description: 'A', inputSchema: { type: 'object' }, discoveredAt: 'x' },
        { serverId: 'srv1', originalName: 'b', mappedName: 'mcp_srv1_b_1', description: 'B', inputSchema: { type: 'object' }, discoveredAt: 'x' }
      ], protocolVersion: 'v', discoveredAt: 'x' }]
    ])
    const snapshot = buildSnapshotTools(profiles, caches)
    expect(snapshot.budgetDropped).toEqual([])
    expect(snapshot.entries.size).toBe(2)
  })
})
