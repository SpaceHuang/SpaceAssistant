import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { discoverWikiTools, executeWikiDiscovery, WIKI_DISCOVERY_TOOL_DEFINITION, WIKI_DOMAIN_TOOL_DEFINITIONS } from './wikiToolDiscovery'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import { isBuiltinToolName } from '../toolsConfigRuntime'
import { createWikiLifecycleController } from './wikiLifecycle'
import { DEFAULT_WIKI_CONFIG } from '../../src/shared/domainTypes'

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
    expect(registry.get('memory.wiki_apply_restore')).toBeDefined()
    expect(registry.get('memory.wiki_propose_schema_change')).toBeDefined()
    expect(registry.get('memory.wiki_update_schema')).toBeDefined()
    expect(WIKI_DOMAIN_TOOL_DEFINITIONS.find(tool => tool.name === 'memory.wiki_update_schema')?.input_schema).toMatchObject({ required: ['proposalId', 'expectedSchemaVersion', 'proposalDiff'] })
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
    expect((await executeWikiDiscovery({}, context)).success).toBe(true)
    await controller.markRecoveryRequired()
    expect(await executeWikiDiscovery({}, context)).toMatchObject({ success: false, error: 'wiki_lifecycle_not_ready' })
    expect(await executeWikiDiscovery({}, { userDataDir })).toMatchObject({ success: false, error: 'wiki_lifecycle_unavailable' })
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })
})
