import { readHistory, type HistoryFact } from '../../src/shared/historyReader'
import { defineDirectTool } from './plannedToolRegistry'
import type { ToolExecutionContext, ToolExecutorResult } from './types'

export const readHistoryToolExecutor = async (
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutorResult> => {
  if (!context.historyFacts) return { success: false, error: 'History is unavailable for this session' }
  try {
    const result = readHistory(context.historyFacts, {
      sessionId: context.sessionId,
      windowId: typeof input.window_id === 'string' ? input.window_id : undefined,
      entryId: typeof input.entry_id === 'string' ? input.entry_id : undefined,
      query: typeof input.query === 'string' ? input.query : undefined,
      cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
      maxTokens: typeof input.max_tokens === 'number' ? input.max_tokens : undefined
    })
    return { success: true, data: result }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const historyReadTool = defineDirectTool<Record<string, unknown>, ToolExecutorResult>({
  name: 'history.read',
  parseInput: (raw) => raw && typeof raw === 'object' ? raw as Record<string, unknown> : {},
  async execute(input, context) {
    return readHistoryToolExecutor(input, context.runtimeContext as ToolExecutionContext)
  }
})

export type { HistoryFact }
