import path from 'node:path'
import { createHash } from 'node:crypto'
import { extractScriptPathFacts } from '../confirmation/extractors/scriptPathFacts'
import { getPreflightIssueMessageKey, type AutomationTaskMcpToolCandidate, type AutomationTaskPermission, type AutomationTaskToolRequirement, type PreflightClarificationReasonCode, type PreflightIssue, type PreflightReport, type SuggestedDirectory, type TargetBinding } from '../../src/shared/automationTaskTypes'
import { TaskPathFactsProvider, type TaskPathFacts } from './taskPathFacts'
import { resolveTaskTarget, type ProposedTaskTarget } from './taskTargetResolver'
import { MAX_TASK_PREFLIGHT_TRACE_ITEMS, type TaskPreflightMockTool, type TaskPreflightMockTraceItem } from './taskPreflightMockRunner'
import { deriveTaskPreflightPermissions } from './taskPreflightPermissionDeriver'

export type TaskPreflightAnalysisInput = {
  prompt: string
  scheduleSummary: string
  deliverySummary: string
  authorizedRoots: string[]
  outputRoot?: string
  facts: TaskPathFacts
  tools: readonly TaskPreflightMockTool[]
  /** Remaining host deadline after facts collection; caps the model/mock loop. */
  remainingBudgetMs?: number
  mcpTools?: readonly (Pick<AutomationTaskMcpToolCandidate, 'serverId' | 'serverName' | 'toolName' | 'description' | 'parameters'> & { mappedName?: string })[]
  responseFormat: 'json'
}

export type TaskPreflightClarification = { reference: string; reasonCode: PreflightClarificationReasonCode; candidates?: string[] }
export type TaskPreflightAnalysisOutput = { targets: ProposedTaskTarget[]; /** Main-process projection derived from mockTrace; model-authored values are ignored. */ requiredPermissions?: AutomationTaskToolRequirement[]; clarifications?: TaskPreflightClarification[]; suggestedDirectories?: Array<{ path: string; purpose: string; source: string }>; mockTrace?: TaskPreflightMockTraceItem[]; mockIncomplete?: boolean; mockIncompleteReason?: string }
export type TaskPreflightAnalyzer = { analyze(input: TaskPreflightAnalysisInput, signal: AbortSignal): Promise<TaskPreflightAnalysisOutput> }
export type TaskPreflightInput = { prompt: string; scheduleSummary: string; deliverySummary: string; roots: string[]; outputDir?: string; taskRevision: number; preflightStartedAt?: number; mcpTools?: Array<AutomationTaskMcpToolCandidate & { mappedName?: string }>; tools?: TaskPreflightMockTool[]; /** Host-only continuation after the user approves a previously displayed permission list. */ analysisOverride?: TaskPreflightAnalysisOutput }
export type TaskPreflightResult = { report: PreflightReport; bindings: TargetBinding[]; factsDigest?: string; requiredPermissions?: AutomationTaskToolRequirement[]; mockTrace?: TaskPreflightMockTraceItem[]; authorizationContinuation?: { authorizedRoots: string[]; analysis: TaskPreflightAnalysisOutput } }
export type TaskPreflightDependencies = { analyzer: TaskPreflightAnalyzer; factsProvider?: Pick<TaskPathFactsProvider, 'collect'> & Partial<Pick<TaskPathFactsProvider, 'inspectPaths'>>; timeoutMs?: number; now?: () => number }

const issue = (code: string, field = 'prompt', details: Partial<PreflightIssue> = {}): PreflightIssue => ({ code, field, messageKey: getPreflightIssueMessageKey(code), ...details })
const emptyReport = (status: PreflightReport['status'], blockers: PreflightIssue[], suggestedDirectories: SuggestedDirectory[] = []): PreflightReport => ({ status, blockers, suggestedDirectories })
const DEFAULT_ANALYZER_TIMEOUT_MS = 60_000
const BUDGET_STOP_REASONS = new Set([
  'model_round_limit',
  'tool_call_limit',
  'total_timeout',
  'model_request_timeout',
  'model_output_limit',
  'PREFLIGHT_MODEL_TRUNCATED_RESPONSE'
])
const withAnalysisCoverage = (report: PreflightReport, analysis: TaskPreflightAnalysisOutput): PreflightReport => ({
  ...report,
  ...(analysis.mockIncomplete && analysis.mockIncompleteReason && BUDGET_STOP_REASONS.has(analysis.mockIncompleteReason)
    ? { preflightCoverage: 'partial' as const }
    : {})
})

function withPermissionNeeds(
  report: PreflightReport,
  requirements: readonly AutomationTaskToolRequirement[],
  mcpTools: readonly AutomationTaskMcpToolCandidate[] = [],
  additionalDirectories: readonly string[] = []
): PreflightReport {
  if (report.status !== 'blocked' || (requirements.length === 0 && additionalDirectories.length === 0)) return report

  const needs: AutomationTaskPermission[] = []
  const directoryPaths = [...new Set([...additionalDirectories, ...requirements.flatMap((permission) => permission.tool === 'run_shell'
    ? [permission.workingDirectory]
    : permission.tool === 'grep' || permission.tool === 'run_script' ? permission.scopeRoots : [])])].sort()
  needs.push(...directoryPaths.map((directory) => ({ kind: 'directory-read-write' as const, path: directory })))

  const shellRequirements = requirements.filter((permission): permission is Extract<AutomationTaskToolRequirement, { tool: 'run_shell' }> => permission.tool === 'run_shell')
  if (shellRequirements.length) needs.push({
    kind: 'local-shell',
    scopeRoots: [...new Set(shellRequirements.map((permission) => permission.workingDirectory))],
    commands: shellRequirements.map(({ command, workingDirectory }) => ({ command, workingDirectory }))
  })

  const grepRoots = [...new Set(requirements.flatMap((permission) => permission.tool === 'grep' ? permission.scopeRoots : []))]
  if (grepRoots.length) needs.push({ kind: 'grep', scopeRoots: grepRoots })

  const scriptRoots = [...new Set(requirements.flatMap((permission) => permission.tool === 'run_script' ? permission.scopeRoots : []))]
  if (scriptRoots.length) needs.push({ kind: 'run-script', scopeRoots: scriptRoots, scriptHashBinding: 'per-invocation' })

  const seenMcp = new Set<string>()
  for (const requirement of requirements) {
    if (requirement.tool !== 'mcp') continue
    const candidate = mcpTools.find((tool) => tool.serverId === requirement.serverId && tool.toolName === requirement.toolName
      && /^[a-f0-9]{64}$/.test(tool.descriptorHash) && /^[a-f0-9]{64}$/.test(tool.profileHash))
    if (!candidate) continue
    const key = `${candidate.serverId}\0${candidate.toolName}`
    if (seenMcp.has(key)) continue
    seenMcp.add(key)
    needs.push({ kind: 'mcp-tool', serverId: candidate.serverId, serverName: candidate.serverName, toolName: candidate.toolName,
      description: candidate.description, purpose: requirement.purpose, parameters: candidate.parameters,
      descriptorHash: candidate.descriptorHash, profileHash: candidate.profileHash })
  }

  return needs.length ? { ...report, permissionNeeds: needs } : report
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isCanonicalAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value
}

function permissionRoots(requirements: readonly AutomationTaskToolRequirement[]): string[] {
  return [...new Set(requirements.flatMap((permission) => permission.tool === 'run_shell'
    ? [permission.workingDirectory]
    : permission.tool === 'grep' || permission.tool === 'run_script' ? permission.scopeRoots : []))].sort()
}

function rootsNeedingAuthorization(requirements: readonly AutomationTaskToolRequirement[], facts: TaskPathFacts): string[] {
  return permissionRoots(requirements).filter((requestedRoot) => !facts.roots.some((authorizedRoot) => isWithinRoot(requestedRoot, authorizedRoot)))
}

function isVerifiedDirectory(value: string, facts: TaskPathFacts): boolean {
  return facts.outputRoot === value
    || facts.entries.some((entry) => entry.path === value && entry.kind === 'directory')
    || facts.proposedPathCandidates?.some((candidate) => candidate.path === value && candidate.kind === 'directory') === true
}

const DIRECTORY_SCOPED_FILE_TOOLS = new Set(['read_file', 'list_directory', 'write_file', 'edit_file'])

function targetAuthorizationRoot(target: ProposedTaskTarget, facts: TaskPathFacts): string | undefined {
  if (target.kind === 'output') return undefined
  const targetPath = target.kind === 'exact' ? target.path : target.directory
  if (!path.isAbsolute(targetPath) || !isCanonicalAbsolutePath(targetPath)) return undefined
  if (facts.roots.some((root) => isWithinRoot(targetPath, root))) return undefined
  const requestedRoot = target.kind === 'exact' && target.targetType === 'file' ? path.dirname(targetPath) : targetPath
  return isVerifiedDirectory(requestedRoot, facts) ? requestedRoot : undefined
}

function deriveTargetAuthorizationRoots(targets: readonly ProposedTaskTarget[], facts: TaskPathFacts): string[] {
  return [...new Set(targets.flatMap((target) => {
    const root = targetAuthorizationRoot(target, facts)
    return root ? [root] : []
  }))].sort()
}

function resolveFileToolPath(item: TaskPreflightMockTraceItem, facts: TaskPathFacts, workDir?: string): string | undefined {
  if (!DIRECTORY_SCOPED_FILE_TOOLS.has(item.toolName)) return undefined
  const args = item.input && typeof item.input === 'object' && !Array.isArray(item.input)
    ? item.input as Record<string, unknown>
    : {}
  const rawPath = item.toolName === 'list_directory' && args.path === undefined ? '.' : args.path
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) return undefined

  const base = workDir ?? (item.toolName === 'write_file' ? facts.outputRoot : facts.roots[0])
  if (!path.isAbsolute(rawPath) && !base) return undefined
  const resolvedPath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(base!, rawPath))
  if (!path.isAbsolute(resolvedPath) || path.normalize(resolvedPath) !== resolvedPath) return undefined
  return resolvedPath
}

function fileToolCallWithinApprovedScope(
  item: TaskPreflightMockTraceItem,
  facts: TaskPathFacts,
  workDir?: string,
  additionalRoots: readonly string[] = []
): boolean {
  const resolvedPath = resolveFileToolPath(item, facts, workDir)
  if (!resolvedPath) return false

  const authorizedDirectoryReadWrite = [...facts.roots, ...additionalRoots].some((root) => isWithinRoot(resolvedPath, root))
  if (authorizedDirectoryReadWrite) return true
  // facts: the selected output root grants write-only access. Only write_file is a write-only
  // operation here; edit_file reads the existing target and must stay under an authorized root.
  return item.toolName === 'write_file' && Boolean(facts.outputRoot && isWithinRoot(resolvedPath, facts.outputRoot))
}

function fileToolAuthorizationRoot(item: TaskPreflightMockTraceItem, facts: TaskPathFacts, workDir?: string): string | undefined {
  if (!DIRECTORY_SCOPED_FILE_TOOLS.has(item.toolName)) return undefined
  const resolvedPath = resolveFileToolPath(item, facts, workDir)
  if (!resolvedPath || facts.roots.some((root) => isWithinRoot(resolvedPath, root))) return undefined
  if (item.toolName === 'write_file' && facts.outputRoot && isWithinRoot(resolvedPath, facts.outputRoot)) return undefined

  const requestedRoot = item.toolName === 'list_directory' ? resolvedPath : path.dirname(resolvedPath)
  return isVerifiedDirectory(requestedRoot, facts) ? requestedRoot : undefined
}

function deriveFileToolAuthorizationRoots(
  trace: readonly TaskPreflightMockTraceItem[],
  facts: TaskPathFacts,
  requirements: readonly AutomationTaskToolRequirement[]
): { roots: string[]; unscopedTools: string[] } {
  const shellWorkingDirectories = [...new Set(requirements.flatMap((permission) => permission.tool === 'run_shell' ? [permission.workingDirectory] : []))]
  const workDir = shellWorkingDirectories.length > 1 ? undefined : shellWorkingDirectories[0] ?? facts.roots[0]
  const roots = new Set<string>()
  const unscopedTools = new Set<string>()
  for (const item of trace) {
    if (!DIRECTORY_SCOPED_FILE_TOOLS.has(item.toolName) || (item.dispatch !== 'simulated' && item.dispatch !== 'not-dispatched')) continue
    if (fileToolCallWithinApprovedScope(item, facts, workDir)) continue
    const root = fileToolAuthorizationRoot(item, facts, workDir)
    if (root) roots.add(root)
    else unscopedTools.add(item.toolName)
  }
  return { roots: [...roots].sort(), unscopedTools: [...unscopedTools].sort() }
}

function traceToolHasVerifiedPermissionScope(
  item: TaskPreflightMockTraceItem,
  facts: TaskPathFacts,
  requirements: readonly AutomationTaskToolRequirement[],
  additionalRoots: readonly string[] = []
): boolean {
  if (item.dispatch !== 'simulated' && item.dispatch !== 'not-dispatched') return false
  if (item.toolName === 'run_shell' || item.toolName === 'grep' || item.toolName === 'run_script' || item.toolName.startsWith('mcp_')) return true
  if (item.toolName === 'tool_search') return true // Searches only the host-provided MCP snapshot.
  if (item.toolName === 'toolkit.find' || item.toolName === 'toolkit_find') return true // Searches the host capability catalog; it cannot call a capability.
  const shellWorkingDirectories = [...new Set(requirements.flatMap((permission) => permission.tool === 'run_shell' ? [permission.workingDirectory] : []))]
  const workDir = shellWorkingDirectories.length > 1 ? undefined : shellWorkingDirectories[0] ?? facts.roots[0]
  return fileToolCallWithinApprovedScope(item, facts, workDir, additionalRoots)
}

function unsupportedTraceToolName(trace: readonly TaskPreflightMockTraceItem[]): string | undefined {
  const recognized = new Set([
    'run_shell', 'grep', 'run_script', 'read_file', 'list_directory', 'write_file', 'edit_file',
    'tool_search', 'toolkit.find', 'toolkit_find'
  ])
  return trace.find((item) => (item.dispatch === 'simulated' || item.dispatch === 'not-dispatched')
    && !recognized.has(item.toolName) && !item.toolName.startsWith('mcp_'))?.toolName
}

function safeToolName(value: string | undefined): string {
  return value && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : '未知工具'
}

function partialCoverageTargetBlockReason(target: ProposedTaskTarget, facts: TaskPathFacts): string | undefined {
  if (target.kind === 'output') return facts.outputRoot ? undefined : 'output_root_unavailable'
  if (target.kind === 'exact') {
    if (path.isAbsolute(target.path)) {
      const exactPath = path.normalize(target.path)
      if (!isCanonicalAbsolutePath(target.path)) return 'target_path_not_canonical'
      if (!facts.roots.some((root) => isWithinRoot(exactPath, root))) return 'target_outside_authorized_roots'
      return facts.entries.some((entry) => entry.path === exactPath && entry.kind === target.targetType)
        || facts.proposedPathCandidates?.some((candidate) => candidate.path === exactPath && candidate.kind === target.targetType) === true
        ? undefined
        : 'direct_target_fact_missing'
    }
    const isRelativePath = target.path.includes('/') || target.path.includes('\\')
    if (!isRelativePath) return 'basename_needs_complete_scan'
    if (facts.roots.length !== 1) return 'relative_path_needs_single_root'
    const relativePath = path.posix.normalize(target.path.replace(/\\/g, '/'))
    if (path.posix.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) return 'relative_target_escapes_root'
    const exactPath = path.resolve(facts.roots[0]!, relativePath)
    if (!isWithinRoot(exactPath, facts.roots[0]!)) return 'target_outside_authorized_roots'
    return facts.entries.some((entry) => entry.path === exactPath && entry.kind === target.targetType)
      || facts.proposedPathCandidates?.some((candidate) => candidate.path === exactPath && candidate.kind === target.targetType) === true
      ? undefined
      : 'direct_target_fact_missing'
  }
  const directory = path.normalize(target.directory)
  if (!isCanonicalAbsolutePath(target.directory)) return 'collection_path_not_canonical'
  if (!facts.roots.some((root) => isWithinRoot(directory, root))) return 'target_outside_authorized_roots'
  return isVerifiedDirectory(directory, facts) ? undefined : 'collection_directory_fact_missing'
}

function proposedTracePaths(
  trace: readonly TaskPreflightMockTraceItem[],
  targets: readonly ProposedTaskTarget[],
  prompt: string,
  facts: TaskPathFacts
): string[] {
  const paths = new Set<string>()
  const knownRoots = [...facts.roots, ...(facts.outputRoot ? [facts.outputRoot] : [])]
  const promptNamesPath = (value: string): boolean => {
    let candidate = value
    while (candidate !== path.dirname(candidate)) {
      if (prompt.includes(candidate)) return true
      candidate = path.dirname(candidate)
    }
    return false
  }
  const add = (value: unknown, includeParent: boolean) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) return
    const isKnown = knownRoots.some((root) => isWithinRoot(value, root))
    // Out-of-scope paths are inspected only when the task literally names that path or one of
    // its parent directories. The model supplies the structured path; the host does not parse prose.
    if (!isKnown && !promptNamesPath(value)) return
    paths.add(value)
    if (includeParent && path.dirname(value) !== value) paths.add(path.dirname(value))
  }
  for (const target of targets) {
    if (target.kind === 'exact') add(target.path, target.targetType === 'file')
    else if (target.kind === 'collection') add(target.directory, false)
  }
  const shellWorkingDirectories = [...new Set(trace.flatMap((item) => {
    if (item.toolName !== 'run_shell') return []
    const value = item.input && typeof item.input === 'object' && !Array.isArray(item.input)
      ? (item.input as Record<string, unknown>).workingDirectory
      : undefined
    return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value ? [value] : []
  }))]
  const fileToolWorkDir = shellWorkingDirectories.length === 1 ? shellWorkingDirectories[0] : facts.roots[0]
  for (const item of trace) {
    if (item.dispatch !== 'simulated' && item.dispatch !== 'not-dispatched') continue
    const args = item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? item.input as Record<string, unknown> : {}
    if (item.toolName === 'run_shell') add(args.workingDirectory, false)
    else if (item.toolName === 'grep') add(args.path, true)
    else if (DIRECTORY_SCOPED_FILE_TOOLS.has(item.toolName)) {
      const rawPath = item.toolName === 'list_directory' && args.path === undefined ? '.' : args.path
      if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) continue
      const base = item.toolName === 'write_file' ? fileToolWorkDir ?? facts.outputRoot : fileToolWorkDir
      if (!path.isAbsolute(rawPath) && !base) continue
      const resolvedPath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(base!, rawPath))
      if (path.isAbsolute(resolvedPath) && path.normalize(resolvedPath) === resolvedPath) {
        add(resolvedPath, item.toolName !== 'list_directory')
      }
    }
    else if (item.toolName === 'run_script') {
      const code = typeof args.code === 'string' ? args.code : ''
      const language = typeof args.language === 'string' ? args.language : 'python'
      for (const scriptPath of extractScriptPathFacts(code, language).paths) add(scriptPath, true)
    }
  }
  return [...paths].slice(0, 32)
}

function projectClarificationIssues(input: {
  prompt: string
  analysis: TaskPreflightAnalysisOutput
  facts: TaskPathFacts
  requiredPermissions: readonly AutomationTaskToolRequirement[]
  outputRootReadRequested: boolean
  outputRootAlreadyReadAuthorized: boolean
}): {
  issues: PreflightIssue[]
  outputRootGitReferences: Set<string>
  outputRootGitReadIsAuthorized: boolean
  clarificationIsSatisfiedByOutputRootFacts: (clarification: TaskPreflightClarification) => boolean
  unresolvedClarificationCount: number
} {
  const { prompt, analysis, facts, requiredPermissions, outputRootReadRequested, outputRootAlreadyReadAuthorized } = input
  // facts/policy: when the user named the selected output directory as task input and it is a
  // verified Git root, a generic model location clarification is an access gap even if the
  // Mock rehearsal failed to record a tool call. This never grants access; without a recorded
  // tool call the result remains blocked because there is no complete permission manifest.
  // Never suppress ambiguity or unrelated capability errors with this fallback.
  const explicitOutputRootRead = Boolean(facts.outputRootIsGitRepository
    && facts.outputRoot
    && prompt.includes(facts.outputRoot))
  const explicitTaskDirectories = (facts.proposedPathCandidates ?? [])
    .filter((candidate) => candidate.kind === 'directory' && prompt.includes(candidate.path))
  const uniqueExplicitTaskDirectory = explicitTaskDirectories.length === 1 ? explicitTaskDirectories[0] : undefined
  const clarifications = (analysis.clarifications ?? []).map((clarification) => {
    if (explicitOutputRootRead
      && prompt.includes(clarification.reference)
      && ['no_target_identified', 'scope_unclear', 'missing_location', 'target_missing', 'git_repository_not_found'].includes(clarification.reasonCode)) {
      return { ...clarification, reasonCode: 'output_root_not_read_authorized' as const }
    }
    if (uniqueExplicitTaskDirectory
      && prompt.includes(clarification.reference)
      && ['no_target_identified', 'scope_unclear', 'missing_location', 'target_missing', 'git_repository_not_found'].includes(clarification.reasonCode)) {
      // A verified explicit path resolves the location question. If the rehearsal has no tool
      // calls, keep the task blocked as missing permission details rather than asking for a path
      // the user already supplied. With recorded calls, those calls provide the reviewable scope.
      if (requiredPermissions.length > 0) return undefined
      return { ...clarification, reasonCode: 'capability_not_authorized' as const }
    }
    return clarification
  }).filter((clarification): clarification is NonNullable<typeof clarification> => Boolean(clarification))
  const outputRootGitReferences = new Set(clarifications
    .filter((clarification) => facts.outputRootIsGitRepository
      && ['git_repository_not_found', 'output_root_not_read_authorized'].includes(clarification.reasonCode)
      && prompt.includes(clarification.reference))
    .map((clarification) => clarification.reference))
  const outputRootGitReadIsAuthorized = Boolean(facts.outputRootIsGitRepository
    && outputRootAlreadyReadAuthorized
    && (outputRootReadRequested || explicitOutputRootRead))
  const clarificationIsSatisfiedByOutputRootFacts = (clarification: TaskPreflightClarification): boolean => {
    if (!prompt.includes(clarification.reference) || !outputRootGitReferences.has(clarification.reference)) return false
    if (facts.outputRootIsGitRepository && clarification.reasonCode === 'target_missing') return true
    return outputRootGitReadIsAuthorized
      && ['git_repository_not_found', 'output_root_not_read_authorized'].includes(clarification.reasonCode)
  }
  const relevantClarifications = clarifications
    .filter((clarification) => prompt.includes(clarification.reference))
    .filter((clarification) => !clarificationIsSatisfiedByOutputRootFacts(clarification))
    .filter((clarification) => !(clarification.reasonCode === 'capability_not_authorized' && requiredPermissions.length > 0))
  const gitRepositoryMissingReferences = new Set(relevantClarifications
    .filter((clarification) => clarification.reasonCode === 'git_repository_not_found')
    .map((clarification) => clarification.reference))
  const concreteTargetIssueReferences = new Set(clarifications
    .filter((clarification) => prompt.includes(clarification.reference)
      && ['target_missing', 'git_repository_not_found', 'multiple_matches'].includes(clarification.reasonCode))
    .map((clarification) => clarification.reference))
  const unresolvedClarifications = relevantClarifications.filter((clarification) => {
    if (clarification.reasonCode === 'target_missing' && gitRepositoryMissingReferences.has(clarification.reference)) return false
    if (['missing_location', 'no_target_identified', 'scope_unclear'].includes(clarification.reasonCode)
      && concreteTargetIssueReferences.has(clarification.reference)) return false
    return true
  })
  const projectedClarifications = unresolvedClarifications.slice(0, 5)
  const factPaths = new Set(facts.entries.map((entry) => entry.path))
  const issues = projectedClarifications.map((clarification) => {
    const outputRootReadAuthorizationNeeded = facts.outputRootIsGitRepository
      && ['git_repository_not_found', 'output_root_not_read_authorized'].includes(clarification.reasonCode)
    const effectiveReasonCode = outputRootReadAuthorizationNeeded ? 'output_root_not_read_authorized' : clarification.reasonCode
    const modelCandidates = [...new Set((clarification.candidates ?? []).filter((candidate) => factPaths.has(candidate)))]
    const inferredCandidates = clarification.reasonCode === 'multiple_matches'
      ? facts.entries.filter((entry) => ['file', 'directory'].includes(entry.kind) && clarification.reference.includes(path.basename(entry.path))).map((entry) => entry.path)
      : []
    const allCandidates = outputRootReadAuthorizationNeeded && facts.outputRoot
      ? [facts.outputRoot]
      : modelCandidates.length > 1 ? modelCandidates : inferredCandidates
    const candidates = [...new Set(allCandidates)].slice(0, 20)
    const reasonCode = clarification.reasonCode === 'multiple_matches' && candidates.length < 2 ? 'other' : clarification.reasonCode
    const finalReasonCode = outputRootReadAuthorizationNeeded ? effectiveReasonCode : reasonCode
    const code = finalReasonCode === 'multiple_matches' ? 'TARGET_AMBIGUOUS'
      : finalReasonCode === 'target_missing' || finalReasonCode === 'git_repository_not_found' ? 'TARGET_NOT_FOUND'
        : finalReasonCode === 'capability_not_authorized' ? 'TOOL_PERMISSION_DETAILS_MISSING'
        : finalReasonCode === 'output_root_not_read_authorized' ? (requiredPermissions.length ? 'TOOL_PERMISSION_REQUIRED' : 'TOOL_PERMISSION_DETAILS_MISSING')
          : 'TARGET_UNCLEAR'
    return issue(code, 'prompt', {
      reference: clarification.reference,
      reasonCode: finalReasonCode,
      ...(candidates.length ? { candidates, candidateCount: allCandidates.length } : {})
    })
  })
  const unresolvedClarificationCount = unresolvedClarifications.length
  return { issues, outputRootGitReferences, outputRootGitReadIsAuthorized, clarificationIsSatisfiedByOutputRootFacts, unresolvedClarificationCount }
}

function requestsReadAccessToOutputGitRepository(
  permissions: readonly AutomationTaskToolRequirement[],
  facts: TaskPathFacts
): boolean {
  if (!facts.outputRoot || !facts.outputRootIsGitRepository) return false
  return permissions.some((permission) => permission.tool === 'run_shell'
    ? permission.workingDirectory === facts.outputRoot
    : (permission.tool === 'grep' || permission.tool === 'run_script') && permission.scopeRoots.includes(facts.outputRoot!))
}

function permissionContinuationBlockers(permissionIssue: PreflightIssue, clarifications: readonly PreflightIssue[]): PreflightIssue[] {
  const unresolvedTaskIssues = clarifications.filter((item) => item.code !== 'TOOL_PERMISSION_REQUIRED')
  if (unresolvedTaskIssues.length) return unresolvedTaskIssues
  return clarifications.length ? [...clarifications] : [permissionIssue]
}

function areRequirementsInScope(
  requirements: readonly AutomationTaskToolRequirement[],
  facts: TaskPathFacts,
  authorizedRoots: readonly string[],
  mcpTools: readonly AutomationTaskMcpToolCandidate[]
): boolean {
  return requirements.every((permission) => permission.tool === 'mcp'
    ? mcpTools.some((candidate) => candidate.serverId === permission.serverId && candidate.toolName === permission.toolName
      && /^[a-f0-9]{64}$/.test(candidate.descriptorHash) && /^[a-f0-9]{64}$/.test(candidate.profileHash))
    : permission.tool === 'run_shell'
      ? authorizedRoots.some((root) => isWithinRoot(permission.workingDirectory, root)) && isVerifiedDirectory(permission.workingDirectory, facts)
      : permission.scopeRoots.every((root) => authorizedRoots.some((authorizedRoot) => isWithinRoot(root, authorizedRoot))
        && isVerifiedDirectory(root, facts)))
}

function factsWithProposedRoots(facts: TaskPathFacts, roots: readonly string[]): TaskPathFacts {
  const authorizedRoots = [...new Set([...facts.roots, ...roots])].sort()
  const addedRoot = roots.some((root) => !facts.roots.some((existing) => isWithinRoot(root, existing)))
  const entries = new Map(facts.entries.map((entry) => [entry.path, entry]))
  if (facts.outputRoot && roots.includes(facts.outputRoot) && !entries.has(facts.outputRoot)) {
    entries.set(facts.outputRoot, { path: facts.outputRoot, relativePath: '', kind: 'directory' })
  }
  for (const candidate of facts.proposedPathCandidates ?? []) {
    if (candidate.kind !== 'file' && candidate.kind !== 'directory') continue
    const root = [...authorizedRoots].sort((a, b) => b.length - a.length).find((item) => isWithinRoot(candidate.path, item))
    if (!root) continue
    entries.set(candidate.path, {
      path: candidate.path,
      relativePath: path.relative(root, candidate.path).split(path.sep).join('/'),
      kind: candidate.kind
    })
  }
  return {
    ...facts,
    roots: authorizedRoots,
    entries: [...entries.values()],
    ...(addedRoot ? { coverage: { ...facts.coverage, complete: false, truncated: true, roots: authorizedRoots.length } } : {})
  }
}

function classifyAnalyzerFailure(error: unknown): 'ANALYZER_TIMEOUT' | 'ANALYZER_SUMMARY_TIMEOUT' | 'ANALYZER_INVALID_RESPONSE' | 'ANALYZER_OUTPUT_TRUNCATED' | 'ANALYZER_UNAVAILABLE' {
  const code = error instanceof Error ? error.message : ''
  if (code === 'PREFLIGHT_TIMEOUT') return 'ANALYZER_TIMEOUT'
  if (code === 'PREFLIGHT_MODEL_SUMMARY_TIMEOUT') return 'ANALYZER_SUMMARY_TIMEOUT'
  if (code === 'PREFLIGHT_MODEL_TRUNCATED_RESPONSE') return 'ANALYZER_OUTPUT_TRUNCATED'
  if (code === 'PREFLIGHT_MODEL_EMPTY_RESPONSE' || code === 'PREFLIGHT_MODEL_INVALID_JSON' || code === 'PREFLIGHT_MODEL_INVALID_SCHEMA') return 'ANALYZER_INVALID_RESPONSE'
  return 'ANALYZER_UNAVAILABLE'
}

function validateAnalysis(value: unknown): TaskPreflightAnalysisOutput | undefined {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { targets?: unknown }).targets)) return undefined
  const targets = (value as { targets: unknown[] }).targets
  for (const target of targets) {
    if (!target || typeof target !== 'object') return undefined
    const record = target as Record<string, unknown>
    if (record.kind === 'exact' && typeof record.path === 'string' && ['file', 'directory'].includes(String(record.targetType))) continue
    if (record.kind === 'collection' && typeof record.directory === 'string' && ['*.csv', '*.tsv', 'all'].includes(String(record.selector))) continue
    if (record.kind === 'output' && typeof record.path === 'string' && ['file', 'directory'].includes(String(record.expectedType))) continue
    return undefined
  }
  // Old tool-name-only requests have no safe parameter scope and cannot be upgraded into grants.
  if ('requiredTools' in value && Array.isArray((value as { requiredTools?: unknown }).requiredTools) && (value as { requiredTools: unknown[] }).requiredTools.length > 0) return undefined
  const clarifications = (value as { clarifications?: unknown }).clarifications
  const allowedReasons = new Set(['no_target_identified', 'scope_unclear', 'missing_location', 'multiple_matches', 'target_missing', 'git_repository_not_found', 'output_root_not_read_authorized', 'capability_not_authorized', 'other'])
  if (clarifications !== undefined && (!Array.isArray(clarifications) || clarifications.some((item) => {
    if (!item || typeof item !== 'object') return true
    const clarification = item as Record<string, unknown>
    return typeof clarification.reference !== 'string' || !clarification.reference.trim() || clarification.reference.length > 240 || !allowedReasons.has(String(clarification.reasonCode)) || (clarification.candidates !== undefined && (!Array.isArray(clarification.candidates) || clarification.candidates.length > 50 || clarification.candidates.some((candidate) => typeof candidate !== 'string' || candidate.length > 2048)))
  }))) return undefined
  const suggestedDirectories = (value as { suggestedDirectories?: unknown }).suggestedDirectories
  if (suggestedDirectories !== undefined && (!Array.isArray(suggestedDirectories) || suggestedDirectories.some((item) => !item || typeof item !== 'object' || typeof (item as Record<string, unknown>).path !== 'string' || typeof (item as Record<string, unknown>).purpose !== 'string' || typeof (item as Record<string, unknown>).source !== 'string'))) return undefined
  const mockTrace = (value as { mockTrace?: unknown }).mockTrace
  if (mockTrace !== undefined && (!Array.isArray(mockTrace) || mockTrace.length > MAX_TASK_PREFLIGHT_TRACE_ITEMS || mockTrace.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true
    const trace = item as Record<string, unknown>
    return trace.kind !== 'proposed-tool-call' || typeof trace.toolName !== 'string' || !trace.toolName
      || !['simulated', 'blocked', 'not-dispatched'].includes(String(trace.dispatch))
      || (trace.resultKind !== undefined && !['synthetic', 'unavailable'].includes(String(trace.resultKind)))
      || !('input' in trace)
  }))) return undefined
  if ((value as { mockIncomplete?: unknown }).mockIncomplete !== undefined && typeof (value as { mockIncomplete?: unknown }).mockIncomplete !== 'boolean') return undefined
  if ((value as { mockIncompleteReason?: unknown }).mockIncompleteReason !== undefined && typeof (value as { mockIncompleteReason?: unknown }).mockIncompleteReason !== 'string') return undefined
  const normalized = { ...(value as TaskPreflightAnalysisOutput) }
  // final-check: requiredPermissions is a host projection, never accepted from a model or IPC override.
  delete normalized.requiredPermissions
  if (mockTrace) normalized.mockTrace = mockTrace as TaskPreflightMockTraceItem[]
  return normalized
}

async function withTimeout<T>(promise: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('PREFLIGHT_TIMEOUT')) }, timeoutMs)
  })
  try { return await Promise.race([promise(controller.signal), timeout]) }
  finally { if (timer) clearTimeout(timer) }
}

export async function runTaskPreflight(input: TaskPreflightInput, deps: TaskPreflightDependencies): Promise<TaskPreflightResult> {
  const totalBudgetMs = deps.timeoutMs ?? DEFAULT_ANALYZER_TIMEOUT_MS
  const startedAt = input.preflightStartedAt ?? Date.now()
  const remainingBudgetMs = () => totalBudgetMs - (Date.now() - startedAt)
  let facts: TaskPathFacts
  try {
    facts = await withTimeout(
      () => (deps.factsProvider ?? new TaskPathFactsProvider()).collect(input.roots, input.outputDir),
      Math.max(1, remainingBudgetMs())
    )
  } catch (error) {
    return error instanceof Error && error.message === 'PREFLIGHT_TIMEOUT'
      ? { report: emptyReport('unavailable', [issue('ANALYZER_TIMEOUT')]), bindings: [] }
      : { report: emptyReport('blocked', [issue('ROOT_FACTS_UNAVAILABLE', 'workDirs')]), bindings: [] }
  }
  // facts: pass partial coverage through to the analyzer; target resolution below decides whether
  // each requested object is directly verifiable or needs exhaustive discovery to rule out ambiguity.
  const remaining = remainingBudgetMs()
  if (remaining <= 0) return { report: emptyReport('unavailable', [issue('ANALYZER_TIMEOUT')]), bindings: [], factsDigest: facts.digest }
  let analysis: TaskPreflightAnalysisOutput | undefined
  if (input.analysisOverride) {
    analysis = validateAnalysis(input.analysisOverride)
  } else {
    try {
      analysis = validateAnalysis(await withTimeout((signal) => deps.analyzer.analyze({
        prompt: input.prompt,
        scheduleSummary: input.scheduleSummary,
        deliverySummary: input.deliverySummary,
        authorizedRoots: facts.roots,
        outputRoot: facts.outputRoot,
        facts,
        tools: input.tools ?? [],
        remainingBudgetMs: Math.max(1, Math.min(DEFAULT_ANALYZER_TIMEOUT_MS, remaining - 10)),
        mcpTools: (input.mcpTools ?? []).map(({ serverId, serverName, toolName, description, parameters, mappedName }) => ({ serverId, serverName, toolName, description: description.slice(0, 600), parameters, ...(mappedName ? { mappedName } : {}) })),
        responseFormat: 'json'
      }, signal), remaining))
    } catch (error) {
      return { report: emptyReport('unavailable', [issue(classifyAnalyzerFailure(error))]), bindings: [], factsDigest: facts.digest }
    }
  }
  if (!analysis) {
    if (process.env.SPACEASSISTANT_DEV === '1') console.warn('[taskPreflight] result rejected', { phase: 'host-schema-validation', reason: 'invalid-analysis-shape' })
    return { report: emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]), bindings: [], factsDigest: facts.digest }
  }
  const factsProvider = deps.factsProvider ?? new TaskPathFactsProvider()
  const tracePaths = proposedTracePaths(analysis.mockTrace ?? [], analysis.targets, input.prompt, facts)
  if (tracePaths.length && factsProvider.inspectPaths) {
    try {
      const proposedPathCandidates = await withTimeout(
        () => factsProvider.inspectPaths!(tracePaths),
        Math.max(1, remainingBudgetMs())
      )
      facts = {
        ...facts,
        proposedPathCandidates,
        digest: createHash('sha256').update(JSON.stringify({ baseDigest: facts.digest, proposedPathCandidates })).digest('hex')
      }
    } catch (error) {
      return error instanceof Error && error.message === 'PREFLIGHT_TIMEOUT'
        ? { report: emptyReport('unavailable', [issue('ANALYZER_TIMEOUT')]), bindings: [], factsDigest: facts.digest }
        : { report: emptyReport('blocked', [issue('ROOT_FACTS_UNAVAILABLE', 'workDirs')]), bindings: [], factsDigest: facts.digest }
    }
  }
  if (analysis.mockIncomplete) {
    // policy: a host budget stops only the mock sampling stage. A valid independent summary
    // of its recorded trace can still be reviewed; the partial coverage is carried to UI/audit.
    // Invalid model output, missing mock adapters, or failed mock results remain fail-closed.
    if (!analysis.mockIncompleteReason || !BUDGET_STOP_REASONS.has(analysis.mockIncompleteReason)) {
      const unavailableTool = analysis.mockIncompleteReason === 'mock_adapter_unavailable'
        ? [...(analysis.mockTrace ?? [])].reverse().find((item) => item.dispatch === 'blocked')?.toolName
        : undefined
      const safeUnavailableToolName = unavailableTool && /^[A-Za-z0-9_.:-]{1,80}$/.test(unavailableTool)
        ? unavailableTool
        : '未知工具'
      if (process.env.SPACEASSISTANT_DEV === '1') {
        const reason = analysis.mockIncompleteReason
        console.warn('[taskPreflight] mock rehearsal rejected', {
          phase: 'mock-runner-validation',
          reason: reason && /^[A-Za-z0-9_.-]{1,80}$/.test(reason) ? reason : 'unknown',
          ...(unavailableTool ? { unavailableTool: safeUnavailableToolName } : {}),
          traceItems: analysis.mockTrace?.length ?? 0
        })
      }
      return {
        report: emptyReport('blocked', [issue(
          analysis.mockIncompleteReason === 'mock_adapter_unavailable' ? 'MOCK_TOOL_UNAVAILABLE' : 'MOCK_PREFLIGHT_INCOMPLETE',
          'prompt',
          analysis.mockIncompleteReason === 'mock_adapter_unavailable' ? { messageParams: { toolName: safeUnavailableToolName } } : {}
        )]),
        bindings: [], factsDigest: facts.digest,
        ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
      }
    }
  }
  let requiredPermissions: AutomationTaskToolRequirement[]
  try {
    requiredPermissions = deriveTaskPreflightPermissions({
      trace: analysis.mockTrace ?? [], facts, mcpTools: input.mcpTools ?? []
    })
    analysis = { ...analysis, requiredPermissions }
  } catch (error) {
    if (process.env.SPACEASSISTANT_DEV === '1') {
      const reason = error instanceof Error && /^PREFLIGHT_TRACE_[A-Z0-9_]{1,64}$/.test(error.message) ? error.message : 'permission-derivation-failed'
      console.warn('[taskPreflight] trace permission derivation rejected', { reason, traceItems: analysis.mockTrace?.length ?? 0 })
    }
    const missingShellScope = error instanceof Error && error.message === 'PREFLIGHT_TRACE_WORKING_DIRECTORY_UNAVAILABLE'
    const scopeRelatedClarifications = missingShellScope ? projectClarificationIssues({
      prompt: input.prompt,
      analysis,
      facts,
      requiredPermissions: [],
      outputRootReadRequested: false,
      outputRootAlreadyReadAuthorized: Boolean(facts.outputRoot && facts.roots.some((root) => isWithinRoot(facts.outputRoot!, root)))
    }).issues.filter((item) => item.code !== 'TOOL_PERMISSION_DETAILS_MISSING') : []
    return {
      report: missingShellScope
        ? emptyReport('blocked', scopeRelatedClarifications.length ? scopeRelatedClarifications : [issue('TOOL_PERMISSION_SCOPE_UNVERIFIED', 'workDirs')])
        : emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]),
      bindings: [], factsDigest: facts.digest,
      ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
    }
  }
  // facts: 本机工具授权必须落在用户选择并由主机核验的目录范围；结果输出根不能充当读取/命令范围。
  const filesystemPermissions = requiredPermissions.filter((permission) => permission.tool !== 'mcp')
  const fileToolScopes = deriveFileToolAuthorizationRoots(analysis.mockTrace ?? [], facts, requiredPermissions)
  const outputRootReadRequested = requestsReadAccessToOutputGitRepository(requiredPermissions, facts)
  const outputRootAlreadyReadAuthorized = Boolean(facts.outputRoot && facts.roots.some((root) => isWithinRoot(facts.outputRoot!, root)))
  const clarificationProjection = projectClarificationIssues({
    prompt: input.prompt,
    analysis,
    facts,
    requiredPermissions,
    outputRootReadRequested,
    outputRootAlreadyReadAuthorized
  })
  const { issues: clarificationIssues, outputRootGitReferences, outputRootGitReadIsAuthorized, clarificationIsSatisfiedByOutputRootFacts, unresolvedClarificationCount } = clarificationProjection
  const candidateMcpTools = input.mcpTools ?? []
  const requirementsInScope = areRequirementsInScope(requiredPermissions, facts, facts.roots, candidateMcpTools)
  const requestedRoots = [...new Set([
    ...rootsNeedingAuthorization(filesystemPermissions, facts),
    ...fileToolScopes.roots,
    ...deriveTargetAuthorizationRoots(analysis.targets, facts),
    ...(outputRootReadRequested && facts.outputRoot && !outputRootAlreadyReadAuthorized ? [facts.outputRoot] : [])
  ])].filter((root) => !facts.roots.some((authorizedRoot) => isWithinRoot(root, authorizedRoot))).sort()
  const proposedFacts = factsWithProposedRoots(facts, requestedRoots)
  const unresolvedTraceTools = (analysis.mockTrace ?? []).filter((item) => !traceToolHasVerifiedPermissionScope(
    item, facts, requiredPermissions, requestedRoots.filter((root) => isVerifiedDirectory(root, facts))
  ))
  if (requestedRoots.length > 0) {
    const reference = input.prompt.trim().slice(0, 240)
    const outputRootNeedsReadPermission = Boolean(outputRootReadRequested && facts.outputRoot && requestedRoots.includes(facts.outputRoot))
    const permissionIssue = issue('TOOL_PERMISSION_REQUIRED', 'workDirs', {
      reference,
      ...(outputRootNeedsReadPermission ? { reasonCode: 'output_root_not_read_authorized' } : {}),
      candidates: requestedRoots,
      candidateCount: requestedRoots.length
    })
    const blockers = permissionContinuationBlockers(permissionIssue, clarificationIssues)
    const proposalsAreVerified = requestedRoots.every((root) => isCanonicalAbsolutePath(root) && isVerifiedDirectory(root, facts))
    const proposedRequirementsInScope = areRequirementsInScope(requiredPermissions, proposedFacts, proposedFacts.roots, candidateMcpTools)
    const proposedTargetsResolve = analysis.targets.every((target) => resolveTaskTarget({
      rawText: input.prompt,
      target,
      roots: proposedFacts.roots,
      outputRoot: proposedFacts.outputRoot,
      facts: proposedFacts,
      taskRevision: input.taskRevision
    }).ok)
    const unsupportedTool = unsupportedTraceToolName(analysis.mockTrace ?? [])
    const canContinueToPermissionReview = blockers.every((item) => item.code === 'TOOL_PERMISSION_REQUIRED')
      && proposalsAreVerified
      && proposedRequirementsInScope
      && proposedTargetsResolve
      && unresolvedTraceTools.length === 0
      && !unsupportedTool
    const fallbackBlockers = blockers.filter((item) => item.code !== 'TOOL_PERMISSION_REQUIRED')
    const notReviewableBlockers = fallbackBlockers.length ? fallbackBlockers
      : unsupportedTool ? [issue('TOOL_PERMISSION_UNSUPPORTED', 'prompt', { messageParams: { toolName: safeToolName(unsupportedTool) } })]
        : !proposalsAreVerified || !proposedRequirementsInScope || fileToolScopes.unscopedTools.length > 0
          ? [issue('TOOL_PERMISSION_SCOPE_UNVERIFIED', 'workDirs')]
          : analysis.targets.flatMap((target) => {
            const resolved = resolveTaskTarget({ rawText: input.prompt, target, roots: proposedFacts.roots, outputRoot: proposedFacts.outputRoot, facts: proposedFacts, taskRevision: input.taskRevision })
            return resolved.ok ? [] : [issue(resolved.issue.code, resolved.issue.field, resolved.issue)]
          })
    const reportBlockers = canContinueToPermissionReview ? blockers : notReviewableBlockers.length ? notReviewableBlockers : [issue('TOOL_PERMISSION_SCOPE_UNVERIFIED', 'workDirs')]
    const suggestedDirectories: SuggestedDirectory[] = (proposalsAreVerified ? requestedRoots : []).map((candidate) => ({
      path: candidate,
      ...(outputRootNeedsReadPermission && candidate === facts.outputRoot
        ? { purposeKey: 'butler.preflight.output_root_read_candidate_purpose' }
        : {}),
      source: reference,
      validationStatus: 'valid'
    }))
    const report = withPermissionNeeds(withAnalysisCoverage(emptyReport('blocked', reportBlockers, suggestedDirectories), analysis),
      requiredPermissions, input.mcpTools, proposalsAreVerified ? requestedRoots : [])
    if (process.env.SPACEASSISTANT_DEV === '1') {
      console.warn('[taskPreflight] authorization scopes requested', {
        phase: input.analysisOverride ? 'final-confirmation' : 'initial-preflight',
        candidateCount: requestedRoots.length,
        scopeSources: [...new Set([
          ...(rootsNeedingAuthorization(filesystemPermissions, facts).length ? ['permission-requirement'] : []),
          ...(fileToolScopes.roots.length ? ['file-tool-path'] : []),
          ...(deriveTargetAuthorizationRoots(analysis.targets, facts).length ? ['target-path'] : []),
          ...(outputRootNeedsReadPermission ? ['output-root-read'] : [])
        ])],
        verified: proposalsAreVerified,
        targetsResolvable: proposedTargetsResolve,
        requirementsInScope: proposedRequirementsInScope,
        unscopedTools: unresolvedTraceTools.map((item) => item.toolName)
      })
    }
    return {
      report,
      bindings: [],
      factsDigest: facts.digest,
      requiredPermissions,
      ...(canContinueToPermissionReview ? { authorizationContinuation: { authorizedRoots: proposedFacts.roots, analysis } } : {}),
      ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
    }
  }
  const unsupportedTool = unsupportedTraceToolName(analysis.mockTrace ?? [])
  if (unsupportedTool) {
    return {
      report: emptyReport('blocked', [issue('TOOL_PERMISSION_UNSUPPORTED', 'prompt', { messageParams: { toolName: safeToolName(unsupportedTool) } })]),
      bindings: [], factsDigest: facts.digest,
      requiredPermissions,
      ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
    }
  }
  if (fileToolScopes.unscopedTools.length > 0) {
    return {
      report: emptyReport('blocked', [issue('TOOL_PERMISSION_SCOPE_UNVERIFIED', 'workDirs')]),
      bindings: [], factsDigest: facts.digest,
      requiredPermissions,
      ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
    }
  }
  if (!facts.coverage.complete) {
    const unscopedTraceTools = (analysis.mockTrace ?? []).filter((item) => !traceToolHasVerifiedPermissionScope(item, facts, requiredPermissions))
    const targetBlockReasons = analysis.targets
      .map((target) => partialCoverageTargetBlockReason(target, facts))
      .filter((reason): reason is string => Boolean(reason))
    const partialCoverageBlockReasons = [
      ...targetBlockReasons,
      ...(unresolvedClarificationCount > 0 ? ['unresolved_clarification'] : []),
      ...(unscopedTraceTools.length > 0 ? ['untracked_tool_in_mock_trace'] : []),
      ...(!requirementsInScope ? ['permission_scope_not_verified'] : [])
    ]
    if (partialCoverageBlockReasons.length > 0) {
      if (process.env.SPACEASSISTANT_DEV === '1') {
        const toolCategories = [...new Set((analysis.mockTrace ?? []).map((item) =>
          item.toolName === 'run_shell' || item.toolName === 'grep' || item.toolName === 'run_script'
            ? item.toolName
            : item.toolName.startsWith('mcp_') ? 'mcp' : 'other'))]
        console.warn('[taskPreflight] incomplete path facts blocked', {
          phase: input.analysisOverride ? 'final-confirmation' : 'initial-preflight',
          reasons: partialCoverageBlockReasons,
          coverage: { truncated: facts.coverage.truncated, errors: facts.coverage.errors, roots: facts.coverage.roots, visited: facts.coverage.visited },
          targetKinds: analysis.targets.map((target) => target.kind),
          unresolvedClarifications: unresolvedClarificationCount,
          unscopedTools: unscopedTraceTools.map((item) => /^[A-Za-z0-9_.:-]{1,80}$/.test(item.toolName) ? item.toolName : 'unknown'),
          toolCategories,
          requirementsInScope
        })
      }
      if (unresolvedClarificationCount > 0) {
        return { report: emptyReport('blocked', clarificationIssues), bindings: [], factsDigest: facts.digest }
      }
      if (targetBlockReasons.some((reason) => reason === 'target_outside_authorized_roots' || reason === 'relative_target_escapes_root')) {
        const outsideTargets = analysis.targets.filter((target) => {
          const reason = partialCoverageTargetBlockReason(target, facts)
          return reason === 'target_outside_authorized_roots' || reason === 'relative_target_escapes_root'
        })
        return {
          report: emptyReport('blocked', outsideTargets.slice(0, 5).map((target) => issue('TARGET_OUTSIDE_ROOTS', 'prompt', {
            reference: target.kind === 'exact' ? target.path : target.kind === 'collection' ? target.directory : target.path
          }))),
          bindings: [], factsDigest: facts.digest
        }
      }
      if (!requirementsInScope) return { report: emptyReport('blocked', [issue('TOOL_PERMISSION_SCOPE_UNVERIFIED', 'workDirs')]), bindings: [], factsDigest: facts.digest }
      return { report: emptyReport('blocked', [issue('FACTS_INCOMPLETE')]), bindings: [], factsDigest: facts.digest }
    }
  }
  if (!requirementsInScope) {
    if (process.env.SPACEASSISTANT_DEV === '1') {
      console.warn('[taskPreflight] result rejected', {
        phase: 'host-scope-validation',
        reason: outputRootReadRequested ? 'output-root-read-request' : 'permission-out-of-scope',
        permissionTools: [...new Set(requiredPermissions.map((permission) => permission.tool))].slice(0, 8)
      })
    }
    if (outputRootReadRequested && facts.outputRoot) {
      const reference = input.prompt.trim().slice(0, 240)
      const permissionIssue = issue('TOOL_PERMISSION_REQUIRED', 'workDirs', {
        reference,
        reasonCode: 'output_root_not_read_authorized',
        candidates: [facts.outputRoot],
        candidateCount: 1
      })
      const blockers = permissionContinuationBlockers(permissionIssue, clarificationIssues)
      return {
        report: withPermissionNeeds(withAnalysisCoverage(emptyReport('blocked', blockers, [{
          path: facts.outputRoot,
          purposeKey: 'butler.preflight.output_root_read_candidate_purpose',
          source: reference,
          validationStatus: 'valid'
        }]), analysis), requiredPermissions, input.mcpTools),
        bindings: [],
        factsDigest: facts.digest,
        requiredPermissions,
        ...(blockers.every((item) => item.code === 'TOOL_PERMISSION_REQUIRED') ? { authorizationContinuation: {
          authorizedRoots: [...new Set([...facts.roots, facts.outputRoot, ...rootsNeedingAuthorization(filesystemPermissions, facts)])].sort(),
          analysis
        } } : {}),
        ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
      }
    }
    const requestedRoots = rootsNeedingAuthorization(filesystemPermissions, facts)
    const requestedRootSet = new Set(requestedRoots)
    // policy: exact prompt paths enter this branch only after host metadata validation; they are
    // eligible to be shown for explicit authorization but do not become read roots here.
    const verifiedPromptDirectories = new Set((facts.proposedPathCandidates ?? [])
      .filter((candidate) => candidate.kind === 'directory').map((candidate) => candidate.path))
    const invalidInScopeRoots = permissionRoots(filesystemPermissions).filter((requestedRoot) => !requestedRootSet.has(requestedRoot)
      && !facts.entries.some((entry) => entry.path === requestedRoot && entry.kind === 'directory')
      && !verifiedPromptDirectories.has(requestedRoot))
    if (requestedRoots.length > 0 && invalidInScopeRoots.length === 0 && requestedRoots.every(isCanonicalAbsolutePath)) {
      const permissionIssue = issue('TOOL_PERMISSION_REQUIRED', 'workDirs')
      const blockers = permissionContinuationBlockers(permissionIssue, clarificationIssues)
      const report = withAnalysisCoverage(emptyReport('blocked', blockers), analysis)
      return {
        report: withPermissionNeeds(report, requiredPermissions, input.mcpTools),
        bindings: [], factsDigest: facts.digest, requiredPermissions,
        ...(blockers.every((item) => item.code === 'TOOL_PERMISSION_REQUIRED')
          ? { authorizationContinuation: { authorizedRoots: [...new Set([...facts.roots, ...requestedRoots])].sort(), analysis } }
          : {}),
        ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
      }
    }
    return { report: emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]), bindings: [], factsDigest: facts.digest }
  }
  // Facts/report 阶段只保留可核验的原文片段、原因代码和主机 facts 中的候选路径；模型文本不授予路径，也不改写执行授权。
  const explicitPromptDirectory = (facts.proposedPathCandidates ?? []).filter((candidate) =>
    candidate.kind === 'directory' && input.prompt.includes(candidate.path))
  if (analysis.targets.length === 0 && clarificationIssues.length === 0 && requiredPermissions.length === 0) {
    const reference = input.prompt.trim().slice(0, 240)
    if (explicitPromptDirectory.length === 1) {
      return {
        report: withAnalysisCoverage(emptyReport('blocked', [issue('TOOL_PERMISSION_DETAILS_MISSING', 'prompt', { reference })], [{
          path: explicitPromptDirectory[0]!.path,
          purposeKey: 'butler.preflight.explicit_prompt_path_candidate_purpose',
          source: reference,
          validationStatus: 'valid'
        }]), analysis),
        bindings: [],
        factsDigest: facts.digest
      }
    }
    return {
      report: withAnalysisCoverage(emptyReport('blocked', [issue('TARGET_UNCLEAR', 'prompt', { reference, reasonCode: 'no_target_identified' })]), analysis),
      bindings: [],
      factsDigest: facts.digest
    }
  }
  const bindings: TargetBinding[] = []
  const blockers: PreflightIssue[] = [...clarificationIssues]
  for (const target of analysis.targets) {
      const resolved = resolveTaskTarget({ rawText: input.prompt, target, roots: facts.roots, outputRoot: facts.outputRoot, facts, taskRevision: input.taskRevision })
    if (resolved.ok) bindings.push(resolved.binding)
    else {
      if (resolved.issue.code === 'FACTS_INCOMPLETE' && process.env.SPACEASSISTANT_DEV === '1') {
        console.warn('[taskPreflight] target resolution needs complete facts', {
          phase: input.analysisOverride ? 'final-confirmation' : 'initial-preflight',
          targetKind: target.kind,
          referenceKind: target.kind === 'exact'
            ? (path.isAbsolute(target.path) || target.path.includes('/') || target.path.includes('\\') ? 'path' : 'basename')
            : target.kind === 'collection' ? 'collection-directory' : 'output-path',
          coverage: { truncated: facts.coverage.truncated, errors: facts.coverage.errors, roots: facts.coverage.roots, visited: facts.coverage.visited }
        })
      }
      blockers.push(issue(resolved.issue.code, resolved.issue.field, resolved.issue))
    }
  }
  const suggestedDirectories: SuggestedDirectory[] = (analysis.suggestedDirectories ?? []).map((suggestion) => ({ ...suggestion, validationStatus: 'unavailable' }))
  const explicitPermissionDetailsMissing = requiredPermissions.length === 0
    && clarificationIssues.some((item) => item.code === 'TOOL_PERMISSION_DETAILS_MISSING')
  if (explicitPermissionDetailsMissing && explicitPromptDirectory.length === 1) {
    const candidate = explicitPromptDirectory[0]!
    if (!suggestedDirectories.some((suggestion) => suggestion.path === candidate.path)) {
      suggestedDirectories.push({
        path: candidate.path,
        purposeKey: 'butler.preflight.explicit_prompt_path_candidate_purpose',
        source: input.prompt.trim().slice(0, 240),
        validationStatus: 'valid'
      })
    }
  }
  if (outputRootGitReferences.size > 0 && facts.outputRoot) {
    const existingSuggestionIndex = suggestedDirectories.findIndex((suggestion) => suggestion.path === facts.outputRoot)
    const outputRootSuggestion: SuggestedDirectory = {
      path: facts.outputRoot,
      purposeKey: 'butler.preflight.output_root_read_candidate_purpose',
      source: [...outputRootGitReferences][0]!,
      validationStatus: 'valid'
    }
    if (existingSuggestionIndex >= 0) suggestedDirectories[existingSuggestionIndex] = outputRootSuggestion
    else suggestedDirectories.push(outputRootSuggestion)
  }
  return {
    report: withPermissionNeeds(withAnalysisCoverage(emptyReport(blockers.length ? 'blocked' : 'passed', blockers, suggestedDirectories), analysis), requiredPermissions, input.mcpTools),
    bindings: blockers.length ? [] : bindings,
    factsDigest: facts.digest,
    requiredPermissions,
    ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
  }
}
