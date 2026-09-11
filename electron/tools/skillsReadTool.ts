import { getCachedSkills } from '../skills/skillCache'
import { readSkillForTool } from '../../src/shared/skillPrompt'
import { defineDirectTool } from './plannedToolRegistry'
import type { ToolExecutorResult } from './types'
import type { ToolExecutionContext } from './types'

export const readSkillsToolExecutor = async (input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutorResult> => {
  const name = typeof input.name === 'string' ? input.name : ''
  const maxChars = typeof input.max_chars === 'number' ? input.max_chars : 32_000
  try {
    const content = readSkillForTool(getCachedSkills(context.userDataDir, context.workDir), name, maxChars)
    return { success: true, data: { name, content } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const skillsReadTool = defineDirectTool<Record<string, unknown>, ToolExecutorResult>({
  name: 'skills.read',
  parseInput: (raw) => raw && typeof raw === 'object' ? raw as Record<string, unknown> : {},
  async execute(input, context) {
    return readSkillsToolExecutor(input, context.runtimeContext as ToolExecutionContext)
  }
})
