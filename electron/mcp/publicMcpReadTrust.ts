import type { McpServerProfile, McpToolDescriptor } from '../../src/shared/mcpTypes'
import { hashMcpToolDescription, hashMcpToolSchema } from './mcpToolRegistry'

export type PublicMcpReadAuthorization = {
  querySource: 'public' | 'unknown'
  accountAuthorization: 'authorized' | 'unknown'
}

export function resolvePublicMcpReadAuthorization(
  profile: Pick<McpServerProfile, 'id' | 'enabled' | 'enabledToolNames'> & {
    publicReadOnlyTools?: Record<string, string>
    accountAuthorizedTools?: Record<string, string>
  },
  entry: Pick<McpToolDescriptor, 'serverId' | 'originalName' | 'descriptorHash' | 'schemaHash' | 'annotations' | 'description' | 'inputSchema'>
): PublicMcpReadAuthorization {
  const schemaHashValid = entry.schemaHash === hashMcpToolSchema(entry.inputSchema)
  const descriptorHashValid = schemaHashValid && entry.descriptorHash === hashMcpToolDescription({
    serverId: entry.serverId,
    originalName: entry.originalName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    ...(entry.annotations ? { annotations: entry.annotations } : {})
  })
  const explicitlyTrusted = profile.publicReadOnlyTools?.[entry.originalName] === entry.descriptorHash
  const explicitlyAccountAuthorized = profile.accountAuthorizedTools?.[entry.originalName] === entry.descriptorHash
  const eligibleAccountUse = profile.enabled && profile.id === entry.serverId && profile.enabledToolNames.includes(entry.originalName) &&
    explicitlyAccountAuthorized && descriptorHashValid
  const eligibleRead = profile.enabled && profile.id === entry.serverId && profile.enabledToolNames.includes(entry.originalName) &&
    explicitlyTrusted && descriptorHashValid && entry.annotations?.readOnlyHint === true && entry.annotations.destructiveHint !== true
  return {
    querySource: eligibleRead ? 'public' : 'unknown',
    accountAuthorization: eligibleAccountUse ? 'authorized' : 'unknown'
  }
}
