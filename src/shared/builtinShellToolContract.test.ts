import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

describe('builtin run_shell naming contract', () => {
  it('exposes exactly one canonical shell string tool', () => {
    const shellTools = BUILTIN_TOOL_DEFINITIONS.filter((tool) =>
      tool.name === 'run_shell' || tool.name === 'bash' || tool.name === 'Bash'
    )
    expect(shellTools.map((tool) => tool.name)).toEqual(['run_shell'])
    expect(BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.name === 'run_shell')).toHaveLength(1)
    expect(shellTools[0]?.description).toContain('PowerShell 5.1')
    expect(shellTools[0]?.description).not.toContain('Windows: cmd')
  })

  it('keeps external protocol aliases out of the builtin registry', () => {
    expect(BUILTIN_TOOL_DEFINITIONS.some((tool) => tool.name === 'bash' || tool.name === 'Bash')).toBe(false)
  })
})
