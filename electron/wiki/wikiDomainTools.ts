import { defineDirectTool, type RegisteredTool } from '../tools/plannedToolRegistry'
import type { ToolExecutionContext, ToolExecutorResult } from '../tools/types'
import { createWikiLifecycleController } from './wikiLifecycle'
import { createWikiFileStore } from './wikiFileStore'
import { resolveSharedWikiRoot } from './wikiInit'
import { parseWikiSchema } from './wikiSchema'

type WikiInput = Record<string, unknown>

export function createWikiDomainTools(): RegisteredTool[] {
  return [defineDirectTool<WikiInput, ToolExecutorResult>({
    name: 'memory.wiki_get_schema',
    actionClass: 'read',
    parseInput: (input) => requireRecord(input),
    execute: async (_input, context) => getWikiSchemaForContext(context.runtimeContext as ToolExecutionContext)
  })]
}

export async function getWikiSchemaForContext(context: Pick<ToolExecutionContext, 'wikiConfig' | 'userDataDir'>): Promise<ToolExecutorResult> {
  if (!context.wikiConfig) return { success: false, error: 'wiki_lifecycle_unavailable' }
  const root = resolveSharedWikiRoot(context.userDataDir, context.wikiConfig)
  const lifecycle = await createWikiLifecycleController(root).read()
  if (lifecycle.lifecycle !== 'domain_ready' && lifecycle.lifecycle !== 'domain_enabled') return { success: false, error: 'wiki_lifecycle_not_ready' }
  const store = createWikiFileStore(root)
  const content = await store.readText('SCHEMA.md').catch(() => undefined)
  if (content === undefined) return { success: false, error: 'wiki_schema_unavailable' }
  const parsed = parseWikiSchema(content)
  const stateText = await store.readText('.wiki-service/schema-state.json').catch(() => undefined)
  let schemaVersion = 1
  if (stateText !== undefined) {
    try {
      const state = JSON.parse(stateText) as { formatVersion?: unknown; schemaVersion?: unknown }
      if (state.formatVersion !== 1 || !Number.isSafeInteger(state.schemaVersion) || (state.schemaVersion as number) < 1) return { success: false, error: 'wiki_schema_state_invalid' }
      schemaVersion = state.schemaVersion as number
    } catch {
      return { success: false, error: 'wiki_schema_state_invalid' }
    }
  }
  return { success: true, data: { schemaVersion, content, valid: parsed.valid, categories: parsed.categories, diagnostics: parsed.diagnostics } }
}

function requireRecord(value: unknown): WikiInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
  return structuredClone(value as WikiInput)
}
