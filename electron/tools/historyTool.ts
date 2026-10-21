import { readHistory, type HistoryFact } from '../../src/shared/historyReader'
import { createSnapshotReadRegisteredTool } from './snapshotReadRegisteredTool'
import type { ToolExecutionContext, ToolExecutorResult } from './types'

export const HISTORY_COMPRESSED_SNAPSHOT_UNAVAILABLE =
  '没有可回查的压缩历史；这只表示缺少压缩检查点，请检查本次请求已提供的消息，不要据此判断对话上下文缺失。'

export const readHistoryToolExecutor = async (
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutorResult> => {
  if (!context.historyFacts) return { success: false, error: HISTORY_COMPRESSED_SNAPSHOT_UNAVAILABLE }
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

export const historyReadTool = createSnapshotReadRegisteredTool('history.read', readHistoryToolExecutor)

export type { HistoryFact }
