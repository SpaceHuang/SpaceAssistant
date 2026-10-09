import type { AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import type { TurnStarted } from '../../src/shared/turnCoordinator'
import type { TurnRuntime } from '../turnRuntime'
import { HostedTurnFinalizedError } from '../runtime/hostedTurnFinalization'

type RemoteResult = { ok: boolean; error?: string; parked?: boolean; outcome?: 'completed' | 'parked' | 'failed' | 'cancelled' | 'timed-out' | 'interrupted' | 'commit-uncertain' }

function persistedUsageFromRemoteResult(result: RemoteResult): unknown {
  if (!('usageJson' in result) || typeof result.usageJson !== 'string') return undefined
  try { return JSON.parse(result.usageJson) }
  catch { return undefined }
}

// 保留本进程内已完成 remote 调用的返回值；重试如果被 Coordinator 判定为已终态，
// 不再重新调用 provider，但仍需向上层返回与首次调用一致的业务结果。
const completedResults = new WeakMap<TurnRuntime, Map<string, RemoteResult>>()

function resultsForRuntime(runtime: TurnRuntime): Map<string, RemoteResult> {
  let results = completedResults.get(runtime)
  if (!results) {
    results = new Map()
    completedResults.set(runtime, results)
  }
  return results
}

/** 将 remote agent 包装为统一的 turn source；agent 本身仍负责 IM 交互和工具执行。 */
export async function executeRemoteTurn<T extends RemoteResult>(args: {
  runtime?: TurnRuntime
  prepared?: TurnStarted
  requestId: string
  run: () => Promise<T>
}): Promise<T> {
  if (!args.runtime || !args.prepared) throw new Error('REMOTE_TURN_REQUIRES_RUNTIME')

  let result: T | undefined
  args.runtime.bindRequest(args.requestId, args.prepared.turnId)
  let execution: Awaited<ReturnType<TurnRuntime['executeWithSource']>>
  try {
    execution = await args.runtime.executeWithSource(args.prepared.turnId, args.prepared.startToken, async () => {
      try {
        result = await args.run()
      } catch (error) {
        if (error instanceof HostedTurnFinalizedError && (error.outcome === 'cancelled' || error.outcome === 'timed-out')) {
          result = { ok: false, error: error.message, summary: error.message, pendingConfirm: false, outcome: error.outcome } as unknown as T
        } else if (error instanceof HostedTurnFinalizedError && error.outcome === 'interrupted') {
          result = { ok: false, error: error.message, summary: error.message, pendingConfirm: false, outcome: 'interrupted' } as unknown as T
        } else if (error instanceof HostedTurnFinalizedError && error.outcome === 'commit-uncertain') {
          result = { ok: false, error: error.message, summary: error.message, pendingConfirm: false, outcome: 'commit-uncertain' } as unknown as T
        } else {
          args.runtime!.consumeForRequest(args.requestId, { type: 'source-failed' }, args.prepared!.turnId)
          throw error
        }
      }
      if (result!.outcome === 'interrupted') {
        return {
          outcome: 'recovered',
          error: { code: 'HOSTED_TURN_INTERRUPTED', message: result!.error ?? 'Hosted turn interrupted' }
        }
      }
      if (result!.outcome === 'commit-uncertain') {
        args.runtime!.consumeForRequest(args.requestId, { type: 'source-uncertain', message: result!.error }, args.prepared!.turnId)
        return {
          outcome: 'commit-uncertain',
          error: { code: 'SESSION_TRANSCRIPT_COMMIT_UNCERTAIN', message: result!.error ?? 'Session transcript commit is uncertain' }
        }
      }
      if (result!.parked) {
        args.runtime!.consumeForRequest(args.requestId, { type: 'source-parked' }, args.prepared!.turnId)
        resultsForRuntime(args.runtime!).set(args.prepared!.turnId, result!)
        return { outcome: 'parked' as const }
      }
      const terminal: AssistantFactEvent = result!.ok
        ? { type: 'source-completed' }
        : result!.outcome === 'cancelled'
          ? { type: 'source-cancelled' }
          : result!.outcome === 'timed-out'
            ? { type: 'source-timeout' }
            : { type: 'source-failed' }
      args.runtime!.consumeForRequest(args.requestId, terminal, args.prepared!.turnId)
      // 只有 Runtime 接受终态后才缓存业务结果，否则重试可能让失败的持久终态
      // 被进程内尚未提交的成功结果覆盖。
      resultsForRuntime(args.runtime!).set(args.prepared!.turnId, result!)
      const usage = persistedUsageFromRemoteResult(result!)
      const outcome = result!.ok ? 'completed' as const : result!.outcome ?? 'failed' as const
      return { outcome, ...(usage !== undefined ? { usage } : {}) }
    })
  } finally {
    args.runtime.unbindRequest(args.requestId, args.prepared.turnId)
  }
  const runtimeResults = resultsForRuntime(args.runtime!)
  if (result?.outcome === 'interrupted' || result?.outcome === 'commit-uncertain') runtimeResults.set(args.prepared.turnId, result)
  if (result) return result
  const completed = runtimeResults.get(args.prepared.turnId) as T | undefined
  if (completed) return completed
  if (execution && 'outcome' in execution) {
    // 跨进程恢复时 Runtime 只有持久化 terminal outcome，没有首次 provider 的
    // 进程内结果；从 prepare 恢复的 assistant checkpoint 回填成功回复，禁止重新执行 provider。
    const summary = args.prepared.assistantMessage.content
    return {
      ok: execution.outcome === 'completed',
      ...(execution.outcome === 'failed' ? { outcome: 'failed' } : {}),
      ...((execution.outcome === 'cancelled' || execution.outcome === 'timed-out') ? { outcome: execution.outcome } : {}),
      ...(execution.outcome === 'recovered' ? { outcome: 'interrupted', error: execution.error?.message ?? 'Turn interrupted' } : {}),
      ...(execution.outcome === 'commit-uncertain' ? { outcome: 'commit-uncertain', error: execution.error?.message ?? 'Session transcript commit is uncertain' } : {}),
      ...(execution.outcome === 'completed' && typeof summary === 'string' ? { summary } : {}),
      ...(execution.usage !== undefined ? { usageJson: JSON.stringify(execution.usage) } : {})
    } as T
  }
  throw new Error('REMOTE_TURN_RESULT_MISSING')
}
