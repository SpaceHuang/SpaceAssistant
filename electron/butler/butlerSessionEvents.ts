import { getSessionEventSink, stripPartialJsonForPersist, type SessionEventSink } from '../sessionEvents'
import type { SessionEventInput } from '../sessionEvents'
import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { reduceAssistantFact, type AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import type { Message } from '../../src/shared/domainTypes'
import type { SessionStorage } from '../sessionStorage/host/ports'

/**
 * 管家的无窗口事件出口（P1 出口契约的 automation 装配）：
 * UI 事实（invocation.events.onFact）→ assistant 消息账本（供自动化会话回看）；
 * 台账（emitSessionEvent）→ 照常落盘（重开窗口可回看，P1 行为语义）。
 */

export type ButlerSessionEvents = {
  /** 会话台账 sink（管家回合的事件文件写入器）。 */
  sink?: SessionEventSink
  /** runToolChatSession 的 invocation.events.onSessionEvent 实现。 */
  emitSessionEvent: (event: SessionEventInput) => Promise<void>
  /** runToolChatSession 的 invocation.events.onFact 实现。 */
  emitFactEvent: (event: AssistantFactEvent) => void
  /** runToolChatSession.onFileTreeChanged 实现（管家无文件树 UI）。 */
  onFileTreeChanged: () => void
}

export function createButlerSessionEvents(args: {
  userDataDir: string
  taskId: string
  sessionId: string
  sessionCreatedAt: number
  assistantMessageId: string
  sessionStorage: SessionStorage
  failClosedCriticalEvents?: boolean
  enableLedger?: boolean
  onLedgerFailure?(error: unknown): void
}): Promise<ButlerSessionEvents> {
  const automationRoot = path.resolve(args.userDataDir, 'automation-sessions')
  const privateRoot = path.resolve(automationRoot, args.taskId)
  const initialize = async () => {
    await mkdir(automationRoot, { recursive: true })
    const rootInfo = await lstat(automationRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('AUTOMATION_SESSION_ROOT_INVALID')
    await mkdir(privateRoot, { recursive: true })
    const taskInfo = await lstat(privateRoot)
    if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink()) throw new Error('AUTOMATION_SESSION_ROOT_INVALID')
    const canonical = await realpath(privateRoot)
    const canonicalParent = await realpath(automationRoot)
    if (!canonical.startsWith(`${canonicalParent}${path.sep}`)) throw new Error('AUTOMATION_SESSION_ROOT_INVALID')
    await access(canonical, constants.R_OK | constants.W_OK | constants.X_OK)
    return canonical
  }
  const reportLedgerFailure = (error: unknown): void => {
    try { args.onLedgerFailure?.(error) } catch { /* diagnostics must not affect Hosted execution */ }
  }
  const root = args.enableLedger === false ? Promise.resolve(undefined) : initialize().catch((error) => { reportLedgerFailure(error); return undefined })
  return root.then((canonicalRoot) => {
  let sink: SessionEventSink | undefined
  if (canonicalRoot) {
    try { sink = getSessionEventSink(canonicalRoot, args.sessionId, args.sessionCreatedAt) }
    catch (error) { reportLedgerFailure(error) }
  }
  const emitSessionEvent = async (event: SessionEventInput): Promise<void> => {
    // R1：tool_call_delta.partialJson 原文不落台账（chunk 拼接可还原凭据）
    const persistable = stripPartialJsonForPersist(event)
    if (!sink) return
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
    } catch (error) {
      reportLedgerFailure(error)
      sink = undefined
      // Canonical History is authoritative; the secondary ledger stays diagnostic-only.
      if (args.failClosedCriticalEvents) throw error
    }
  }
  return {
    sink,
    emitSessionEvent,
    emitFactEvent: (event) => {
      const current = args.sessionStorage.queries.readMessage({ sessionId: args.sessionId, messageId: args.assistantMessageId })
      if (!current) throw new Error('AUTOMATION_ASSISTANT_MESSAGE_MISSING')
      const next = reduceAssistantFact(current, event, { now: Date.now(), createId: () => crypto.randomUUID() })
      if (next !== current && args.sessionStorage.commands.updateStreamingMessage(args.assistantMessageId, next) === null) {
        throw new Error('AUTOMATION_ASSISTANT_MESSAGE_PROJECTION_FAILED')
      }
    },
    onFileTreeChanged: () => undefined
  }
  })
}
