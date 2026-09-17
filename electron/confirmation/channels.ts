import type {
  ActionClass,
  ConfirmAnswererPolicy,
  ConfirmOutcome,
  ConfirmOutcomeCause,
  ConfirmRequest,
  ConfirmationChannel,
  ExecutionLane,
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
  if (outcome === 'approved') return { kind: 'approved', cause: 'user-approved' }
  if (outcome === 'timeout') return { kind: 'timeout', cause: 'timeout' }
  return { kind: 'rejected', cause: 'user-denied' }
}

function eventBase(deps: {
  requestId: string
  sessionId: string
  toolName: string
  lane: ExecutionLane
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
    // B1 归因口径：confirm.request / confirm.outcome 归因于回答动作——桌面卡片回答者恒为用户
    actor: 'user'
  }
}

/**
 * 桌面确认通道：包装现 `toolConfirmRegistry` 与 projection 驱动的确认卡片（P1 交互保持不变）。
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
        memoryTiers?: ConfirmRequest['memoryTiers'],
        scope?: { toolName: string; lane: string },
        timeoutMs?: number
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
    // P1-4：ConfirmRequest.timeoutMs 真实消费；null/缺省回退 registry 的 CONFIRM_MS（5min，user 默认不变）
    const outcome = await wait(
      this.deps.requestId,
      this.deps.toolUseId,
      req.memoryTiers,
      {
        toolName: this.deps.toolName,
        lane: this.deps.lane
      },
      req.timeoutMs ?? undefined
    )
    const mapped = mapToolOutcome(outcome)
    this.deps.audit?.record({
      ...base,
      event: 'confirm.outcome',
      ts: Date.now(),
      outcome: outcome,
      cause: mapped.cause,
      // 超时无回答动作，actor 如实为 system；批准/拒绝归因桌面用户（B1）
      actor: outcome === 'timeout' ? 'system' : 'user'
    })
    return mapped
  }

  cancel(_requestId: string): void {
    /* 桌面通道沿用 registry 的取消机制，无需额外处理 */
  }
}

/**
 * §5.5 统一分发（既有入口，P1 起转调 resolveConfirmChannel 二维模型，保持签名兼容）：
 * 远程链路注入合并后的 `ImChannel` 单例与 `buildImPending`（lane 差异由调用方注入）；
 * 桌面链路需 `toolUseId`。
 */
export function channelFor(args: {
  lane: ExecutionLane
  requestId: string
  sessionId: string
  toolName: string
  toolUseId?: string
  audit?: AuditSink
  imChannel?: ImChannel
  buildImPending?: (req: ConfirmRequest) => ImPendingInput
}): ConfirmationChannel {
  return resolveConfirmChannel(args)
}

/** lane → 默认回答者（I1 默认值表）。automation 在 P2-6 切换为 agent（单行可回退）。 */
export const DEFAULT_CONFIRM_ANSWERER: Record<ExecutionLane, ConfirmAnswererPolicy> = {
  desktop: { kind: 'user' },
  wechat: { kind: 'user' },
  feishu: { kind: 'user' },
  automation: { kind: 'deny' }
}

export interface ResolveConfirmChannelArgs {
  lane: ExecutionLane
  requestId: string
  sessionId: string
  toolName: string
  toolUseId?: string
  audit?: AuditSink
  imChannel?: ImChannel
  buildImPending?: (req: ConfirmRequest) => ImPendingInput
  /** 维度一：回答者配置（主进程装配方按 lane 解析后传入；缺省用默认值表）。 */
  answererPolicy?: ConfirmAnswererPolicy
  /** kind='agent' 的通道工厂（P2 注入 AgentChannel 构造；未注入而配置了 agent → fail-closed）。 */
  agentChannelFactory?: (deps: {
    lane: ExecutionLane
    requestId: string
    sessionId: string
    toolName: string
    policy: ConfirmAnswererPolicy
    audit?: AuditSink
  }) => ConfirmationChannel
  /** deny 回答者在 IM 传输下的用户可见回执出口（桌面静默拒绝不传）。 */
  notifyDenied?: (req: ConfirmRequest) => void
}

/**
 * P1-1 二维解析模型（评审 B2）：
 *  - 维度一「回答者种类」（user / agent / deny）由回答者配置解析，替代按 lane 硬编码；
 *  - 维度二「传输通道」（desktop 窗口卡 / IM 出站）由 lane 与注入的 imChannel 派生。
 * fail-closed（I4）：配置损坏、kind='agent' 无工厂 → DenyChannel + 告警审计，绝不回退为 user。
 */
export function resolveConfirmChannel(args: ResolveConfirmChannelArgs): ConfirmationChannel {
  const answerer = args.answererPolicy ?? DEFAULT_CONFIRM_ANSWERER[args.lane]
  const isLaneWithImTransport = args.lane === 'wechat' || args.lane === 'feishu'

  // 配置损坏：kind 非法 → deny + 告警（绝不回退 user）
  if (answerer.kind !== 'user' && answerer.kind !== 'agent' && answerer.kind !== 'deny') {
    return denyFallback(args, 'config-error', `未知回答者配置 kind=${String((answerer as { kind?: unknown }).kind)}`)
  }

  if (answerer.kind === 'agent') {
    if (!args.agentChannelFactory) {
      return denyFallback(args, 'config-error', '回答者配置为 agent 但审批通道工厂未接线')
    }
    return args.agentChannelFactory({
      lane: args.lane,
      requestId: args.requestId,
      sessionId: args.sessionId,
      toolName: args.toolName,
      policy: answerer,
      ...(args.audit ? { audit: args.audit } : {})
    })
  }

  if (answerer.kind === 'deny') {
    return new DenyChannel({
      lane: args.lane,
      requestId: args.requestId,
      sessionId: args.sessionId,
      toolName: args.toolName,
      cause: 'no-answerer',
      // deny 的用户可见形态按传输区分：IM 回拒绝说明，桌面静默拒绝（工具结果带理由）
      ...(isLaneWithImTransport && args.notifyDenied ? { notifyDenied: args.notifyDenied } : {}),
      ...(args.audit ? { audit: args.audit } : {})
    })
  }

  // user 按传输维度落实现（现状等价）
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
    return new DenyChannel({ lane: args.lane, cause: 'no-answerer' })
  }
  return new ImRequestChannel({ imChannel: args.imChannel, buildPending: args.buildImPending })
}

/** fail-closed 兜底：产出 DenyChannel 并落告警审计（仅异常配置路径）。 */
function denyFallback(args: ResolveConfirmChannelArgs, cause: ConfirmOutcomeCause, detail: string): DenyChannel {
  args.audit?.record({
    ts: Date.now(),
    event: 'confirm.answerer-fallback',
    lane: args.lane,
    sessionId: args.sessionId,
    requestId: args.requestId,
    toolName: args.toolName,
    reason: detail,
    cause,
    actor: 'system'
  })
  return new DenyChannel({
    lane: args.lane,
    requestId: args.requestId,
    sessionId: args.sessionId,
    toolName: args.toolName,
    cause,
    ...(args.audit ? { audit: args.audit } : {})
  })
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

/**
 * P1-1 DenyChannel：deny 回答者 / 无回答者兜底通道——一律拒绝，不发送任何确认请求。
 * cause 可区分 no-answerer（无回答者）与 config-error（配置损坏 / agent 未接线）；
 * IM 传输下可注入 notifyDenied 回执（不静默吞掉远端用户的等待）。
 */
export class DenyChannel implements ConfirmationChannel {
  constructor(
    private readonly deps: {
      lane: ExecutionLane
      requestId?: string
      sessionId?: string
      toolName?: string
      cause?: ConfirmOutcomeCause
      audit?: AuditSink
      notifyDenied?: (req: ConfirmRequest) => void
    }
  ) {}

  request(req: ConfirmRequest): Promise<ConfirmOutcome> {
    const cause = this.deps.cause ?? 'no-answerer'
    if (this.deps.audit) {
      this.deps.audit.record({
        ts: Date.now(),
        event: 'confirm.outcome',
        lane: this.deps.lane,
        sessionId: this.deps.sessionId ?? '',
        requestId: this.deps.requestId,
        toolName: this.deps.toolName,
        outcome: 'rejected',
        ...(cause === 'no-answerer' ? { reason: 'no-answerer' } : {}),
        cause,
        // deny / 无回答者：本次没有回答动作，actor 如实为 system（B1：不占「谁批的」用户口径）
        actor: 'system'
      })
    }
    this.deps.notifyDenied?.(req)
    return Promise.resolve({ kind: 'rejected', cause })
  }

  cancel(_requestId: string): void {
    /* 无待确认可取消 */
  }
}
