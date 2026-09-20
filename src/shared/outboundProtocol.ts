import type { Message } from './domainTypes'

/** 出站上下文意图：渲染端只表达「想做什么」，决定（建会话/排队/发起）由主进程受理端口做出 */
export type OutboundContextIntent =
  | { kind: 'create-user'; text: string; attachments?: Message['attachments'] }
  | {
      kind: 'reuse-user'
      currentUser: { message: Message; order: { kind: 'persisted'; sequence: number } }
      /** 排水必须透传队列里的原 requestId（幂等凭证） */
      requestId?: string
      excludeMessageIds?: string[]
    }

/** 无会话首条消息的代建偏好（B2）：composer 草稿(model/llmServiceId/thinkingEffort)随创建落库 */
export type OutboundSessionPrefs = {
  model?: string
  llmServiceId?: string
  thinkingEffort?: import('./agent/invocation').AgentReasoningEffort
}

export type OutboundSubmitIntent = {
  /** 无会话 = 请主进程创建（决定回主进程） */
  sessionId?: string
  text: string
  attachments?: Message['attachments']
  contextIntent?: OutboundContextIntent
  /** 仅在未携带 sessionId 时生效：主进程代建会话的初始偏好 */
  sessionPrefs?: OutboundSessionPrefs
}

export type LocalCommandPayload =
  | { kind: 'test-pop-run' }
  | { kind: 'test-cards-run' }
  | { kind: 'hint-only'; hint: string; /** 主进程已落库时携带，渲染端据此路由真实消息；无会话快路径（仅展示）缺省 */ messageId?: string; sequence?: number }

export type OutboundSubmitResult =
  | {
      accepted: 'turn-started'
      sessionId: string
      turnId: string
      assistantMessage: Message
      /** 通过型警告（错误码）：如上下文占用≥80%——提示后照常发起，渲染端仅翻译展示 */
      warnings?: string[]
    }
    // 协议注释：turn 投影（chatOnTurnProjection）是唯一事实源；本返回载荷仅供即时展示，
    // 渲染端按 turnId/messageId 幂等归并，不得据此双写状态（投影事件可能先于 invoke 返回到达）
  | {
      accepted: 'queued'
      sessionId: string
      /** 落库凭据：渲染端据此把本地乐观排队条目转正（幂等归并），不重发查询 */
      queued: { requestId: string; messageId: string; sequence: number }
    }
  | {
      accepted: 'local-command'
      command: LocalCommandPayload
      /** v2-B1:主进程已为该命令代建会话时必填——渲染端据此切换视图再路由提示/预览 */
      sessionId?: string
    }
  | {
      rejected: {
        /** 错误码（errors i18n 命名空间），渲染端只翻译展示 */
        reason: string
        /** 拒绝附带警告（错误码）：如无视觉模型 */
        warnings?: string[]
      }
    }
