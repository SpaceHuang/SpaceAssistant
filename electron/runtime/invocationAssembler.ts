import type {
  AgentEventSink,
  AgentHostPorts,
  AgentInvocation,
  AgentNotifyEvent
} from '../../src/shared/agent/invocation'
import { AGENT_ADDITIONAL_CONTEXT_KEYS } from '../../src/shared/agent/invocation'
import type { FloatingNotificationManager } from '../floatingNotificationManager'

/**
 * Runtime 唯一装配点（roadmap「Runtime 是唯一装配点」在主进程的落位）。
 *
 * P1 立骨架：把调用方材料（字段名平移自原 RunToolChatSessionArgs）映射为
 * AgentInvocation + AgentHostPorts；P2 起在此承接端口实现（storage / usage / tools、
 * 规则与预检材料解析），P4 承接 Profile 解析，P6 承接 sink 注册。
 */

/** 调用方装配材料：字段与原 RunToolChatSessionArgs 同构（floatingNotificationManager 由装配器消化为 events.notify）。 */
export interface AgentInvocationMaterials {
  requestId: string
  sessionId: string
  turnId?: string
  llmServiceId?: string
  windowId?: string
  model: string
  contextWindow?: number
  baseUrl?: string
  messages: readonly unknown[]
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  toolsConfig: import('../../src/shared/domainTypes').ToolsConfig
  browserConfig?: import('../../src/shared/domainTypes').BrowserConfig
  shellConfig?: import('../../src/shared/domainTypes').ShellConfig | null
  wikiConfig?: import('../../src/shared/domainTypes').WikiConfig
  feishuConfig?: import('../../src/shared/domainTypes').FeishuConfig
  wechatConfig?: import('../../src/shared/domainTypes').WeChatConfig
  larkCliRunner?: import('../feishu/larkCliRunner').LarkCliRunner
  lane?: import('../../src/shared/confirmation/types').ExecutionLane
  internalConfirmExemption?: 'approval-agent'
  maxToolLoopRounds?: number
  approvalTaskDigest?: string
  remoteContext?: import('../tools/types').RemoteContext
  workDir: string
  workDirManager?: import('../workDirManager').WorkDirManager
  resolveWorkDir?: () => string
  userDataDir: string
  getApiKey: () => Promise<string | null>
  appDb?: unknown
  locale?: import('../../src/shared/domainTypes').AppLocale
  projectMemoryEnabled?: boolean
  skillFragments?: string[]
  currentUserMessageId?: string
  historyFacts?: readonly unknown[]
  assistantMessageId?: string
  hasImageAttachments?: boolean
  getBrowserDetectContext?: () => import('../../src/shared/browserTypes').BrowserDetectContext
  /** §5.5 收口：宿主实例在此包装为 events.notify，不再进入调用契约。 */
  floatingNotificationManager?: FloatingNotificationManager
  emitFactEvent: (event: import('../../src/shared/assistantFactAggregator').AssistantFactEvent) => void
  emitSessionEvent: (event: import('../sessionEvents').SessionEventInput) => void | Promise<void>
  onFileTreeChanged?: (event: import('../../src/shared/fileTreeSync').FileTreeChangeEvent) => void
  onTitleGenerated?: (session: import('../../src/shared/domainTypes').Session) => void
  appendCompactionTransaction?: (start: Record<string, unknown>, summary: Record<string, unknown>) => Promise<unknown>
  contextMeter?: import('../toolChatLoop').RunToolChatSessionArgs['contextMeter']
  onTurnBoundary?: import('../toolChatLoop').RunToolChatSessionArgs['onTurnBoundary']
}

/** 把宿主 FloatingNotificationManager 包装为 events.notify 出口实现（§5.5 收口）。 */
function wrapNotify(manager: FloatingNotificationManager): (event: AgentNotifyEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'confirm-request':
        manager.onConfirmRequest({
          requestId: event.requestId,
          sessionId: event.sessionId,
          sessionName: event.sessionName,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          createdAt: Date.now()
        })
        break
      case 'tool-result':
        manager.onToolResult(event.requestId, event.toolUseId)
        break
      case 'request-all-cancelled':
        manager.onAllCancelledForRequest(event.requestId)
        break
    }
  }
}

/** 材料中可空的可选事件出口归一为对象。 */
function buildEventSink(materials: AgentInvocationMaterials): AgentEventSink {
  return {
    onFact: materials.emitFactEvent,
    onSessionEvent: materials.emitSessionEvent as AgentEventSink['onSessionEvent'],
    ...(materials.onFileTreeChanged ? { onFileTreeChanged: (event) => materials.onFileTreeChanged?.(event) } : {}),
    ...(materials.onTitleGenerated ? { onTitleGenerated: (session) => materials.onTitleGenerated?.(session) } : {}),
    ...(materials.floatingNotificationManager ? { notify: wrapNotify(materials.floatingNotificationManager) } : {})
  }
}

export function assembleInvocation(materials: AgentInvocationMaterials): {
  invocation: AgentInvocation
  ports: AgentHostPorts
} {
  const additionalContext: Record<string, unknown> = {}
  if (materials.approvalTaskDigest !== undefined) {
    additionalContext[AGENT_ADDITIONAL_CONTEXT_KEYS.approvalTaskDigest] = materials.approvalTaskDigest
  }
  if (materials.historyFacts !== undefined) {
    additionalContext[AGENT_ADDITIONAL_CONTEXT_KEYS.historyFacts] = materials.historyFacts
  }

  const invocation: AgentInvocation = {
    session: { sessionId: materials.sessionId },
    messages: {
      list: materials.messages as AgentInvocation['messages']['list'],
      ...(materials.currentUserMessageId !== undefined ? { currentUserMessageId: materials.currentUserMessageId } : {}),
      ...(materials.assistantMessageId !== undefined ? { assistantMessageId: materials.assistantMessageId } : {}),
      ...(materials.hasImageAttachments !== undefined ? { hasImageAttachments: materials.hasImageAttachments } : {})
    },
    profile: {
      model: materials.model,
      ...(materials.llmServiceId !== undefined ? { llmServiceId: materials.llmServiceId } : {}),
      ...(materials.contextWindow !== undefined ? { contextWindow: materials.contextWindow } : {}),
      ...(materials.baseUrl !== undefined ? { baseUrl: materials.baseUrl } : {}),
      ...(materials.system !== undefined ? { system: materials.system } : {}),
      ...(materials.options !== undefined ? { options: materials.options } : {}),
      ...(materials.locale !== undefined ? { locale: materials.locale } : {}),
      ...(materials.projectMemoryEnabled !== undefined ? { projectMemoryEnabled: materials.projectMemoryEnabled } : {}),
      ...(materials.skillFragments !== undefined ? { skillFragments: materials.skillFragments } : {}),
      tools: {
        toolsConfig: materials.toolsConfig,
        ...(materials.browserConfig !== undefined ? { browserConfig: materials.browserConfig } : {}),
        ...(materials.shellConfig !== undefined ? { shellConfig: materials.shellConfig } : {}),
        ...(materials.wikiConfig !== undefined ? { wikiConfig: materials.wikiConfig } : {}),
        ...(materials.feishuConfig !== undefined ? { feishuConfig: materials.feishuConfig } : {}),
        ...(materials.wechatConfig !== undefined ? { wechatConfig: materials.wechatConfig } : {}),
        ...(materials.larkCliRunner !== undefined ? { larkCliRunner: materials.larkCliRunner } : {})
      },
      ...(materials.lane !== undefined ? { lane: materials.lane } : {})
    },
    events: buildEventSink(materials),
    limits: {
      ...(materials.maxToolLoopRounds !== undefined ? { maxToolRounds: materials.maxToolLoopRounds } : {})
    },
    safety: {
      ...(materials.internalConfirmExemption !== undefined ? { recursionGuard: materials.internalConfirmExemption } : {})
    },
    additionalContext,
    trace: {
      requestId: materials.requestId,
      ...(materials.turnId !== undefined ? { turnId: materials.turnId } : {}),
      ...(materials.windowId !== undefined ? { windowId: materials.windowId } : {})
    },
    ...(materials.remoteContext !== undefined ? { driverContext: materials.remoteContext } : {})
  }

  const ports: AgentHostPorts = {
    workspace: {
      workDir: materials.workDir,
      ...(materials.workDirManager !== undefined ? { workDirManager: materials.workDirManager } : {}),
      ...(materials.resolveWorkDir !== undefined ? { resolveWorkDir: materials.resolveWorkDir } : {}),
      userDataDir: materials.userDataDir
    },
    credentials: {
      resolveApiKey: () => materials.getApiKey()
    },
    ...(materials.appDb !== undefined ? { legacy: { appDb: materials.appDb } } : {}),
    ...(materials.getBrowserDetectContext !== undefined
      ? { hostFacts: { getBrowserDetectContext: () => materials.getBrowserDetectContext!() } }
      : {}),
    ...(materials.appendCompactionTransaction !== undefined
      ? { storage: { appendCompactionTransaction: (start, summary) => materials.appendCompactionTransaction!(start, summary) } }
      : {}),
    ...(materials.contextMeter !== undefined ? { contextMeter: materials.contextMeter } : {}),
    ...(materials.onTurnBoundary !== undefined ? { turnBoundary: (input) => materials.onTurnBoundary!(input as never) } : {})
  }

  return { invocation, ports }
}
