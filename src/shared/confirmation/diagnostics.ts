/**
 * R2：拒绝与失败的结构化诊断契约（Safety 产出、Core 回传、Driver 渲染）。
 *
 * 主进程只产 `messageKey + messageParams`（§2.4 规则 1：主进程不产出文案）；
 * 文案真源在 src/renderer/i18n/resources/{zh-CN,en-US}。
 * 三类拒绝的判定规则写进策略层（denyClass），不靠文案区分：
 * - forbidden：无条件不允许（提权、磁盘级破坏、locked 底线规则）——建议不得引导绕行
 * - insufficient-info：需补信息/授权才能判（用途不明、目标不明、载荷不全）——补入参可重试
 * - out-of-bounds：目标超出基准范围——文案必须写出基准目录
 */
import type { ConfirmOutcomeCause, PathZone } from './types'
import type { WorkspaceSnapshot } from '../agent/workspace'

export type DenyClass = 'forbidden' | 'insufficient-info' | 'out-of-bounds'

export type DenyRuleSource = 'builtin' | 'package' | 'user-override' | 'migration'

export type DenySuggestionAction =
  | 'provide-path'
  | 'provide-purpose'
  | 'narrow-scope'
  | 'use-trusted-route'
  | 'ask-user'

export interface SafetyDiagnosticsBasis {
  kind: 'workdir'
  workDir: string
  profileId: string
  revision: number
  source: WorkspaceSnapshot['source']
}

export interface SafetyDiagnosticTarget {
  raw: string
  resolved: string
  zone: PathZone
}

export interface SafetyDiagnostics {
  /** 命中规则：policy rule id 或 shell validator id（两者同字段，避免两套口径） */
  ruleId: string
  ruleSource: DenyRuleSource
  denyClass: DenyClass
  /** 判定基准：working directory 快照（R1）+ 敏感路径集合的来源 */
  basis: SafetyDiagnosticsBasis
  /** 解析后的目标（可多个：一条命令里的多个字面量） */
  targets: SafetyDiagnosticTarget[]
  /** 阈值 / 约束（超长、超量、超预算时） */
  threshold?: { name: string; value: string | number; limit: string | number }
  /** 建议动作：可枚举、可被模型直接执行 */
  suggestions: Array<{ action: DenySuggestionAction; params?: Record<string, string> }>
  /** 规则拒绝一律落既有 'rules-violated'（评审 P2-2：不引入与既有枚举重叠的第三套口径） */
  cause: ConfirmOutcomeCause
  messageKey: string
  messageParams: Record<string, string | number>
}

/** 三类拒绝的文案键（互不相同，T-R2-3） */
export function denyClassMessageKey(denyClass: DenyClass): string {
  switch (denyClass) {
    case 'forbidden':
      return 'deny.forbidden.rule'
    case 'insufficient-info':
      return 'deny.insufficientInfo.rule'
    case 'out-of-bounds':
      return 'deny.outOfBounds.workdir'
  }
}

/**
 * 诊断构造的唯一出口。
 * - denyClass：规则声明优先；路径事实 zone=outside-workdir 时覆盖为 out-of-bounds（事实驱动）；
 *   未声明的 ask 类规则兜底 insufficient-info（ask 本质 = 需补授权/信息）。
 * - forbidden 的建议不得引导绕行（无 use-trusted-route / provide-path）。
 */
export function buildSafetyDiagnostics(input: {
  ruleId: string
  ruleSource?: DenyRuleSource
  ruleDenyClass?: DenyClass
  workspace?: WorkspaceSnapshot
  /** 无快照时的兜底基准（profileId 空、source=active-fallback） */
  workDir?: string
  targets?: SafetyDiagnosticTarget[]
  threshold?: { name: string; value: string | number; limit: string | number }
  cause?: ConfirmOutcomeCause
}): SafetyDiagnostics {
  const targets = input.targets ?? []
  const outOfBounds = targets.some((t) => t.zone === 'outside-workdir')
  const denyClass: DenyClass = outOfBounds
    ? 'out-of-bounds'
    : (input.ruleDenyClass ?? 'insufficient-info')
  const basis: SafetyDiagnosticsBasis = input.workspace
    ? {
        kind: 'workdir',
        workDir: input.workspace.rootPath,
        profileId: input.workspace.profileId,
        revision: input.workspace.revision,
        source: input.workspace.source
      }
    : {
        kind: 'workdir',
        workDir: input.workDir ?? '',
        profileId: '',
        revision: 0,
        source: 'active-fallback'
      }

  const suggestions: SafetyDiagnostics['suggestions'] = []
  switch (denyClass) {
    case 'out-of-bounds': {
      const first = targets.find((t) => t.zone === 'outside-workdir')
      suggestions.push(
        { action: 'provide-path', params: first ? { suggestedPath: basis.workDir } : undefined },
        { action: 'ask-user' }
      )
      break
    }
    case 'insufficient-info':
      suggestions.push({ action: 'provide-purpose' }, { action: 'narrow-scope' })
      break
    case 'forbidden':
      // 无条件不允许：不引导绕行（不提供 use-trusted-route / provide-path）
      suggestions.push({ action: 'ask-user' })
      break
  }

  const messageParams: Record<string, string | number> = { ruleId: input.ruleId }
  if (denyClass === 'out-of-bounds') {
    messageParams.basisWorkDir = basis.workDir
    messageParams.targetResolved = targets.find((t) => t.zone === 'outside-workdir')?.resolved ?? ''
  }

  return {
    ruleId: input.ruleId,
    ruleSource: input.ruleSource ?? 'builtin',
    denyClass,
    basis,
    targets,
    ...(input.threshold ? { threshold: input.threshold } : {}),
    suggestions,
    cause: input.cause ?? 'rules-violated',
    messageKey: denyClassMessageKey(denyClass),
    messageParams
  }
}
