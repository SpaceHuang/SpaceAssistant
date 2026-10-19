import { describe, expect, it } from 'vitest'
import type { AutomationTaskAccessPermissions, AutomationTaskAuthorizationRecord } from '../../src/shared/automationTaskTypes'
import { matchAutomationGrepPermission, matchAutomationMcpPermission, matchAutomationScriptPermission, matchAutomationShellPermission } from './automationTaskPermissionMatch'

const root = '/workspace/repo'
const record: AutomationTaskAuthorizationRecord = {
  id: 'receipt-1', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 3,
  permissions: [
    { kind: 'local-shell', scopeRoots: [root], commands: [{ command: 'git log --oneline -5', workingDirectory: root, timeout: 60 }] },
    { kind: 'grep', scopeRoots: [root] },
    { kind: 'run-script', scopeRoots: [root], scriptHashBinding: 'per-invocation' },
    { kind: 'mcp-tool', serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search_issues', description: 'Search issues', purpose: 'Search recently updated issues', parameters: [{ name: 'query', required: true }], descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64) }
  ] as never
}
const permissions: AutomationTaskAccessPermissions = { directories: [root], tools: ['run_shell', 'grep', 'run_script'], authorizationRecord: record }

describe('scheduled task tool permission matching', () => {
  it('matches run_shell by the full approved command parameters and working directory', () => {
    expect(matchAutomationShellPermission(permissions, 'git log --oneline -5', root, 60)).toBe(true)
    expect(matchAutomationShellPermission(permissions, 'git log --oneline -10', root)).toBe(false)
    expect(matchAutomationShellPermission(permissions, 'git log --oneline -5', root, 120)).toBe(false)
    expect(matchAutomationShellPermission(permissions, 'git log --oneline -5', root)).toBe(false)
    expect(matchAutomationShellPermission(permissions, 'git log --oneline -5', '/workspace/other', 60)).toBe(false)
  })

  it('matches grep only when the normalized search path is inside its approved roots', () => {
    expect(matchAutomationGrepPermission(permissions, `${root}/src/file.ts`)).toBe(true)
    expect(matchAutomationGrepPermission(permissions, '/workspace/private/file.ts')).toBe(false)
  })

  it('matches script execution only when the working directory and every observed path stay in scope', () => {
    expect(matchAutomationScriptPermission(permissions, root, [`${root}/src/input.csv`])).toBe(true)
    expect(matchAutomationScriptPermission(permissions, root, [`${root}/src/input.csv`, '/etc/passwd'])).toBe(false)
    expect(matchAutomationScriptPermission(permissions, '/workspace/other', [])).toBe(false)
  })

  it('matches MCP authorization by exact server, tool descriptor, and connection profile fingerprints', () => {
    const entry = { serverId: 'server-1', originalName: 'search_issues', descriptorHash: 'a'.repeat(64), profileHash: 'b'.repeat(64) }
    expect(matchAutomationMcpPermission(permissions, entry)).toBe(true)
    expect(matchAutomationMcpPermission(permissions, { ...entry, serverId: 'server-2' })).toBe(false)
    expect(matchAutomationMcpPermission(permissions, { ...entry, originalName: 'delete_issue' })).toBe(false)
    expect(matchAutomationMcpPermission(permissions, { ...entry, descriptorHash: 'c'.repeat(64) })).toBe(false)
    expect(matchAutomationMcpPermission(permissions, { ...entry, profileHash: 'd'.repeat(64) })).toBe(false)
    expect(matchAutomationMcpPermission(permissions, { ...entry, profileHash: undefined })).toBe(false)
  })

  it('does not treat the legacy tools projection as an authorization receipt', () => {
    expect(matchAutomationShellPermission({ directories: [root], tools: ['run_shell'] }, 'git log --oneline -5', root)).toBe(false)
  })
})
