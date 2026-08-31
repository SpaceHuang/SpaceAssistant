import type {
  ActionClass,
  ConfirmOutcome,
  ConfirmRequest,
  ConfirmationChannel,
  OriginInfo,
  RiskLevel,
  SecurityAuditEvent
} from '../../src/shared/confirmation/types'
import type { RemoteConfirmDecision } from '../tools/types'
import { waitForToolConfirm } from '../toolConfirmRegistry'

export type ToolConfirmOutcome = 'approved' | 'rejected' | 'timeout'

/** 最小审计出口：由 SecurityAuditLog 实现，或测试中注入假实现。 */
export interface AuditSink {
  record(event: SecurityAuditEvent): void
}

function mapToolOutcome(outcome: ToolConfirmOutcome): ConfirmOutcome {
  if (outcome === 'approved') return { kind: 'approved' }
  if (outcome === 'timeout') return { kind: 'timeout' }
  return { kind: 'rejected' }
}

function mapRemoteDecision(decision: RemoteConfirmDecision): ConfirmOutcome {
  if (decision === 'y') return { kind: 'approved' }
  if (decision === 'timeout') return { kind: 'timeout' }
  return { kind: 'rejected' }
}

function eventBase(deps: {
  requestId: string
  sessionId: string
  toolName: string
  lane: 'desktop' | 'wechat' | 'feishu'
  origin?: OriginInfo
  actionClass?: ActionClass
  riskLevel?: RiskLevel
}): Pick<SecurityAuditEvent, 'requestId' | 'sessionId' | 'toolName' | 'lane' | 'origin' | 'actionClass' | 'riskLevel' | 'actor'> {
  return {
    requestId: deps.requestId,
    sessionId: deps.sessionId,
    toolName: deps.toolName,
    lane: deps.lane,
    origin: deps.origin,
    actionClass: deps.actionClass,
    riskLevel: deps.riskLevel,
    actor: 'system'
  }
}

/**
 * 桌面确认通道：包装现 `toolConfirmRegistry` + `tool:confirm-request` 卡片（P1 交互保持不变）。
 * 落 `confirm.request` / `confirm.outcome` 审计事件（同一 requestId 关联）。
 */
export class DesktopChannel implements ConfirmationChannel {
  constructor(
    private readonly deps: {
      requestId: string
      toolUseId: string
      sessionId: string
      toolName: string
      lane: 'desktop'
      origin?: OriginInfo
      actionClass?: ActionClass
      riskLevel?: RiskLevel
      audit?: AuditSink
      waitForToolConfirm?: (requestId: string, toolUseId: string) => Promise<ToolConfirmOutcome>
    }
  ) {}

  async request(req: ConfirmRequest): Promise<ConfirmOutcome> {
    const base = eventBase({ ...this.deps, lane: 'desktop' })
    this.deps.audit?.record({
      ...base,
      event: 'confirm.request',
      ts: Date.now(),
      factsSummary: req.facts.summary.text,
      signals: req.facts.signals.map((s) => s.kind)
    })
    const wait = this.deps.waitForToolConfirm ?? waitForToolConfirm
    const outcome = await wait(this.deps.requestId, this.deps.toolUseId)
    this.deps.audit?.record({
      ...base,
      event: 'confirm.outcome',
      ts: Date.now(),
      outcome: outcome
    })
    return mapToolOutcome(outcome)
  }

  cancel(_requestId: string): void {
    /* 桌面通道沿用 registry 的取消机制，无需额外处理 */
  }
}

/**
 * P1 过渡态：LegacyImChannel —— 薄包装现有远程确认路径（经 remoteConfirmBridge 的
 * requestToolConfirm），实现 ConfirmationChannel 接口、行为零变化，并落 confirm.* 审计事件。
 * P2 将由合并后的 ImChannel 替换。
 */
export class LegacyImChannel implements ConfirmationChannel {
  constructor(
    private readonly deps: {
      requestId: string
      sessionId: string
      toolName: string
      lane: 'wechat' | 'feishu'
      origin?: OriginInfo
      actionClass?: ActionClass
      riskLevel?: RiskLevel
      audit?: AuditSink
      /** 实际发起 IM 确认的函数（注入现有 requestToolConfirm / requestRemoteConfirm）。 */
      send: () => Promise<RemoteConfirmDecision>
    }
  ) {}

  async request(req: ConfirmRequest): Promise<ConfirmOutcome> {
    const base = eventBase({ ...this.deps, lane: this.deps.lane })
    this.deps.audit?.record({
      ...base,
      event: 'confirm.request',
      ts: Date.now(),
      factsSummary: req.facts.summary.text,
      signals: req.facts.signals.map((s) => s.kind)
    })
    const decision = await this.deps.send()
    this.deps.audit?.record({
      ...base,
      event: 'confirm.outcome',
      ts: Date.now(),
      outcome: decision === 'y' ? 'approved' : decision === 'n' ? 'rejected' : 'timeout'
    })
    return mapRemoteDecision(decision)
  }

  cancel(_requestId: string): void {
    /* IM 通道取消沿用 PendingRequestRegistry 机制 */
  }
}
