import { createHash } from 'node:crypto'
import { getCachedSkills } from '../skills/skillCache'
import type { SkillTurnScope } from '../skills/skillTurnScope'
import { readSkillForTool } from '../../src/shared/skillPrompt'
import { definePlannedTool, type RegisteredTool, type ToolExecutionContext } from './plannedToolRegistry'
import type { ToolExecutionContext as RuntimeToolExecutionContext, ToolExecutorResult } from './types'

const SKILLS_READ_MAX_CHARS = 32_000

type PreparedSkillRead = Readonly<{
  name: string
  content: string
  scopeId?: string
  contentSha256: string
  legacyRemoteRead?: true
}>

function requestedMaxChars(input: Record<string, unknown>): number {
  const requested = typeof input.max_chars === 'number' ? input.max_chars : SKILLS_READ_MAX_CHARS
  return Math.min(SKILLS_READ_MAX_CHARS, requested)
}

function readFromRuntime(input: Record<string, unknown>, context: RuntimeToolExecutionContext): ToolExecutorResult {
  const name = typeof input.name === 'string' ? input.name : ''
  if (context.skillTurnScope) {
    try {
      const plan = context.skillTurnScope.planRead(name, requestedMaxChars(input))
      return { success: true, data: { name, content: plan.content } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  // Preserve the existing Feishu / WeChat read path. Desktop turns must carry an accepted scope.
  if (context.lane === 'feishu' || context.lane === 'wechat' || context.remoteContext) {
    try {
      const content = readSkillForTool(getCachedSkills(context.userDataDir, context.workDir), name, requestedMaxChars(input))
      return { success: true, data: { name, content } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { success: false, error: 'SKILL_TURN_SCOPE_REQUIRED' }
}

export const readSkillsToolExecutor = async (
  input: Record<string, unknown>, context: RuntimeToolExecutionContext
): Promise<ToolExecutorResult> => readFromRuntime(input, context)

function parseInput(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_CANONICAL_TOOL_INPUT')
  const value = raw as Record<string, unknown>
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('SKILL_NAME_REQUIRED')
  if (value.max_chars !== undefined && (typeof value.max_chars !== 'number' || !Number.isFinite(value.max_chars))) {
    throw new Error('SKILL_READ_BUDGET_INVALID')
  }
  return structuredClone(value)
}

function runtimeScope(context: ToolExecutionContext): SkillTurnScope | undefined {
  return (context.runtimeContext as RuntimeToolExecutionContext | undefined)?.skillTurnScope
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export const skillsReadTool: RegisteredTool = definePlannedTool<Record<string, unknown>, PreparedSkillRead, ToolExecutorResult>({
  name: 'skills.read',
  actionClass: 'read',
  parseInput,
  plan: async (input, planning) => {
    const runtime = planning.executionContext as RuntimeToolExecutionContext | undefined
    if (!runtime) throw new Error('SKILLS_READ_RUNTIME_CONTEXT_REQUIRED')
    if (planning.signal.aborted) throw new Error('PLAN_CANCELLED')
    const name = input.name as string
    const scope = runtime.skillTurnScope
    if (scope) {
      const plan = scope.planRead(name, requestedMaxChars(input))
      return { name, content: plan.content, scopeId: plan.scopeId, contentSha256: plan.contentSha256 }
    }
    if (runtime.lane === 'feishu' || runtime.lane === 'wechat' || runtime.remoteContext) {
      const result = readFromRuntime(input, runtime)
      if (!result.success) throw new Error(result.error ?? 'SKILL_READ_FAILED')
      const data = result.data as { name: string; content: string }
      return { ...data, contentSha256: digest(data.content), legacyRemoteRead: true }
    }
    throw new Error('SKILL_TURN_SCOPE_REQUIRED')
  },
  validate: (prepared, execution) => {
    if (execution.signal.aborted) throw new Error('REQUEST_CANCELLED')
    if (prepared.legacyRemoteRead) {
      if (!execution.runtimeContext) throw new Error('SKILLS_READ_RUNTIME_CONTEXT_REQUIRED')
      return
    }
    const scope = runtimeScope(execution)
    if (!scope) throw new Error('SKILL_TURN_SCOPE_REQUIRED')
    scope.validateRead({
      scopeId: prepared.scopeId ?? '', name: prepared.name, content: prepared.content,
      contentSha256: prepared.contentSha256
    })
  },
  execute: async (prepared, execution) => {
    if (execution.signal.aborted) throw new Error('REQUEST_CANCELLED')
    if (prepared.legacyRemoteRead) return { success: true, data: { name: prepared.name, content: prepared.content } }
    const scope = runtimeScope(execution)
    if (!scope) throw new Error('SKILL_TURN_SCOPE_REQUIRED')
    scope.validateRead({
      scopeId: prepared.scopeId ?? '', name: prepared.name, content: prepared.content,
      contentSha256: prepared.contentSha256
    })
    if (!scope.commitRead(prepared.name)) return { success: false, error: 'SKILL_TURN_READ_BUDGET_EXCEEDED' }
    return { success: true, data: { name: prepared.name, content: prepared.content } }
  },
  facts: ({ name, contentSha256, scopeId }) => ({ name, contentSha256, scopeId }),
  display: ({ name }) => ({ toolName: 'skills.read', name })
})
