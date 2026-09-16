import { describe, expect, it } from 'vitest'
import { resolveMcpArtifactPath } from './mcpArtifactPath'

describe('resolveMcpArtifactPath', () => {
  it('resolves valid ids into the dedicated MCP directory', () => {
    expect(resolveMcpArtifactPath('/data', `artifact-mcp-${'a'.repeat(64)}`)).toBe(`/data/shell-output/mcp/artifact-mcp-${'a'.repeat(64)}.log`)
  })
  it('rejects traversal and shell artifact ids', () => {
    expect(resolveMcpArtifactPath('/data', '../secret')).toBeUndefined()
    expect(resolveMcpArtifactPath('/data', `artifact-${'a'.repeat(64)}`)).toBeUndefined()
  })
})
