import path from 'node:path'
import type { AutomationTaskMcpToolCandidate, AutomationTaskToolRequirement } from '../../src/shared/automationTaskTypes'
import { extractScriptPathFacts } from '../confirmation/extractors/scriptPathFacts'
import type { TaskPathFacts } from './taskPathFacts'
import type { TaskPreflightMockTraceItem } from './taskPreflightMockRunner'

export type TaskPreflightPermissionDerivationInput = {
  trace: readonly TaskPreflightMockTraceItem[]
  facts: TaskPathFacts
  mcpTools?: readonly (AutomationTaskMcpToolCandidate & { mappedName?: string })[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function knownDirectory(value: string, facts: TaskPathFacts): boolean {
  return facts.roots.includes(value)
    || facts.outputRoot === value
    || facts.entries.some((entry) => entry.path === value && entry.kind === 'directory')
    || facts.proposedPathCandidates?.some((candidate) => candidate.path === value && candidate.kind === 'directory') === true
}

function preferredWorkingDirectory(facts: TaskPathFacts, trace: readonly TaskPreflightMockTraceItem[]): string | undefined {
  const knownDirectories = new Set([
    ...facts.roots,
    ...(facts.outputRoot ? [facts.outputRoot] : []),
    ...(facts.proposedPathCandidates ?? []).filter((candidate) => candidate.kind === 'directory').map((candidate) => candidate.path)
  ])
  const requestedWorkingDirectories = [...new Set(trace.flatMap((call) => {
    if (call.toolName !== 'run_shell') return []
    const value = asRecord(call.input).workingDirectory
    return typeof value === 'string' && value.trim() ? [value] : []
  }))]
  if (requestedWorkingDirectories.length === 1 && knownDirectories.has(requestedWorkingDirectories[0]!)) return requestedWorkingDirectories[0]
  const proposedDirectories = (facts.proposedPathCandidates ?? []).filter((candidate) => candidate.kind === 'directory')
  return proposedDirectories.length === 1 ? proposedDirectories[0]!.path : undefined
}

function initialWorkingDirectory(facts: TaskPathFacts, trace: readonly TaskPreflightMockTraceItem[]): string {
  const workingDirectory = preferredWorkingDirectory(facts, trace)
    ?? facts.roots[0]
  if (!workingDirectory || !path.isAbsolute(workingDirectory) || path.normalize(workingDirectory) !== workingDirectory) {
    throw new Error('PREFLIGHT_TRACE_WORKING_DIRECTORY_UNAVAILABLE')
  }
  return workingDirectory
}

function resolveTracePath(rawPath: unknown, workingDirectory: string): string {
  if (rawPath !== undefined && (typeof rawPath !== 'string' || rawPath.trim().length === 0)) {
    throw new Error('PREFLIGHT_TRACE_PATH_INVALID')
  }
  const resolved = path.resolve(workingDirectory, typeof rawPath === 'string' ? rawPath : workingDirectory)
  if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved) throw new Error('PREFLIGHT_TRACE_PATH_INVALID')
  return resolved
}

/** facts: derive permission proposals only from host-recorded Mock calls. This does not
 * authorize, dispatch, or infer calls that are absent from the trace.
 */
/*
 * A requirement needs a directory root. Facts tell us whether an already-authorized path is a
 * file or directory. For a path outside the enumerated roots, request its parent directory so
 * that a file target is still representable; the user sees and approves that exact directory.
 */
function directoryRootForTracePath(rawPath: unknown, workingDirectory: string, facts: TaskPathFacts): string {
  if (rawPath === undefined || rawPath === '.') return workingDirectory
  const resolved = resolveTracePath(rawPath, workingDirectory)
  if (resolved === workingDirectory) return workingDirectory
  const known = facts.entries.find((entry) => entry.path === resolved)
    ?? facts.proposedPathCandidates?.find((candidate) => candidate.path === resolved)
  if (known?.kind === 'directory') return resolved
  if (known?.kind === 'file') return path.dirname(resolved)
  if (known && (known.kind === 'symlink' || known.kind === 'special')) throw new Error('PREFLIGHT_TRACE_PATH_UNSAFE')
  return path.dirname(resolved)
}

export function deriveTaskPreflightPermissions(input: TaskPreflightPermissionDerivationInput): AutomationTaskToolRequirement[] {
  const calls = input.trace.filter((item) => item.dispatch === 'simulated' || item.dispatch === 'not-dispatched')
  const permissionCalls = calls.filter((call) => call.toolName === 'run_shell' || call.toolName === 'grep'
    || call.toolName === 'run_script' || call.toolName.startsWith('mcp_'))
  if (permissionCalls.length === 0) return []

  const grepPaths: unknown[] = []
  const scriptPaths: string[] = []
  let hasScriptCall = false
  for (const call of permissionCalls) {
    const args = asRecord(call.input)
    if (call.toolName === 'run_shell') {
      if (typeof args.command !== 'string' || args.command.trim().length === 0 || args.command.length > 4096) {
        throw new Error('PREFLIGHT_TRACE_SHELL_COMMAND_INVALID')
      }
      if (args.workingDirectory !== undefined && (typeof args.workingDirectory !== 'string'
        || !path.isAbsolute(args.workingDirectory) || path.normalize(args.workingDirectory) !== args.workingDirectory
        || !knownDirectory(args.workingDirectory, input.facts))) {
        throw new Error('PREFLIGHT_TRACE_WORKING_DIRECTORY_UNVERIFIED')
      }
    } else if (call.toolName === 'grep') {
      grepPaths.push(args.path)
    } else if (call.toolName === 'run_script') {
      hasScriptCall = true
      const code = typeof args.code === 'string' ? args.code : ''
      const language = typeof args.language === 'string' ? args.language : 'python'
      scriptPaths.push(...extractScriptPathFacts(code, language).paths)
    } else if (call.toolName.startsWith('mcp_')) {
      const candidates = input.mcpTools?.filter((tool) => tool.mappedName === call.toolName) ?? []
      if (candidates.length === 0) throw new Error('PREFLIGHT_TRACE_MCP_TOOL_UNRESOLVED')
      if (candidates.length !== 1) throw new Error('PREFLIGHT_TRACE_MCP_TOOL_AMBIGUOUS')
      const candidate = candidates[0]!
      if (!candidate.serverId || !candidate.toolName || !/^[a-f0-9]{64}$/.test(candidate.descriptorHash) || !/^[a-f0-9]{64}$/.test(candidate.profileHash)) {
        throw new Error('PREFLIGHT_TRACE_MCP_IDENTITY_INVALID')
      }
    }
  }

  const requiresWorkingDirectory = permissionCalls.some((call) => call.toolName === 'run_shell' || call.toolName === 'grep' || call.toolName === 'run_script')
  const preferred = preferredWorkingDirectory(input.facts, input.trace)
  let workingDirectory = requiresWorkingDirectory ? initialWorkingDirectory(input.facts, input.trace) : undefined
  let grepRoots = new Set<string>()
  let scriptRoots = new Set<string>()
  if (workingDirectory) {
    let converged = false
    for (let attempt = 0; attempt < 32; attempt += 1) {
      grepRoots = new Set(grepPaths.map((rawPath) => directoryRootForTracePath(rawPath, workingDirectory!, input.facts)))
      scriptRoots = new Set(hasScriptCall ? [workingDirectory] : [])
      for (const rawPath of scriptPaths) scriptRoots.add(directoryRootForTracePath(rawPath, workingDirectory, input.facts))

      // Authorized roots are sorted before they become the unattended session's workDir.
      // Include newly proposed tool roots when binding Shell cwd so confirmation and execution
      // use the same host-selected directory after the user approves the whole list.
      const nextWorkingDirectory = preferred
        ?? [...new Set([...input.facts.roots, ...grepRoots, ...scriptRoots])].sort()[0]
        ?? input.facts.outputRoot
      if (!nextWorkingDirectory) throw new Error('PREFLIGHT_TRACE_WORKING_DIRECTORY_UNAVAILABLE')
      if (nextWorkingDirectory === workingDirectory) { converged = true; break }
      workingDirectory = nextWorkingDirectory
    }
    if (!converged) throw new Error('PREFLIGHT_TRACE_WORKING_DIRECTORY_UNSTABLE')
  }

  const shells = new Map<string, Extract<AutomationTaskToolRequirement, { tool: 'run_shell' }>>()
  const mcp = new Map<string, Extract<AutomationTaskToolRequirement, { tool: 'mcp' }>>()

  for (const call of calls) {
    const args = asRecord(call.input)
    if (call.toolName === 'run_shell') {
      const command = args.command as string
      const callWorkingDirectory = typeof args.workingDirectory === 'string' ? args.workingDirectory : workingDirectory
      if (!callWorkingDirectory) throw new Error('PREFLIGHT_TRACE_WORKING_DIRECTORY_UNAVAILABLE')
      const requirement = { tool: 'run_shell' as const, command, workingDirectory: callWorkingDirectory }
      shells.set(`${requirement.command}\0${requirement.workingDirectory}`, requirement)
    } else if (call.toolName.startsWith('mcp_')) {
      const candidate = input.mcpTools?.find((tool) => tool.mappedName === call.toolName)
      if (!candidate) continue // unresolved MCP identities were rejected before path derivation.
      const requirement = {
        tool: 'mcp' as const,
        serverId: candidate.serverId,
        toolName: candidate.toolName,
        purpose: '按任务调用此 MCP 工具'
      }
      mcp.set(`${candidate.serverId}\0${candidate.toolName}`, requirement)
    }
  }

  return [
    ...[...shells.values()].sort((a, b) => a.command.localeCompare(b.command) || a.workingDirectory.localeCompare(b.workingDirectory)),
    ...(grepRoots.size ? [{ tool: 'grep' as const, scopeRoots: [...grepRoots].sort() }] : []),
    ...(scriptRoots.size ? [{ tool: 'run_script' as const, scopeRoots: [...scriptRoots].sort() }] : []),
    ...[...mcp.values()].sort((a, b) => a.serverId.localeCompare(b.serverId) || a.toolName.localeCompare(b.toolName))
  ]
}
