import type { PreflightIssue, PreflightReport, SuggestedDirectory, TargetBinding } from '../../src/shared/automationTaskTypes'
import { TaskPathFactsProvider, type TaskPathFacts } from './taskPathFacts'
import { resolveTaskTarget, type ProposedTaskTarget } from './taskTargetResolver'

export type TaskPreflightAnalysisInput = {
  prompt: string
  scheduleSummary: string
  deliverySummary: string
  roots: string[]
  facts: TaskPathFacts
  tools: readonly []
  responseFormat: 'json'
}

export type TaskPreflightAnalysisOutput = { targets: ProposedTaskTarget[]; suggestedDirectories?: Array<{ path: string; purpose: string; source: string }> }
export type TaskPreflightAnalyzer = { analyze(input: TaskPreflightAnalysisInput, signal: AbortSignal): Promise<TaskPreflightAnalysisOutput> }
export type TaskPreflightInput = { prompt: string; scheduleSummary: string; deliverySummary: string; roots: string[]; taskRevision: number }
export type TaskPreflightResult = { report: PreflightReport; bindings: TargetBinding[]; factsDigest?: string }
export type TaskPreflightDependencies = { analyzer: TaskPreflightAnalyzer; factsProvider?: Pick<TaskPathFactsProvider, 'collect'>; timeoutMs?: number; now?: () => number }

const issue = (code: string, field = 'prompt'): PreflightIssue => ({ code, field, messageKey: `butler.preflight.${code.toLowerCase()}` })
const emptyReport = (status: PreflightReport['status'], blockers: PreflightIssue[], suggestedDirectories: SuggestedDirectory[] = []): PreflightReport => ({ status, blockers, suggestedDirectories })

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
  try { facts = await (deps.factsProvider ?? new TaskPathFactsProvider()).collect(input.roots) }
  catch { return { report: emptyReport('blocked', [issue('ROOT_FACTS_UNAVAILABLE', 'workDirs')]), bindings: [] } }
  if (!facts.coverage.complete) return { report: emptyReport('blocked', [issue('FACTS_INCOMPLETE')]), bindings: [], factsDigest: facts.digest }
  let analysis: TaskPreflightAnalysisOutput | undefined
  try {
    analysis = validateAnalysis(await withTimeout((signal) => deps.analyzer.analyze({
      prompt: input.prompt,
      scheduleSummary: input.scheduleSummary,
      deliverySummary: input.deliverySummary,
      roots: facts.roots,
      facts,
      tools: [],
      responseFormat: 'json'
    }, signal), deps.timeoutMs ?? 15_000))
  } catch {
    return { report: emptyReport('unavailable', [issue('ANALYZER_UNAVAILABLE')]), bindings: [], factsDigest: facts.digest }
  }
  if (!analysis) return { report: emptyReport('unavailable', [issue('ANALYZER_INVALID_RESPONSE')]), bindings: [], factsDigest: facts.digest }
  if (analysis.targets.length === 0) return { report: emptyReport('blocked', [issue('TARGET_UNCLEAR')]), bindings: [], factsDigest: facts.digest }
  const bindings: TargetBinding[] = []
  const blockers: PreflightIssue[] = []
  for (const target of analysis.targets) {
    const resolved = resolveTaskTarget({ rawText: input.prompt, target, roots: facts.roots, facts, taskRevision: input.taskRevision })
    if (resolved.ok) bindings.push(resolved.binding)
    else blockers.push(issue(resolved.issue.code))
  }
  const suggestedDirectories = (analysis.suggestedDirectories ?? []).map((suggestion) => ({ ...suggestion, validationStatus: 'unavailable' as const }))
  return {
    report: emptyReport(blockers.length ? 'blocked' : 'passed', blockers, suggestedDirectories),
    bindings: blockers.length ? [] : bindings,
    factsDigest: facts.digest
  }
}
