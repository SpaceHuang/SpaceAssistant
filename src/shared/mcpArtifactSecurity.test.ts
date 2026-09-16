import { describe, expect, it } from 'vitest'
import { isValidMcpArtifactId, isMcpArtifactOwner } from './mcpArtifactSecurity'

describe('mcpArtifactSecurity', () => {
  it('accepts only the MCP artifact id format', () => {
    expect(isValidMcpArtifactId(`artifact-mcp-${'a'.repeat(64)}`)).toBe(true)
    expect(isValidMcpArtifactId(`artifact-${'a'.repeat(64)}`)).toBe(false)
    expect(isValidMcpArtifactId(`artifact-mcp-${'a'.repeat(63)}`)).toBe(false)
  })

  it('requires all owner identity fields to match', () => {
    const owner = { sessionId: 's1', assistantMessageId: 'm1', toolUseId: 't1' }
    expect(isMcpArtifactOwner(owner, { ...owner })).toBe(true)
    expect(isMcpArtifactOwner(owner, { ...owner, toolUseId: 't2' })).toBe(false)
  })
})
