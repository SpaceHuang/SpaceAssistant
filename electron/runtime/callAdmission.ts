/**
 * 调用级准入——判定纯函数(B1 0a,偏差 23;基线 §7)。
 *
 * 四条硬要求:①准入不判定安全(只答「现在能不能跑」);②交互式优先于后台(优先级,非先来先服务);
 * ③不静默丢弃(处置四选一 queue/defer/degrade/reject,由调用方声明);④可观测(拒绝带 cause 落审计,
 * 由 gate 层负责)。准入只约束普通 Agent turn；安全审批由独立的 ApprovalAdmission 管理。
 *
 * 本模块零 IO、零宿主依赖:状态快照与策略显式注入,判定不改状态——
 * 状态推进(applyAdmit/applyRelease)与持久化见 storage/callAdmissionStore.ts 与 runtime/callAdmissionGate.ts。
 */

export type AdmissionLane = 'desktop' | 'wechat' | 'feishu' | 'automation'
export type AdmissionPriority = 'interactive' | 'background'
/** 处置四选一(基线 §7 硬要求 3):由调用方声明「拿不到时怎么办」。 */
export type AdmissionDisposition = 'queue' | 'defer' | 'degrade' | 'reject'
/** 普通 Agent turn 的调用角色。安全审批不进入此准入域。 */
export type AdmissionRole = 'top-level' | 'subagent'

export type AdmissionRejectionCause = 'concurrency-cap' | 'lane-concurrency-cap' | 'queue-full'

export interface AdmissionRequest {
  lane: AdmissionLane
  priority: AdmissionPriority
  role: AdmissionRole
  disposition: AdmissionDisposition
  requestId?: string
  turnId?: string
}

export interface AdmissionPolicy {
  /** 全局并发上界(interactive + background 总和)。 */
  globalMaxConcurrent: number
  /** background 子上界(防后台占满全局饿死交互式;≤ globalMaxConcurrent)。 */
  backgroundMaxConcurrent: number
  /** lane 并发配额。 */
  laneMaxConcurrent: Record<AdmissionLane, number>
  /** 排队上限(队列满时按 disposition 映射拒绝)。 */
  queueLimit: number
}

/** 默认并发策略；安全审批容量由 ApprovalAdmission 单独管理。 */
export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  globalMaxConcurrent: 100,
  backgroundMaxConcurrent: 100,
  laneMaxConcurrent: { desktop: 100, wechat: 8, feishu: 8, automation: 4 },
  queueLimit: 100
}

export interface AdmissionState {
  /** 已发票据(全局),按优先级分计;两者之和 = 全局活跃。 */
  activeInteractive: number
  activeBackground: number
  laneActive: Record<AdmissionLane, number>
  /** 当前排队数(gate 层等待队列镜像)。 */
  queued: number
}

export function emptyAdmissionState(now: number): AdmissionState {
  return {
    activeInteractive: 0,
    activeBackground: 0,
    laneActive: { desktop: 0, wechat: 0, feishu: 0, automation: 0 },
    queued: 0
  }
}

export type AdmissionVerdict =
  | { verdict: 'admit' }
  | { verdict: 'queue' }
  | { verdict: 'defer' }
  | { verdict: 'degrade' }
  | { verdict: 'reject'; cause: AdmissionRejectionCause }

/**
 * 判定纯函数(不改状态):按全局并发、后台子界与 lane 并发上限判定,
 * 资源不足时按调用方声明的处置映射(queue 上限兜底 reject queue-full)。
 */
export function judgeAdmission(
  req: AdmissionRequest,
  state: AdmissionState,
  policy: AdmissionPolicy,
  _now: number
): AdmissionVerdict {
  const activeTotal = state.activeInteractive + state.activeBackground
  const laneActive = state.laneActive[req.lane]

  if (req.priority === 'interactive') {
    if (activeTotal >= policy.globalMaxConcurrent) return shortage(req, 'concurrency-cap')
  } else {
    if (activeTotal >= policy.globalMaxConcurrent) return shortage(req, 'concurrency-cap')
    if (state.activeBackground >= Math.min(policy.backgroundMaxConcurrent, policy.globalMaxConcurrent)) {
      return shortage(req, 'concurrency-cap')
    }
  }

  if (laneActive >= policy.laneMaxConcurrent[req.lane]) {
    return shortage(req, 'lane-concurrency-cap')
  }

  return { verdict: 'admit' }
}

/** 恢复已受理身份只复核当前运行容量。 */
export function judgeResumeAdmission(
  req: AdmissionRequest,
  state: AdmissionState,
  policy: AdmissionPolicy
): AdmissionVerdict {
  const activeTotal = state.activeInteractive + state.activeBackground
  if (req.priority === 'interactive') {
    if (activeTotal >= policy.globalMaxConcurrent) return shortage(req, 'concurrency-cap')
  } else {
    if (activeTotal >= policy.globalMaxConcurrent || state.activeBackground >= Math.min(policy.backgroundMaxConcurrent, policy.globalMaxConcurrent)) {
      return shortage(req, 'concurrency-cap')
    }
  }
  if (state.laneActive[req.lane] >= policy.laneMaxConcurrent[req.lane]) {
    return shortage(req, 'lane-concurrency-cap')
  }
  return { verdict: 'admit' }
}

/** 资源不足 → 按调用方声明处置映射;queue 受队列上限兜底(不静默丢弃)。 */
function shortage(req: AdmissionRequest, cause: AdmissionRejectionCause): AdmissionVerdict {
  switch (req.disposition) {
    case 'queue':
      return { verdict: 'queue' }
    case 'defer':
      return { verdict: 'defer' }
    case 'degrade':
      return { verdict: 'degrade' }
    case 'reject':
      return { verdict: 'reject', cause }
  }
}

/** 状态推进:占位(票据发出)。调用前提:judge 已 admit 或排队唤醒后复核通过。 */
export function applyAdmit(state: AdmissionState, req: AdmissionRequest): AdmissionState {
  return {
    ...state,
    activeInteractive: state.activeInteractive + (req.priority === 'interactive' ? 1 : 0),
    activeBackground: state.activeBackground + (req.priority === 'background' ? 1 : 0),
    laneActive: { ...state.laneActive, [req.lane]: state.laneActive[req.lane] + 1 }
  }
}

/** 恢复已受理任务的运行槽。 */
export function applyResume(state: AdmissionState, req: AdmissionRequest): AdmissionState {
  return {
    ...state,
    activeInteractive: state.activeInteractive + (req.priority === 'interactive' ? 1 : 0),
    activeBackground: state.activeBackground + (req.priority === 'background' ? 1 : 0),
    laneActive: { ...state.laneActive, [req.lane]: state.laneActive[req.lane] + 1 }
  }
}

/** 状态推进:释放票据。 */
export function applyRelease(state: AdmissionState, req: AdmissionRequest): AdmissionState {
  return {
    ...state,
    activeInteractive: Math.max(0, state.activeInteractive - (req.priority === 'interactive' ? 1 : 0)),
    activeBackground: Math.max(0, state.activeBackground - (req.priority === 'background' ? 1 : 0)),
    laneActive: { ...state.laneActive, [req.lane]: Math.max(0, state.laneActive[req.lane] - 1) }
  }
}
