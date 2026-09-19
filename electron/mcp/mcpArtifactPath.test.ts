import path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveMcpArtifactPath } from './mcpArtifactPath'

describe('resolveMcpArtifactPath', () => {
  it('resolves valid ids into the dedicated MCP directory', () => {
    // 期望与实现同用 path.resolve/join 构造（Windows 宿主上盘符补全 + 反斜杠为正确行为）
    expect(resolveMcpArtifactPath('/data', `artifact-mcp-${'a'.repeat(64)}`)).toBe(
      path.join(path.resolve('/data'), 'shell-output', 'mcp', `artifact-mcp-${'a'.repeat(64)}.log`)
    )
  })
  it('rejects traversal and shell artifact ids', () => {
    expect(resolveMcpArtifactPath('/data', '../secret')).toBeUndefined()
    expect(resolveMcpArtifactPath('/data', `artifact-${'a'.repeat(64)}`)).toBeUndefined()
  })
})
