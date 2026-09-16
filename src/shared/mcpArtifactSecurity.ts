export type McpArtifactOwnerIdentity = { sessionId: string; assistantMessageId: string; toolUseId: string }

export function isValidMcpArtifactId(value: unknown): value is `artifact-mcp-${string}` {
  return typeof value === 'string' && /^artifact-mcp-[0-9a-f]{64}$/i.test(value)
}

export function isMcpArtifactOwner(expected: McpArtifactOwnerIdentity, actual: unknown): actual is McpArtifactOwnerIdentity {
  return Boolean(actual && typeof actual === 'object' &&
    (actual as McpArtifactOwnerIdentity).sessionId === expected.sessionId &&
    (actual as McpArtifactOwnerIdentity).assistantMessageId === expected.assistantMessageId &&
    (actual as McpArtifactOwnerIdentity).toolUseId === expected.toolUseId)
}
