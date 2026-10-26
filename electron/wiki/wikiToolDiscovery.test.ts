import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { discoverWikiTools, executeWikiDiscovery, WIKI_DISCOVERY_TOOL_DEFINITION, WIKI_DOMAIN_TOOL_DEFINITIONS } from './wikiToolDiscovery'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import { isBuiltinToolName } from '../toolsConfigRuntime'
import { createWikiLifecycleController } from './wikiLifecycle'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'
import { openDatabase, setConfigValue } from '../database'

describe('Wiki domain tool discovery', () => {
  it('registers memory as a real lightweight discovery tool', () => {
    expect(WIKI_DISCOVERY_TOOL_DEFINITION).toMatchObject({ name: 'memory', input_schema: { type: 'object' } })
    expect(WIKI_DOMAIN_TOOL_DEFINITIONS.every(tool => tool.name.startsWith('memory.wiki_'))).toBe(true)
    expect(isBuiltinToolName('memory')).toBe(true)
    const registry = createBuiltinToolRegistry()
    expect(registry.get('memory')).toBeDefined()
    expect(registry.get('memory.wiki_get_schema')).toBeDefined()
    expect(registry.get('memory.wiki_search')).toBeDefined()
    expect(registry.get('memory.wiki_read_source')).toBeDefined()
    expect(registry.get('memory.wiki_list_page_revisions')).toBeDefined()
    expect(registry.get('memory.wiki_restore_page')).toBeDefined()
    expect(registry.get('memory.wiki_save_page')).toBeDefined()
    expect(registry.get('memory.wiki_move_page')).toBeDefined()
    expect(registry.get('memory.wiki_save_page')?.kind).toBe('planned')
    expect(registry.get('memory.wiki_move_page')?.kind).toBe('planned')
    expect(registry.get('memory.wiki_apply_restore')).toBeDefined()
    expect(registry.get('memory.wiki_propose_schema_change')).toBeDefined()
    expect(registry.get('memory.wiki_update_schema')).toBeDefined()
    expect(WIKI_DOMAIN_TOOL_DEFINITIONS.find(tool => tool.name === 'memory.wiki_update_schema')?.input_schema).toMatchObject({ required: ['proposalId', 'expectedSchemaVersion', 'proposalDiff'], properties: { proposalDiff: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } } } } })
    expect(WIKI_DOMAIN_TOOL_DEFINITIONS.find(tool => tool.name === 'memory.wiki_move_page')?.input_schema).toMatchObject({ required: ['pageId', 'expectedRevision'] })
    const saveSchema = WIKI_DOMAIN_TOOL_DEFINITIONS.find(tool => tool.name === 'memory.wiki_save_page')?.input_schema
    expect(saveSchema?.properties?.pageId?.description).toContain('更新时必填')
    expect(saveSchema?.properties?.expectedRevision?.description).toContain('必须与 pageId 同时提供')
  })

  it('registers every advertised Wiki operation in the runtime registry', () => {
    const registry = createBuiltinToolRegistry()
    const missing = WIKI_DOMAIN_TOOL_DEFINITIONS.filter(tool => !registry.get(tool.name)).map(tool => tool.name)
    expect(missing).toEqual([])
  })

  it('returns operation names, use descriptions, and complete schemas for matching tools', () => {
    const result = discoverWikiTools({ query: 'read page', limit: 8, offset: 0 })
    expect(result.matches.map(item => item.name)).toContain('memory.wiki_read_page')
    expect(result.matches.find(item => item.name === 'memory.wiki_read_page')?.input_schema).toMatchObject({ required: ['readHandle'] })
    expect(result.totalMatches).toBeGreaterThan(0)
  })

  it('paginates deterministically without modifying authorization or truncating schemas', () => {
    const first = discoverWikiTools({ query: '', limit: 3, offset: 0 })
    const second = discoverWikiTools({ query: '', limit: 3, offset: 3 })
    expect(first.matches).toHaveLength(3)
    expect(second.matches).toHaveLength(3)
    expect(first.matches.map(item => item.name)).not.toEqual(second.matches.map(item => item.name))
    expect(first.matches.every(item => item.input_schema.properties)).toBe(true)
    expect(first.usage).toContain('授权')
  })

  it('只返回运行时 registry 已注册的 Wiki 操作', () => {
    const result = discoverWikiTools({}, new Set(['memory.wiki_get_schema']))
    expect(result.matches.map((item) => item.name)).toEqual(['memory.wiki_get_schema'])
    expect(result.totalMatches).toBe(1)
  })

  it('在每次 discovery dispatch 时复核 lifecycle，未就绪或控制面损坏时 fail closed', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-discovery-'))
    const root = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(root, { recursive: true })
    const controller = createWikiLifecycleController(root)
    await controller.initialize({ fresh: true })
    const context = { userDataDir, wikiConfig: DEFAULT_WIKI_CONFIG }
    expect(await executeWikiDiscovery({}, context)).toMatchObject({ success: false, error: 'wiki_lifecycle_not_ready' })
    await controller.enable()
    expect((await executeWikiDiscovery({}, context)).success).toBe(true)
    await controller.markRecoveryRequired()
    expect(await executeWikiDiscovery({}, context)).toMatchObject({ success: false, error: 'wiki_lifecycle_not_ready' })
    expect(await executeWikiDiscovery({}, { userDataDir })).toMatchObject({ success: false, error: 'wiki_config_missing' })
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  it('从当前应用数据库恢复缺失的调用上下文 Wiki 配置', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-discovery-db-config-'))
    const wikiRoot = path.join(userDataDir, DEFAULT_WIKI_CONFIG.rootPath)
    fs.mkdirSync(wikiRoot, { recursive: true })
    await createWikiLifecycleController(wikiRoot).initialize({ fresh: true })
    await createWikiLifecycleController(wikiRoot).enable()
    const db = openDatabase(':memory:')
    setConfigValue(db, 'config.wiki', JSON.stringify(DEFAULT_WIKI_CONFIG))
    try {
      expect(await executeWikiDiscovery({}, { userDataDir, appDatabase: db })).toMatchObject({ success: true })
    } finally {
      db.close()
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
