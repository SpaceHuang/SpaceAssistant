import { beforeAll, describe, expect, it } from 'vitest'
import { scriptParserService } from '../shell/scriptParserService'
import { deriveTaskPreflightPermissions } from './taskPreflightPermissionDeriver'
import type { TaskPreflightMockTraceItem } from './taskPreflightMockRunner'
import type { TaskPathFacts } from './taskPathFacts'

const facts = (overrides: Partial<TaskPathFacts> = {}): TaskPathFacts => ({
  roots: ['/workspace'],
  gitRepositories: [],
  entries: [
    { path: '/workspace', relativePath: '', kind: 'directory' },
    { path: '/workspace/src', relativePath: 'src', kind: 'directory' },
    { path: '/workspace/src/input.csv', relativePath: 'src/input.csv', kind: 'file' }
  ],
  coverage: { complete: true, truncated: false, roots: 1, visited: 3, errors: 0 },
  digest: 'facts',
  ...overrides
})

const call = (toolName: string, input: unknown, dispatch: TaskPreflightMockTraceItem['dispatch'] = 'simulated'): TaskPreflightMockTraceItem => ({
  kind: 'proposed-tool-call', toolName, input, dispatch, ...(dispatch === 'simulated' ? { resultKind: 'synthetic' as const } : {})
})

describe('deriveTaskPreflightPermissions', () => {
  beforeAll(async () => { await scriptParserService.ensureInitialized() })

  it('derives exact Shell arguments and host-selected cwd plus concrete grep, script, and MCP scopes', () => {
    const mcpName = 'mcp_issues_search_ab12cd34'
    const requirements = deriveTaskPreflightPermissions({
      facts: facts(),
      trace: [
        call('run_shell', { command: 'git log --oneline -5', workingDirectory: '/model-cwd', timeout: 1 }),
        call('grep', { pattern: 'release', path: 'src/input.csv' }),
        call('run_script', { code: 'open("src/input.csv", "r").read()' }),
        call(mcpName, { query: 'recent' })
      ],
      mcpTools: [{ serverId: 'server-1', serverName: 'Issues', toolName: 'search', description: 'Search issues', parameters: [], descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64), mappedName: mcpName }]
    })

    expect(requirements).toEqual([
      { tool: 'run_shell', command: 'git log --oneline -5', workingDirectory: '/workspace' },
      { tool: 'grep', scopeRoots: ['/workspace/src'] },
      { tool: 'run_script', scopeRoots: ['/workspace', '/workspace/src'] },
      { tool: 'mcp', serverId: 'server-1', toolName: 'search', purpose: '按任务调用此 MCP 工具' }
    ])
  })

  it('includes the over-budget not-dispatched call, ignores blocked calls, and uses output root as the actual cwd fallback', () => {
    const requirements = deriveTaskPreflightPermissions({
      facts: facts({ roots: [], entries: [], outputRoot: '/results' }),
      trace: [
        call('run_shell', { command: 'git status --short' }, 'not-dispatched'),
        call('grep', { pattern: 'x', path: '/unavailable/secret' }, 'blocked')
      ]
    })

    expect(requirements).toEqual([{ tool: 'run_shell', command: 'git status --short', workingDirectory: '/results' }])
  })

  it('fails closed when a recorded MCP call cannot be mapped to the host MCP snapshot', () => {
    expect(() => deriveTaskPreflightPermissions({ facts: facts(), trace: [call('mcp_missing_tool', {})] }))
      .toThrow('PREFLIGHT_TRACE_MCP_TOOL_UNRESOLVED')
  })

  it('fails closed when a mapped MCP runtime name is ambiguous in the host snapshot', () => {
    const mappedName = 'mcp_issues_search_ab12cd34'
    const candidates = [
      { serverId: 'server-1', serverName: 'Issues', toolName: 'search', description: 'Search', parameters: [], descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64), mappedName },
      { serverId: 'server-2', serverName: 'Other', toolName: 'search', description: 'Search', parameters: [], descriptorHash: 'c'.repeat(64), profileHash: 'd'.repeat(64), mappedName }
    ]
    expect(() => deriveTaskPreflightPermissions({ facts: facts(), trace: [call(mappedName, {})], mcpTools: candidates }))
      .toThrow('PREFLIGHT_TRACE_MCP_TOOL_AMBIGUOUS')
  })

  it('fails closed when a permission-gated call lacks its security-critical parameter', () => {
    expect(() => deriveTaskPreflightPermissions({ facts: facts(), trace: [call('run_shell', { command: '   ' })] }))
      .toThrow('PREFLIGHT_TRACE_SHELL_COMMAND_INVALID')
  })
})
