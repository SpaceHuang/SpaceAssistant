import path from 'node:path'
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
export type TaskPreflightDependencies = { analyzer: TaskPreflightAnalyzer; factsProvider?: Pick<TaskPathFactsProvider, 'collect'>; timeoutMs?: number; now?: () => number }

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
  mcpTools: readonly AutomationTaskMcpToolCandidate[] = []
): PreflightReport {
  if (report.status !== 'blocked' || requirements.length === 0) return report

  const needs: AutomationTaskPermission[] = []
  const directoryPaths = [...new Set(requirements.flatMap((permission) => permission.tool === 'run_shell'
    ? [permission.workingDirectory]
    : permission.tool === 'grep' || permission.tool === 'run_script' ? permission.scopeRoots : []))]
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

function requestsReadAccessToOutputGitRepository(
  permissions: readonly AutomationTaskToolRequirement[],
  facts: TaskPathFacts
): boolean {
  if (!facts.outputRoot || !facts.outputRootIsGitRepository) return false
  return permissions.some((permission) => permission.tool === 'run_shell'
    ? permission.workingDirectory === facts.outputRoot
    : (permission.tool === 'grep' || permission.tool === 'run_script') && permission.scopeRoots.includes(facts.outputRoot!))
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
  if (!facts.coverage.complete) return { report: emptyReport('blocked', [issue('FACTS_INCOMPLETE')]), bindings: [], factsDigest: facts.digest }
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
  if (analysis.mockIncomplete) {
    // policy: a host budget stops only the mock sampling stage. A valid independent summary
    // of its recorded trace can still be reviewed; the partial coverage is carried to UI/audit.
    // Invalid model output, missing mock adapters, or failed mock results remain fail-closed.
    if (!analysis.mockIncompleteReason || !BUDGET_STOP_REASONS.has(analysis.mockIncompleteReason)) {
      if (process.env.SPACEASSISTANT_DEV === '1') {
        const reason = analysis.mockIncompleteReason
        console.warn('[taskPreflight] mock rehearsal rejected', {
          phase: 'mock-runner-validation',
          reason: reason && /^[A-Za-z0-9_.-]{1,80}$/.test(reason) ? reason : 'unknown',
          traceItems: analysis.mockTrace?.length ?? 0
        })
      }
      return {
        report: emptyReport('blocked', [issue('MOCK_PREFLIGHT_INCOMPLETE')]),
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
    return {
      report: emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]),
      bindings: [], factsDigest: facts.digest,
      ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
    }
  }
  // facts: 本机工具授权必须落在用户选择并由主机核验的目录范围；结果输出根不能充当读取/命令范围。
  const filesystemPermissions = requiredPermissions.filter((permission) => permission.tool !== 'mcp')
  const outputRootReadRequested = requestsReadAccessToOutputGitRepository(requiredPermissions, facts)
  const outputRootAlreadyReadAuthorized = Boolean(facts.outputRoot && facts.roots.some((root) => isWithinRoot(facts.outputRoot!, root)))
  if (filesystemPermissions.length > 0 && outputRootReadRequested && facts.outputRoot && !outputRootAlreadyReadAuthorized) {
    const reference = input.prompt.trim().slice(0, 240)
    return {
      report: withAnalysisCoverage(emptyReport('blocked', [issue('TOOL_PERMISSION_REQUIRED', 'workDirs', {
        reference,
        reasonCode: 'output_root_not_read_authorized',
        candidates: [facts.outputRoot],
        candidateCount: 1
      })], [{
        path: facts.outputRoot,
        purposeKey: 'butler.preflight.output_root_read_candidate_purpose',
        source: reference,
        validationStatus: 'valid'
      }]), analysis),
      bindings: [],
      factsDigest: facts.digest,
      requiredPermissions,
      authorizationContinuation: {
        authorizedRoots: [...new Set([...facts.roots, facts.outputRoot, ...rootsNeedingAuthorization(filesystemPermissions, facts)])].sort(),
        analysis
      },
      ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
    }
  }
  if (filesystemPermissions.length > 0 && facts.roots.length === 0) {
    const report = withAnalysisCoverage(emptyReport('blocked', [issue('TOOL_PERMISSION_REQUIRED', 'workDirs')]), analysis)
    const requestedRoots = permissionRoots(filesystemPermissions)
    return {
      report: withPermissionNeeds(report, requiredPermissions, input.mcpTools), bindings: [], factsDigest: facts.digest, requiredPermissions,
      ...(requestedRoots.length && requestedRoots.every(isCanonicalAbsolutePath)
        ? { authorizationContinuation: { authorizedRoots: requestedRoots, analysis } }
        : {}),
      ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
    }
  }
  const candidateMcpTools = input.mcpTools ?? []
  const requirementsInScope = requiredPermissions.every((permission) => permission.tool === 'mcp'
    ? candidateMcpTools.some((candidate) => candidate.serverId === permission.serverId && candidate.toolName === permission.toolName
      && /^[a-f0-9]{64}$/.test(candidate.descriptorHash) && /^[a-f0-9]{64}$/.test(candidate.profileHash))
    : permission.tool === 'run_shell'
    ? facts.roots.some((root) => isWithinRoot(permission.workingDirectory, root)) && facts.entries.some((entry) => entry.path === permission.workingDirectory && entry.kind === 'directory')
    : permission.scopeRoots.every((root) => facts.roots.some((authorizedRoot) => isWithinRoot(root, authorizedRoot))
      && facts.entries.some((entry) => entry.path === root && entry.kind === 'directory')))
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
      return {
        report: withAnalysisCoverage(emptyReport('blocked', [issue('TOOL_PERMISSION_REQUIRED', 'workDirs', {
          reference,
          reasonCode: 'output_root_not_read_authorized',
          candidates: [facts.outputRoot],
          candidateCount: 1
        })], [{
          path: facts.outputRoot,
          purposeKey: 'butler.preflight.output_root_read_candidate_purpose',
          source: reference,
          validationStatus: 'valid'
        }]), analysis),
        bindings: [],
        factsDigest: facts.digest,
        requiredPermissions,
        authorizationContinuation: {
          authorizedRoots: [...new Set([...facts.roots, facts.outputRoot, ...rootsNeedingAuthorization(filesystemPermissions, facts)])].sort(),
          analysis
        },
        ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
      }
    }
    const requestedRoots = rootsNeedingAuthorization(filesystemPermissions, facts)
    const requestedRootSet = new Set(requestedRoots)
    const invalidInScopeRoots = permissionRoots(filesystemPermissions).filter((requestedRoot) => !requestedRootSet.has(requestedRoot)
      && !facts.entries.some((entry) => entry.path === requestedRoot && entry.kind === 'directory'))
    if (requestedRoots.length > 0 && invalidInScopeRoots.length === 0 && requestedRoots.every(isCanonicalAbsolutePath)) {
      const report = withAnalysisCoverage(emptyReport('blocked', [issue('TOOL_PERMISSION_REQUIRED', 'workDirs')]), analysis)
      return {
        report: withPermissionNeeds(report, requiredPermissions, input.mcpTools),
        bindings: [], factsDigest: facts.digest, requiredPermissions,
        authorizationContinuation: { authorizedRoots: [...new Set([...facts.roots, ...requestedRoots])].sort(), analysis },
        ...(analysis.mockTrace ? { mockTrace: analysis.mockTrace } : {})
      }
    }
    return { report: emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]), bindings: [], factsDigest: facts.digest }
  }
  const factPaths = new Set(facts.entries.map((entry) => entry.path))
  // Facts/report 阶段只保留可核验的原文片段、原因代码和主机 facts 中的候选路径；模型文本不授予路径，也不改写执行授权。
  const outputRootGitReferences = new Set((analysis.clarifications ?? [])
    .filter((clarification) => facts.outputRootIsGitRepository
      && ['git_repository_not_found', 'output_root_not_read_authorized'].includes(clarification.reasonCode)
      && input.prompt.includes(clarification.reference))
    .map((clarification) => clarification.reference))
  const clarificationIssues: PreflightIssue[] = (analysis.clarifications ?? [])
    .filter((clarification) => input.prompt.includes(clarification.reference))
    .filter((clarification) => !(facts.outputRootIsGitRepository && clarification.reasonCode === 'target_missing' && outputRootGitReferences.has(clarification.reference)))
    // policy: after host scope validation, concrete permission requirements enter the explicit
    // user-review stage; the model's "capability_not_authorized" note describes that request
    // and must not block the same permission from reaching the review ticket.
    .filter((clarification) => !(clarification.reasonCode === 'capability_not_authorized' && requiredPermissions.length > 0))
    .slice(0, 5)
    .map((clarification) => {
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
  if (analysis.targets.length === 0 && clarificationIssues.length === 0 && requiredPermissions.length === 0) {
    const reference = input.prompt.trim().slice(0, 240)
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
    else blockers.push(issue(resolved.issue.code, resolved.issue.field, resolved.issue))
  }
  const suggestedDirectories: SuggestedDirectory[] = (analysis.suggestedDirectories ?? []).map((suggestion) => ({ ...suggestion, validationStatus: 'unavailable' }))
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
