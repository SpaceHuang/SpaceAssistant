import type { BrowserConfig } from '../../src/shared/domainTypes'
import type {
  ActDangerAssessment,
  ActDangerConsequence,
  ActFillPreview
} from './browserActionPolicy'
import { keywordToConsequence, matchHighRiskKeyword } from './browserActionPolicy'
import type { StagehandService } from './stagehandService'
import { extractHostname } from './urlSecurity'

export type PageEffectScan = {
  hasDangerousControl: boolean
  signals: string[]
}

export type ElementEffect = {
  href: string
  formAction: string
  label: string
  type: string
}

const DANGER_LABEL_WORDS = [
  '提交', '支付', '付款', '转账', '结账', '删除', '移除', '清空',
  '确认订单', '提交订单', '登录', '注销', '上传', '下载', '安装', '卸载',
  'submit', 'pay', 'payment', 'transfer', 'checkout', 'delete', 'remove', 'clear',
  'login', 'logout', 'sign in', 'sign out', 'register', 'upload', 'download', 'install', 'uninstall'
]

function labelHasDangerWord(label: string): boolean {
  const lower = label.toLowerCase()
  return DANGER_LABEL_WORDS.some((w) => lower.includes(w.toLowerCase()))
}

export function isDangerousElementEffect(
  eff: ElementEffect,
  pageUrl: string
): boolean {
  if (eff.href) {
    try {
      const u = new URL(eff.href, pageUrl)
      const pageOrigin = new URL(pageUrl).origin
      if (u.origin !== pageOrigin) return true
    } catch {
      /* ignore */
    }
  }
  if (eff.formAction) {
    try {
      const u = new URL(eff.formAction, pageUrl)
      const pageOrigin = new URL(pageUrl).origin
      if (u.origin !== pageOrigin) return true
    } catch {
      /* ignore */
    }
  }
  if (labelHasDangerWord(eff.label)) return true
  if (eff.type === 'submit') return true
  return false
}

export function elementEffectToUserReason(eff: ElementEffect, pageUrl: string): string {
  if (eff.href) {
    try {
      const u = new URL(eff.href, pageUrl)
      const pageOrigin = new URL(pageUrl).origin
      if (u.origin !== pageOrigin) {
        return `跳转到其他网站 ${u.host}`
      }
    } catch {
      /* ignore */
    }
  }
  if (eff.formAction) {
    try {
      const u = new URL(eff.formAction, pageUrl)
      return `提交订单到 ${u.host}`
    } catch {
      /* ignore */
    }
  }
  if (eff.label) {
    return `点击了「${eff.label.slice(0, 40)}」按钮`
  }
  return '该操作较为敏感'
}

export function elementEffectToConsequence(eff: ElementEffect, pageUrl: string): ActDangerConsequence {
  if (eff.href) {
    try {
      const u = new URL(eff.href, pageUrl)
      const pageOrigin = new URL(pageUrl).origin
      if (u.origin !== pageOrigin) return 'unknown-site'
    } catch {
      /* ignore */
    }
  }
  if (labelHasDangerWord(eff.label)) {
    const lower = eff.label.toLowerCase()
    if (['删除', '移除', '清空', 'delete', 'remove', 'clear'].some((w) => lower.includes(w))) {
      return 'data-loss'
    }
    if (['支付', '付款', '转账', 'pay', 'payment', 'transfer', '提交', 'submit', '订单', 'order'].some((w) => lower.includes(w))) {
      return 'money'
    }
    if (['登录', '登出', 'login', 'logout', 'sign in', 'sign out', 'register', '注册'].some((w) => lower.includes(w))) {
      return 'account'
    }
    if (['上传', '下载', 'upload', 'download'].some((w) => lower.includes(w))) {
      return 'file'
    }
  }
  if (eff.formAction) return 'money'
  return 'generic'
}

export function pageEffectToUserReason(scan: PageEffectScan): string {
  const first = scan.signals[0] ?? ''
  if (first.includes('跨域链接')) {
    const match = first.match(/→\s*(\S+)/)
    return match ? `跳转到其他网站 ${match[1]}` : '该页面含跳转链接'
  }
  if (first.includes('外部表单')) return '该页面含提交类控件'
  if (first.includes('危险按钮')) {
    const label = first.replace(/^危险按钮:\s*/, '')
    return `点击了「${label.slice(0, 40)}」按钮`
  }
  if (first.includes('文件上传/下载')) return '该页面含文件上传或下载控件'
  return '该页面含敏感控件'
}

export function pageEffectToConsequence(scan: PageEffectScan): ActDangerConsequence {
  const first = scan.signals[0] ?? ''
  if (first.includes('跨域链接') || first.includes('外部表单')) {
    if (first.includes('跨域链接')) return 'unknown-site'
    return 'money'
  }
  if (first.includes('危险按钮')) {
    const label = first.replace(/^危险按钮:\s*/, '').toLowerCase()
    if (['删除', 'remove', 'delete', 'clear'].some((w) => label.includes(w))) return 'data-loss'
    if (['支付', 'pay', 'submit', '提交', '订单'].some((w) => label.includes(w))) return 'money'
    if (['登录', 'login', 'logout'].some((w) => label.includes(w))) return 'account'
    if (['上传', '下载', 'upload', 'download'].some((w) => label.includes(w))) return 'file'
  }
  if (first.includes('文件上传/下载')) return 'file'
  return 'generic'
}

const SAFE: ActDangerAssessment = {
  dangerous: false,
  source: undefined,
  userReason: '',
  consequence: undefined
}

const UNCERTAIN_ASK: ActDangerAssessment = {
  dangerous: true,
  source: 'page-effect',
  userReason: '无法可靠判断本次页面操作风险，需确认后继续',
  consequence: 'generic',
  detail: 'assess_uncertain'
}

export type AssessActDangerOptions = {
  /** When true (remote low-friction path), scan/target failures ask instead of SAFE. */
  failClosedOnUncertainty?: boolean
}

export async function assessActDanger(
  sessionId: string,
  input: Record<string, unknown>,
  cfg: BrowserConfig,
  stagehand: StagehandService,
  signal?: AbortSignal,
  opts?: AssessActDangerOptions
): Promise<ActDangerAssessment> {
  const instruction = typeof input.instruction === 'string' ? input.instruction : ''
  if (!instruction.trim() && opts?.failClosedOnUncertainty) {
    return UNCERTAIN_ASK
  }
  const keywords = cfg.actHighRiskKeywords ?? []

  const kw = matchHighRiskKeyword(instruction, keywords)
  if (kw) {
    return {
      dangerous: true,
      source: 'keyword',
      userReason: `指令提到「${kw}」`,
      consequence: keywordToConsequence(kw),
      detail: kw
    }
  }

  // Instruction-only high-impact always ask (submit/pay/delete/auth/account)
  const highImpactRe =
    /提交|发送|购买|支付|付款|删除|授权|账号|权限|结账|转账|submit|send|purchase|pay|delete|auth|account|permission/i
  if (highImpactRe.test(instruction)) {
    return {
      dangerous: true,
      source: 'keyword',
      userReason: '高影响操作，需确认后继续',
      consequence: keywordToConsequence(instruction) ?? 'generic',
      detail: 'high_impact_instruction'
    }
  }

  let pageEffect: PageEffectScan
  try {
    pageEffect = await stagehand.scanPageEffect(sessionId)
  } catch {
    return opts?.failClosedOnUncertainty ? UNCERTAIN_ASK : SAFE
  }
  if (!pageEffect.hasDangerousControl) {
    return SAFE
  }

  try {
    const candidates = await stagehand.observeActCandidates(
      sessionId,
      instruction,
      cfg.maxInferencesPerRequest,
      signal
    )
    const targetHit = await stagehand.resolveCandidateEffect(sessionId, candidates)
    if (targetHit?.hit) {
      return {
        dangerous: true,
        source: 'target-effect',
        userReason: targetHit.summary,
        consequence: targetHit.consequence,
        detail: targetHit.summary,
        fillPreview: targetHit.fillPreview
      }
    }
    return opts?.failClosedOnUncertainty ? UNCERTAIN_ASK : SAFE
  } catch {
    return {
      dangerous: true,
      source: 'page-effect',
      userReason: pageEffectToUserReason(pageEffect),
      consequence: pageEffectToConsequence(pageEffect),
      detail: pageEffect.signals[0]
    }
  }
}

export function extractHostnameFromPageUrl(pageUrl: string): string | null {
  return extractHostname(pageUrl)
}
