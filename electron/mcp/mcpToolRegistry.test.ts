import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import type { McpServerProfile } from '../../src/shared/mcpTypes'
import {
  buildMappedToolDescriptors,
  buildSnapshotTools,
  cacheTools,
  clearCachedTools,
  getCachedTools,
  markToolsStale,
  snapshotEntriesToAnthropicTools,
  validateMcpToolSchema
} from './mcpToolRegistry'
import { McpConnectionManager } from './mcpConnectionManager'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mcp-reg-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('validateMcpToolSchema', () => {
  it('accepts a valid tool with annotations', () => {
    const result = validateMcpToolSchema({
      name: 'create_issue',
      description: 'creates an issue',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: true }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tool.annotations?.destructiveHint).toBe(true)
    }
  })

  it('rejects empty or non-string names', () => {
    expect(validateMcpToolSchema({ name: '', inputSchema: {} }).ok).toBe(false)
    expect(validateMcpToolSchema({ name: 123, inputSchema: {} }).ok).toBe(false)
  })

  it('rejects schemas deeper than the depth limit', () => {
    let deep: Record<string, unknown> = { type: 'object' }
    let cursor = deep
    for (let i = 0; i < 30; i++) {
      const next: Record<string, unknown> = { type: 'object' }
      cursor.properties = { child: next }
      cursor = next
    }
    const result = validateMcpToolSchema({ name: 'deep', inputSchema: deep })
    expect(result.ok).toBe(false)
  })

  it('rejects schemas larger than the byte limit', () => {
    const huge = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [`key_${i}`, { type: 'string', description: 'x'.repeat(30) }])
      )
    }
    const result = validateMcpToolSchema({ name: 'huge', inputSchema: huge })
    expect(result.ok).toBe(false)
  })

  it('accepts schemas without inputSchema as empty object', () => {
    const result = validateMcpToolSchema({ name: 'no_schema' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.tool.inputSchema).toEqual({})
  })
})

describe('buildMappedToolDescriptors', () => {
  it('generates stable mapped names for discovered tools', () => {
    const { descriptors } = buildMappedToolDescriptors('server-1', 'GitHub', [
      { name: 'create_issue', description: 'd', inputSchema: {} },
      { name: 'list_repos', description: 'd2', inputSchema: {} }
    ])
    expect(descriptors).toHaveLength(2)
    expect(descriptors[0]!.mappedName).toMatch(/^mcp_github_create_issue_[0-9a-f]{8}$/)
    expect(descriptors[0]!.serverId).toBe('server-1')
    expect(descriptors[0]!.originalName).toBe('create_issue')
  })

  it('drops invalid tools and reports skipped reasons', () => {
    const { descriptors, skipped } = buildMappedToolDescriptors('server-1', 'S', [
      { name: '', description: 'bad name' },
      { name: 'valid', description: 'ok', inputSchema: { type: 'object' } }
    ])
    expect(descriptors).toHaveLength(1)
    expect(skipped[0]!.reason).toMatch(/工具名/)
  })

  it('derives unique names on mapped-name collision', () => {
    const first = buildMappedToolDescriptors('server-1', 'S', [
      { name: 'tool', description: '', inputSchema: {} }
    ])
    // 同一个 server+tool 再次发现时，映射名应与缓存中已存在名冲突 → 确定性再派生
    const used = new Set(first.descriptors.map((d) => d.mappedName))
    const second = buildMappedToolDescriptors('server-1', 'S', [
      { name: 'tool', description: '', inputSchema: {} }
    ], { usedMappedNames: used })
    expect(second.descriptors[0]!.mappedName).not.toBe(first.descriptors[0]!.mappedName)
    expect(second.descriptors[0]!.mappedName.length).toBeLessThanOrEqual(64)
  })
})

describe('tool cache', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-mcp-toolcache-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('round-trips cached tools and marks stale', () => {
    const entry = {
      tools: [
        {
          serverId: 'server-1',
          originalName: 'echo',
          mappedName: 'mcp_s_echo_12345678',
          description: '',
          inputSchema: {},
          discoveredAt: new Date().toISOString()
        }
      ],
      protocolVersion: '2025-06-18',
      discoveredAt: new Date().toISOString()
    }
    cacheTools(db, 'server-1', entry)
    expect(getCachedTools(db, 'server-1')).toEqual(entry)

    markToolsStale(db, 'server-1')
    expect(getCachedTools(db, 'server-1')?.stale).toBe(true)
    expect(getCachedTools(db, 'server-1')?.tools).toHaveLength(1)

    clearCachedTools(db, 'server-1')
    expect(getCachedTools(db, 'server-1')).toBeNull()
  })
})

describe('discoverToolsFromSession integration', () => {
  it('discovers, validates and caches tools from a live connection', async () => {
    const dir = makeTempDir()
    const scriptPath = path.join(dir, 'server.js')
    fs.writeFileSync(
      scriptPath,
      `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'tools-server', version: '1.0.0' }
    }})
  } else if (req.method === 'notifications/initialized') {
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'valid_tool', description: 'ok', inputSchema: { type: 'object' } },
      { name: '${'x'.repeat(300)}', description: 'invalid long name', inputSchema: { type: 'object' } }
    ]}})
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } })
  }
})
`,
      'utf8'
    )

    const temp = createTempDatabase('sa-mcp-reg-db-')
    const db = temp.db
    const profile: McpServerProfile = {
      id: 'server-1',
      name: 'Tools',
      enabled: false,
      transport: 'stdio',
      timeoutSec: 60,
      auth: { mode: 'none', secretPresent: false },
      stdio: { command: process.execPath, args: [scriptPath], env: [] },
      enabledToolNames: [],
      toolConfirmPolicy: 'always',
      status: 'untested',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    const manager = new McpConnectionManager({ connectTimeoutMs: 8000 })
    const session = await manager.connect(profile, async () => null)
    const { discoverToolsFromSession } = await import('./mcpToolRegistry')
    const result = await discoverToolsFromSession(db, profile, session)
    const cached = getCachedTools(db, 'server-1')
    await manager.disconnect(profile.id)
    temp.cleanup()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0]!.originalName).toBe('valid_tool')
      expect(result.skipped).toHaveLength(1)
      expect(cached?.tools).toHaveLength(1)
    }
  })
})

describe('buildSnapshotTools', () => {
  const profileA = {
    id: 'a',
    name: 'Server A',
    enabled: true,
    transport: 'stdio',
    timeoutSec: 60,
    auth: { mode: 'none', secretPresent: false },
    enabledToolNames: ['tool_a1', 'tool_a2'],
    toolConfirmPolicy: 'always',
    status: 'connected',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z'
  } as McpServerProfile
  const profileB = {
    ...profileA,
    id: 'b',
    name: 'Server B',
    enabled: true,
    enabledToolNames: ['t1', 't2']
  }
  const profileDisabled = { ...profileA, id: 'c', name: 'Server C', enabled: false }

  function cacheFor(serverId: string, names: string[]): import('../../src/shared/mcpTypes').McpToolCacheEntry {
    return {
      tools: names.map((n) => ({
        serverId,
        originalName: n,
        mappedName: `mcp_${serverId}_${n}_12345678`,
        description: '',
        inputSchema: {},
        discoveredAt: '2026-08-28T00:00:00.000Z'
      })),
      protocolVersion: '2025-06-18',
      discoveredAt: '2026-08-28T00:00:00.000Z'
    }
  }

  it('builds entries in profile order then whitelist order', () => {
    const caches = new Map([
      ['b', cacheFor('b', ['t1', 't2'])],
      ['a', cacheFor('a', ['tool_a2', 'tool_a1'])]
    ])
    const snapshot = buildSnapshotTools([profileA, profileB], caches)
    expect([...snapshot.entries.keys()]).toEqual([
      'mcp_a_tool_a1_12345678',
      'mcp_a_tool_a2_12345678',
      'mcp_b_t1_12345678',
      'mcp_b_t2_12345678'
    ])
    expect(snapshot.budgetDropped).toHaveLength(0)
  })

  it('returns an empty snapshot for remote contexts', () => {
    const caches = new Map([['a', cacheFor('a', ['tool_a1'])], ['b', cacheFor('b', ['t1'])]])
    const snapshot = buildSnapshotTools([profileA, profileB], caches, { remoteContext: true })
    expect(snapshot.entries.size).toBe(0)
  })

  it('excludes disabled profiles and empty whitelists', () => {
    const caches = new Map([
      ['a', cacheFor('a', ['tool_a1'])],
      ['c', cacheFor('c', ['x'])]
    ])
    const emptyWhitelist = { ...profileB, enabledToolNames: [] }
    const snapshot = buildSnapshotTools([profileA, emptyWhitelist, profileDisabled], caches)
    expect(snapshot.entries.size).toBe(1)
    expect([...snapshot.entries.keys()]).toEqual(['mcp_a_tool_a1_12345678'])
  })

  it('reports budget-dropped tools', () => {
    const caches = new Map([
      ['a', cacheFor('a', ['tool_a1', 'tool_a2', 'tool_a3', 'tool_a4'])]
    ])
    const snapshot = buildSnapshotTools(
      [{ ...profileA, enabledToolNames: ['tool_a1', 'tool_a2', 'tool_a3', 'tool_a4'] }],
      caches,
      { maxCount: 2 }
    )
    expect(snapshot.entries.size).toBe(2)
    expect(snapshot.budgetDropped.map((d) => d.mappedName)).toEqual([
      'mcp_a_tool_a3_12345678',
      'mcp_a_tool_a4_12345678'
    ])
  })

  it('converts snapshot entries to Anthropic tool definitions with source prefix', () => {
    const caches = new Map([['a', cacheFor('a', ['tool_a1'])]])
    const snapshot = buildSnapshotTools([profileA], caches)
    const tools = snapshotEntriesToAnthropicTools(snapshot.entries.values())
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('mcp_a_tool_a1_12345678')
    expect(tools[0]!.description).toContain('外部 MCP 服务「Server A」提供的工具')
    expect(tools[0]!.input_schema).toEqual({})
  })
})
