import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeBudgetDiagnostics } from './mcpToolRegistry'
import { setConfigValue } from '../database'
import { MCP_CONFIG_KEYS } from './mcpConfigStore'
import { cacheTools } from './mcpToolRegistry'
import { createMemoryAppDb } from '../database/testHelpers'
import type { AppDatabase } from '../database'
import { CONFIG_KEYS } from '../ipc/ipcShared'
import { mergeToolsConfig, DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { MCP_TOOLS_PER_ROUND_MAX, MCP_TOOLS_TOTAL_BYTES_MAX } from '../../src/shared/mcpTypes'
import type { McpServerProfile } from '../../src/shared/mcpTypes'

vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

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
  }
}

function bigTool(originalName: string, mappedName: string) {
  return {
    serverId: 'srvBig',
    originalName,
    mappedName,
    description: '大工具',
    inputSchema: { type: 'object', properties: { pad: { type: 'string', const: 'x'.repeat(40 * 1024) } } },
    discoveredAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('computeBudgetDiagnostics（FR12①/§6.7：双源合并 + 按需重算）', () => {
  let db: AppDatabase

  beforeEach(() => {
    db = createMemoryAppDb('zh-CN')
  })

  function seedToolsConfig(mode: 'auto' | 'always' | 'off'): void {
    setConfigValue(db, CONFIG_KEYS.tools, JSON.stringify({ ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: mode }))
  }

  it('off 档：超预算裁剪落 snapshot 源（现状预算口径）', () => {
    seedToolsConfig('off')
    const profile = makeProfile({ id: 'srvBig', enabledToolNames: ['a', 'b', 'c'] })
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([profile]))
    cacheTools(db, 'srvBig', {
      tools: [bigTool('a', 'mcp_big_a_1'), bigTool('b', 'mcp_big_b_1'), bigTool('c', 'mcp_big_c_1')],
      protocolVersion: 'v', discoveredAt: 'x'
    })
    const diagnostics = computeBudgetDiagnostics(db, { mode: 'off', thresholdBytes: 16 * 1024 })
    const snapshotDrops = diagnostics.filter((d) => d.source === 'snapshot')
    // 3 条 40KiB：前两条进（80KiB ≤ 96KiB），第三条裁（bytes）
    expect(snapshotDrops).toEqual([
      { source: 'snapshot', mappedName: 'mcp_big_c_1', reason: 'bytes' }
    ])
    expect(diagnostics.filter((d) => d.source === 'eager')).toEqual([])
  })

  it('always 档：快照走偏执上限（恒空），alwaysLoad 服务的超限裁剪落 eager 源', () => {
    seedToolsConfig('always')
    const big = makeProfile({ id: 'srvBig', enabledToolNames: ['a', 'b', 'c'], alwaysLoad: true })
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([big]))
    cacheTools(db, 'srvBig', {
      tools: [bigTool('a', 'mcp_big_a_1'), bigTool('b', 'mcp_big_b_1'), bigTool('c', 'mcp_big_c_1')],
      protocolVersion: 'v', discoveredAt: 'x'
    })
    const diagnostics = computeBudgetDiagnostics(db, { mode: 'always', thresholdBytes: 16 * 1024 })
    expect(diagnostics.filter((d) => d.source === 'snapshot')).toEqual([])
    expect(diagnostics.filter((d) => d.source === 'eager')).toEqual([
      { source: 'eager', mappedName: 'mcp_big_c_1', reason: 'bytes' }
    ])
  })

  it('auto 档超阈值：整体延迟（广告面无 MCP 工具），双源恒空（O2 不变量）', () => {
    seedToolsConfig('auto')
    const big = makeProfile({ id: 'srvBig', enabledToolNames: ['a', 'b', 'c'] })
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([big]))
    cacheTools(db, 'srvBig', {
      tools: [bigTool('a', 'mcp_big_a_1'), bigTool('b', 'mcp_big_b_1'), bigTool('c', 'mcp_big_c_1')],
      protocolVersion: 'v', discoveredAt: 'x'
    })
    const diagnostics = computeBudgetDiagnostics(db, { mode: 'auto', thresholdBytes: 16 * 1024 })
    expect(diagnostics).toEqual([])
  })

  it('无 MCP 配置时返回空数组（纯配置 + 缓存，不依赖会话）', () => {
    seedToolsConfig('off')
    expect(computeBudgetDiagnostics(db, { mode: 'off', thresholdBytes: 16 * 1024 })).toEqual([])
  })

  it('白名单上限 512 = 偏执上限：满额白名单全准入、无裁剪（O2 恒空不变量的配置层保证，FR11）', () => {
    seedToolsConfig('always')
    const names = Array.from({ length: 512 }, (_, i) => `t${String(i).padStart(3, '0')}`)
    const profile = makeProfile({ id: 'srvMany', enabledToolNames: names })
    setConfigValue(db, MCP_CONFIG_KEYS.profiles, JSON.stringify([profile]))
    cacheTools(db, 'srvMany', {
      tools: names.map((n) => ({
        serverId: 'srvMany', originalName: n, mappedName: `mcp_many_${n}_h`, description: '小工具',
        inputSchema: { type: 'object' }, discoveredAt: 'x'
      })),
      protocolVersion: 'v', discoveredAt: 'x'
    })
    const diagnostics = computeBudgetDiagnostics(db, { mode: 'always', thresholdBytes: 16 * 1024 })
    // 全部延迟进索引（广告面无 MCP 工具）→ 双源恒空（偏执上限在白名单 ≤512 下不可达）
    expect(diagnostics).toEqual([])
    // 常量引用自检：偏执上限常量与既有广告预算分离
    expect(MCP_TOOLS_PER_ROUND_MAX).toBe(64)
    expect(MCP_TOOLS_TOTAL_BYTES_MAX).toBe(96 * 1024)
    void mergeToolsConfig
  })
})
