import type {
  ActionClass,
  ConfirmOutcome,
  ConfirmRequest,
  ConfirmationChannel,
  OriginInfo,
  RiskLevel,
  SecurityAuditEvent
} from '../../src/shared/confirmation/types'
import { waitForToolConfirm } from '../toolConfirmRegistry'
import { ImChannel, type ImPendingInput } from './imChannel'

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
      waitForToolConfirm?: (
        requestId: string,
        toolUseId: string,
        memoryTiers?: ConfirmRequest['memoryTiers']
      ) => Promise<ToolConfirmOutcome>
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
    // 把决策层给出的记忆档位登记到 registry，供 tool:confirm-response 校验渲染端回传档位（B1）
    const outcome = await wait(this.deps.requestId, this.deps.toolUseId, req.memoryTiers)
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
 * §5.5 统一分发：按 lane 产出确认通道（桌面卡片 / IM 通道），主循环不再按链路分双叉。
 * 远程链路注入合并后的 `ImChannel` 单例与 `buildImPending`（lane 差异由调用方注入）；
 * 桌面链路需 `toolUseId`。
 */
export function channelFor(args: {
  lane: 'desktop' | 'wechat' | 'feishu'
  requestId: string
  sessionId: string
  toolName: string
  toolUseId?: string
  audit?: AuditSink
  imChannel?: ImChannel
  buildImPending?: (req: ConfirmRequest) => ImPendingInput
}): ConfirmationChannel {
  if (args.lane === 'desktop') {
    return new DesktopChannel({
      requestId: args.requestId,
      toolUseId: args.toolUseId ?? '',
      sessionId: args.sessionId,
      toolName: args.toolName,
      lane: 'desktop',
      ...(args.audit ? { audit: args.audit } : {})
    })
  }
  if (!args.imChannel || !args.buildImPending) {
    // 远程链路缺少 IM 通道实例时安全兜底为拒绝（等价原 requestToolConfirm 缺失返回 n）
    return new RejectingChannel()
  }
  return new ImRequestChannel({ imChannel: args.imChannel, buildPending: args.buildImPending })
}

/**
 * §5.4 P2：远程分支通道 —— 直接落在合并后的 ImChannel 上。
 * confirm.request / confirm.outcome 审计由 ImChannel 内部以同一 requestId 落，
 * 记N 档位经 ConfirmOutcome.memory 透传；取消沿用 PendingRequestRegistry。
 */
export class ImRequestChannel implements ConfirmationChannel {
  constructor(
    private readonly deps: {
      imChannel: ImChannel
      buildPending: (req: ConfirmRequest) => ImPendingInput
    }
  ) {}

  request(req: ConfirmRequest): Promise<ConfirmOutcome> {
    return this.deps.imChannel.request(req, this.deps.buildPending(req))
  }

  cancel(requestId: string): void {
    this.deps.imChannel.cancel(requestId)
  }
}

/** 远程链路无 IM 通道实例时的兜底通道：一律拒绝，不发送任何 IM 消息。 */
class RejectingChannel implements ConfirmationChannel {
  request(_req: ConfirmRequest): Promise<ConfirmOutcome> {
    return Promise.resolve({ kind: 'rejected' })
  }

  cancel(_requestId: string): void {
    /* 无待确认可取消 */
  }
}
