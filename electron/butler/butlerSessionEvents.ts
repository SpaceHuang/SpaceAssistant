import { getSessionEventSink, stripPartialJsonForPersist, type SessionEventSink } from '../sessionEvents'
import type { SessionEventInput } from '../sessionEvents'

/**
 * 管家的无窗口事件出口（P1 出口契约的 automation 装配）：
 * UI 事实（invocation.events.onFact）→ no-op（无窗口可投）；
 * 台账（emitSessionEvent）→ 照常落盘（重开窗口可回看，P1 行为语义）。
 */

export type ButlerSessionEvents = {
  /** 会话台账 sink（管家回合的事件文件写入器）。 */
  sink: SessionEventSink
  /** runToolChatSession 的 invocation.events.onSessionEvent 实现。 */
  emitSessionEvent: (event: SessionEventInput) => Promise<void>
  /** runToolChatSession 的 invocation.events.onFact 实现（no-op 是契约的一部分）。 */
  emitFactEvent: () => void
  /** runToolChatSession.onFileTreeChanged 实现（管家无文件树 UI）。 */
  onFileTreeChanged: () => void
}

export function createButlerSessionEvents(args: {
  workDir: string
  sessionId: string
  sessionCreatedAt: number
}): ButlerSessionEvents {
  const sink = getSessionEventSink(args.workDir, args.sessionId, args.sessionCreatedAt)
  const emitSessionEvent = async (event: SessionEventInput): Promise<void> => {
    // R1：tool_call_delta.partialJson 原文不落台账（chunk 拼接可还原凭据）
    const persistable = stripPartialJsonForPersist(event)
    if (persistable.type === 'assistant_chunk') {
      try {
        await sink.waitForCapacity()
        sink.appendChunk(persistable as SessionEventInput)
      } catch {
        // chunk 属可丢事件：sink 进入 fail-stop 后不再重试。
      }
      return
    }
    try {
      await sink.appendCritical(persistable)
    } catch {
      // 台账写入失败不阻断回合；诊断经由 agent 日志的 finalize 阶段上报。
    }
  }
  return {
    sink,
    emitSessionEvent,
    emitFactEvent: () => undefined,
    onFileTreeChanged: () => undefined
  }
}
