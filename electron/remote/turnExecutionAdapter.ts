import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import type { TurnStarted } from '../../src/shared/turnCoordinator'
import type { TurnRuntime } from '../turnRuntime'

type RemoteResult = { ok: boolean; outcome?: 'cancelled' | 'timed-out' }

// 保留本进程内已完成 remote 调用的返回值；重试如果被 Coordinator 判定为已终态，
// 不再重新调用 provider，但仍需向上层返回与首次调用一致的业务结果。
const completedResults = new Map<string, RemoteResult>()

/** 将 remote agent 包装为统一的 turn source；agent 本身仍负责 IM 交互和工具执行。 */
export async function executeRemoteTurn<T extends RemoteResult>(args: {
  runtime?: TurnRuntime
  prepared?: TurnStarted
  requestId: string
  run: () => Promise<T>
}): Promise<T> {
  if (!args.runtime || !args.prepared) throw new Error('REMOTE_TURN_REQUIRES_RUNTIME')

  let result: T | undefined
  const execution = await args.runtime.executeWithSource(args.prepared.turnId, args.prepared.startToken, async () => {
    try {
      result = await args.run()
      completedResults.set(args.requestId, result)
      const terminal: AssistantFactEvent = result.ok
        ? { type: 'source-completed' }
        : result.outcome === 'cancelled'
          ? { type: 'source-cancelled' }
          : result.outcome === 'timed-out'
            ? { type: 'source-timeout' }
            : { type: 'source-failed' }
      args.runtime!.consumeForRequest(args.requestId, terminal)
      return { outcome: result.ok ? 'completed' as const : 'failed' as const }
    } catch (error) {
      args.runtime!.consumeForRequest(args.requestId, { type: 'source-failed' })
      throw error
    }
  })
  if (result) return result
  const completed = completedResults.get(args.requestId) as T | undefined
  if (completed) return completed
  if (execution && 'outcome' in execution) {
    // 跨进程恢复时 Runtime 只有持久化 terminal outcome，没有首次 provider 的
    // 业务摘要；向 remote 调用方返回稳定的成功/失败契约，禁止重新执行 provider。
    return { ok: execution.outcome === 'completed' } as T
  }
  throw new Error('REMOTE_TURN_RESULT_MISSING')
}
