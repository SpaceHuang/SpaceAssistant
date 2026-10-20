import path from 'node:path'
import type { AutomationRunOutputScope, AutomationTaskAccessPermissions, AutomationTaskPermission } from '../../src/shared/automationTaskTypes'
import { isValidAutomationRunOutputScope } from './taskOutputDirectory'

// facts: read only the frozen main-process receipt; the compatibility `tools` projection is never an authority source.
function permissionRecord(access: AutomationTaskAccessPermissions | undefined): readonly AutomationTaskPermission[] {
  const record = access?.authorizationRecord
  if (!record || record.actor !== 'user-confirmation' || record.source !== 'task-preflight-confirmation' || !Array.isArray(record.permissions)) return []
  return record.permissions
}

function pathApi(...values: string[]): typeof path.posix {
  return values.some((value) => path.win32.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) ? path.win32 : path.posix
}

function isPathWithinAnyRoot(targetPath: string, roots: readonly string[]): boolean {
  if (!targetPath || roots.length === 0) return false
  const api = pathApi(targetPath, ...roots)
  const target = api.resolve(targetPath)
  return roots.some((rawRoot) => {
    if (!rawRoot) return false
    const root = api.resolve(rawRoot)
    const relative = api.relative(root, target)
    return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative))
  })
}

export function matchAutomationShellPermission(access: AutomationTaskAccessPermissions | undefined, command: string, workingDirectory: string): boolean {
  if (!command || !workingDirectory) return false
  return permissionRecord(access).some((permission) => permission.kind === 'local-shell'
    && Array.isArray(permission.commands)
    && permission.commands.some((approved) => approved.command === command && pathApi(approved.workingDirectory, workingDirectory).resolve(approved.workingDirectory) === pathApi(approved.workingDirectory, workingDirectory).resolve(workingDirectory))
    && isPathWithinAnyRoot(workingDirectory, permission.scopeRoots))
}

export function matchAutomationGrepPermission(access: AutomationTaskAccessPermissions | undefined, targetPath: string): boolean {
  return permissionRecord(access).some((permission) => permission.kind === 'grep' && isPathWithinAnyRoot(targetPath, permission.scopeRoots))
}

/** Facts phase: only a current user-confirmed result-write receipt matching the frozen archive scope grants output writes. */
export function matchAutomationResultWritePermission(access: AutomationTaskAccessPermissions | undefined, scope: AutomationRunOutputScope): boolean {
  const record = access?.authorizationRecord
  if (!record || !record.id || record.actor !== 'user-confirmation' || record.source !== 'task-preflight-confirmation'
    || !Number.isFinite(record.approvedAt)
    || record.taskRevision !== scope.taskRevision || !Array.isArray(record.permissions)
    || !isValidAutomationRunOutputScope(scope)) return false
  return record.permissions.some((permission) => {
    if (permission.kind !== 'result-write' || permission.organization !== scope.organization) return false
    const api = pathApi(permission.outputDirectory, scope.outputDirectory)
    const approved = api.resolve(permission.outputDirectory)
    const requested = api.resolve(scope.outputDirectory)
    return api === path.win32
      ? approved.toLocaleLowerCase('en-US') === requested.toLocaleLowerCase('en-US')
      : approved === requested
  })
}

export function matchAutomationScriptPermission(access: AutomationTaskAccessPermissions | undefined, workingDirectory: string, observedPaths: readonly string[]): boolean {
  return permissionRecord(access).some((permission) => permission.kind === 'run-script'
    && permission.scriptHashBinding === 'per-invocation'
    && isPathWithinAnyRoot(workingDirectory, permission.scopeRoots)
    && observedPaths.every((targetPath) => isPathWithinAnyRoot(targetPath, permission.scopeRoots)))
}

/** Match an MCP call only to the exact host-approved connection profile and registered tool descriptor. */
export function matchAutomationMcpPermission(
  access: AutomationTaskAccessPermissions | undefined,
  entry: { serverId: string; originalName: string; descriptorHash?: string; profileHash?: string }
): boolean {
  if (!entry.serverId || !entry.originalName || !/^[a-f0-9]{64}$/.test(entry.descriptorHash ?? '') || !/^[a-f0-9]{64}$/.test(entry.profileHash ?? '')) return false
  return permissionRecord(access).some((permission) => permission.kind === 'mcp-tool'
    && permission.serverId === entry.serverId
    && permission.toolName === entry.originalName
    && permission.descriptorHash === entry.descriptorHash
    && permission.profileHash === entry.profileHash)
}
