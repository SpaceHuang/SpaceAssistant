import { toolIdToOpenAiCompatibleApiToolName } from '../../src/shared/anthropicToolSanitize'
import { normalizeExternalToolName } from '../../src/shared/toolNameCompatibility'

export interface NamedRegisteredToolRegistry<T = unknown> {
  get(name: string): T | undefined
  entries?(): readonly Readonly<{ name: string }>[]
}

/** Resolve an API-visible tool name to its unique internal RegisteredTool identity. */
export function resolveRegisteredToolName<T>(providerToolName: string, registry: NamedRegisteredToolRegistry<T>): string {
  const canonical = normalizeExternalToolName(providerToolName).canonicalName
  if (registry.get(canonical) !== undefined) return canonical

  const matches = registry.entries?.()
    .filter((tool) => toolIdToOpenAiCompatibleApiToolName(normalizeExternalToolName(tool.name).canonicalName) === providerToolName)
    .map((tool) => tool.name) ?? []
  const uniqueMatches = [...new Set(matches)]
  if (uniqueMatches.length > 1) throw new Error(`REGISTERED_TOOL_ALIAS_AMBIGUOUS:${providerToolName}`)
  return uniqueMatches[0] ?? canonical
}
