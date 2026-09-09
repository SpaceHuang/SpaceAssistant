import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'
import type { ModelResult, ModelSource, TurnStarted } from '../src/shared/turnCoordinator'

export type ModelEventEmitter = (event: AssistantFactEvent) => void

export type ModelEventSourceRunner = (args: {
  turn: TurnStarted
  token: string
  emit: ModelEventEmitter
  signal: AbortSignal
}) => Promise<ModelResult>

/**
 * 统一模型 source adapter：tool loop 只负责执行和产生规范化事件，事实落库仍由 Coordinator 完成。
 * 该 adapter 不接触 messages 表，也不把最终 Message 作为第二事实来源返回。
 */
export function createModelEventSource(
  runner: ModelEventSourceRunner,
  emit: (turnId: string, event: AssistantFactEvent) => void = () => undefined
): ModelSource {
  return async (turn, token) => {
    const controller = new AbortController()
    let eventSeq = 0
    return runner({
      turn,
      token,
      signal: controller.signal,
      emit: (event) => emit(turn.turnId, { ...event, eventSeq: ++eventSeq })
    })
  }
}

export function createEmittingModelEventSource(
  runner: ModelEventSourceRunner,
  emit: (turnId: string, event: AssistantFactEvent) => void
): ModelSource {
  return async (turn, token) => {
    const controller = new AbortController()
    let eventSeq = 0
    return runner({
      turn,
      token,
      signal: controller.signal,
      emit: (event) => emit(turn.turnId, { ...event, eventSeq: ++eventSeq })
    })
  }
}
