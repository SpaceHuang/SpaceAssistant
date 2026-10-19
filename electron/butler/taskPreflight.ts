import path from 'node:path'
import { getPreflightIssueMessageKey, type AutomationTaskToolRequirement, type PreflightClarificationReasonCode, type PreflightIssue, type PreflightReport, type SuggestedDirectory, type TargetBinding } from '../../src/shared/automationTaskTypes'
import { TaskPathFactsProvider, type TaskPathFacts } from './taskPathFacts'
import { resolveTaskTarget, type ProposedTaskTarget } from './taskTargetResolver'

export type TaskPreflightAnalysisInput = {
  prompt: string
  scheduleSummary: string
  deliverySummary: string
  authorizedRoots: string[]
  outputRoot?: string
  facts: TaskPathFacts
  tools: readonly []
  responseFormat: 'json'
}

export type TaskPreflightClarification = { reference: string; reasonCode: PreflightClarificationReasonCode; candidates?: string[] }
export type TaskPreflightAnalysisOutput = { targets: ProposedTaskTarget[]; requiredPermissions?: AutomationTaskToolRequirement[]; clarifications?: TaskPreflightClarification[]; suggestedDirectories?: Array<{ path: string; purpose: string; source: string }> }
export type TaskPreflightAnalyzer = { analyze(input: TaskPreflightAnalysisInput, signal: AbortSignal): Promise<TaskPreflightAnalysisOutput> }
export type TaskPreflightInput = { prompt: string; scheduleSummary: string; deliverySummary: string; roots: string[]; outputDir?: string; taskRevision: number }
export type TaskPreflightResult = { report: PreflightReport; bindings: TargetBinding[]; factsDigest?: string; requiredPermissions?: AutomationTaskToolRequirement[] }
export type TaskPreflightDependencies = { analyzer: TaskPreflightAnalyzer; factsProvider?: Pick<TaskPathFactsProvider, 'collect'>; timeoutMs?: number; now?: () => number }

const issue = (code: string, field = 'prompt', details: Partial<PreflightIssue> = {}): PreflightIssue => ({ code, field, messageKey: getPreflightIssueMessageKey(code), ...details })
const emptyReport = (status: PreflightReport['status'], blockers: PreflightIssue[], suggestedDirectories: SuggestedDirectory[] = []): PreflightReport => ({ status, blockers, suggestedDirectories })
const DEFAULT_ANALYZER_TIMEOUT_MS = 60_000

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function classifyAnalyzerFailure(error: unknown): 'ANALYZER_TIMEOUT' | 'ANALYZER_INVALID_RESPONSE' | 'ANALYZER_UNAVAILABLE' {
  const code = error instanceof Error ? error.message : ''
  if (code === 'PREFLIGHT_TIMEOUT') return 'ANALYZER_TIMEOUT'
  if (code === 'PREFLIGHT_MODEL_EMPTY_RESPONSE' || code === 'PREFLIGHT_MODEL_INVALID_JSON' || code === 'PREFLIGHT_MODEL_INVALID_SCHEMA' || code === 'PREFLIGHT_MODEL_TRUNCATED_RESPONSE') return 'ANALYZER_INVALID_RESPONSE'
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
  const requiredPermissions = (value as { requiredPermissions?: unknown }).requiredPermissions
  if (requiredPermissions !== undefined && (!Array.isArray(requiredPermissions) || requiredPermissions.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true
    const permission = item as Record<string, unknown>
    if (permission.tool === 'run_shell') return typeof permission.command !== 'string' || !permission.command.trim() || permission.command.length > 4096 || typeof permission.workingDirectory !== 'string' || !permission.workingDirectory.trim()
      || (permission.timeout !== undefined && (typeof permission.timeout !== 'number' || !Number.isInteger(permission.timeout) || permission.timeout < 1 || permission.timeout > 86400))
    if (permission.tool === 'grep' || permission.tool === 'run_script') return !Array.isArray(permission.scopeRoots) || permission.scopeRoots.length === 0 || permission.scopeRoots.length > 20 || permission.scopeRoots.some((root) => typeof root !== 'string' || !root.trim())
    return true
  }))) return undefined
  // Old tool-name-only requests have no safe parameter scope and cannot be upgraded into grants.
  if ('requiredTools' in value && Array.isArray((value as { requiredTools?: unknown }).requiredTools) && (value as { requiredTools: unknown[] }).requiredTools.length > 0) return undefined
  const clarifications = (value as { clarifications?: unknown }).clarifications
  const allowedReasons = new Set(['no_target_identified', 'scope_unclear', 'missing_location', 'multiple_matches', 'target_missing', 'git_repository_not_found', 'capability_not_authorized', 'other'])
  if (clarifications !== undefined && (!Array.isArray(clarifications) || clarifications.some((item) => {
    if (!item || typeof item !== 'object') return true
    const clarification = item as Record<string, unknown>
    return typeof clarification.reference !== 'string' || !clarification.reference.trim() || clarification.reference.length > 240 || !allowedReasons.has(String(clarification.reasonCode)) || (clarification.candidates !== undefined && (!Array.isArray(clarification.candidates) || clarification.candidates.length > 50 || clarification.candidates.some((candidate) => typeof candidate !== 'string' || candidate.length > 2048)))
  }))) return undefined
  const suggestedDirectories = (value as { suggestedDirectories?: unknown }).suggestedDirectories
  if (suggestedDirectories !== undefined && (!Array.isArray(suggestedDirectories) || suggestedDirectories.some((item) => !item || typeof item !== 'object' || typeof (item as Record<string, unknown>).path !== 'string' || typeof (item as Record<string, unknown>).purpose !== 'string' || typeof (item as Record<string, unknown>).source !== 'string'))) return undefined
  return value as TaskPreflightAnalysisOutput
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
  let facts: TaskPathFacts
  try { facts = await (deps.factsProvider ?? new TaskPathFactsProvider()).collect(input.roots, input.outputDir) }
  catch { return { report: emptyReport('blocked', [issue('ROOT_FACTS_UNAVAILABLE', 'workDirs')]), bindings: [] } }
  if (!facts.coverage.complete) return { report: emptyReport('blocked', [issue('FACTS_INCOMPLETE')]), bindings: [], factsDigest: facts.digest }
  let analysis: TaskPreflightAnalysisOutput | undefined
  try {
    analysis = validateAnalysis(await withTimeout((signal) => deps.analyzer.analyze({
      prompt: input.prompt,
      scheduleSummary: input.scheduleSummary,
      deliverySummary: input.deliverySummary,
      authorizedRoots: facts.roots,
      outputRoot: facts.outputRoot,
      facts,
      tools: [],
      responseFormat: 'json'
    }, signal), deps.timeoutMs ?? DEFAULT_ANALYZER_TIMEOUT_MS))
  } catch (error) {
    return { report: emptyReport('unavailable', [issue(classifyAnalyzerFailure(error))]), bindings: [], factsDigest: facts.digest }
  }
  if (!analysis) return { report: emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]), bindings: [], factsDigest: facts.digest }
  const requiredPermissions = analysis.requiredPermissions ?? []
  // facts: 本机工具授权必须落在用户选择并由主机核验的目录范围；结果输出根不能充当读取/命令范围。
  if (requiredPermissions.length > 0 && facts.roots.length === 0) {
    return { report: emptyReport('blocked', [issue('TOOL_PERMISSION_REQUIRED', 'workDirs')]), bindings: [], factsDigest: facts.digest }
  }
  const requirementsInScope = requiredPermissions.every((permission) => permission.tool === 'run_shell'
    ? facts.roots.includes(permission.workingDirectory)
    : permission.scopeRoots.every((root) => facts.roots.some((authorizedRoot) => isWithinRoot(root, authorizedRoot))
      && facts.entries.some((entry) => entry.path === root && entry.kind === 'directory')))
  if (!requirementsInScope) return { report: emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]), bindings: [], factsDigest: facts.digest }
  const factPaths = new Set(facts.entries.map((entry) => entry.path))
  // Facts/report 阶段只保留可核验的原文片段、原因代码和主机 facts 中的候选路径；模型文本不授予路径，也不改写执行授权。
  const clarificationIssues: PreflightIssue[] = (analysis.clarifications ?? [])
    .filter((clarification) => input.prompt.includes(clarification.reference))
    .slice(0, 5)
    .map((clarification) => {
      const modelCandidates = [...new Set((clarification.candidates ?? []).filter((candidate) => factPaths.has(candidate)))]
      const inferredCandidates = clarification.reasonCode === 'multiple_matches'
        ? facts.entries.filter((entry) => ['file', 'directory'].includes(entry.kind) && clarification.reference.includes(path.basename(entry.path))).map((entry) => entry.path)
        : []
      const allCandidates = modelCandidates.length > 1 ? modelCandidates : inferredCandidates
      const candidates = [...new Set(allCandidates)].slice(0, 20)
      const reasonCode = clarification.reasonCode === 'multiple_matches' && candidates.length < 2 ? 'other' : clarification.reasonCode
      const code = reasonCode === 'multiple_matches' ? 'TARGET_AMBIGUOUS'
        : reasonCode === 'target_missing' || reasonCode === 'git_repository_not_found' ? 'TARGET_NOT_FOUND'
          : reasonCode === 'capability_not_authorized' ? 'TOOL_PERMISSION_REQUIRED'
            : 'TARGET_UNCLEAR'
      return issue(code, 'prompt', {
        reference: clarification.reference,
        reasonCode,
        ...(candidates.length ? { candidates, candidateCount: allCandidates.length } : {})
      })
    })
  if (analysis.targets.length === 0 && clarificationIssues.length === 0) {
    const reference = input.prompt.trim().slice(0, 240)
    return {
      report: emptyReport('blocked', [issue('TARGET_UNCLEAR', 'prompt', { reference, reasonCode: 'no_target_identified' })]),
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
  const suggestedDirectories = (analysis.suggestedDirectories ?? []).map((suggestion) => ({ ...suggestion, validationStatus: 'unavailable' as const }))
  return {
    report: emptyReport(blockers.length ? 'blocked' : 'passed', blockers, suggestedDirectories),
    bindings: blockers.length ? [] : bindings,
    factsDigest: facts.digest,
    requiredPermissions
  }
}
