/**
 * Shared IM confirm reply protocol for Feishu / WeChat.
 * Requires explicit confirmId: Y|N <confirmId>, Y <confirmId> TRUST.
 * Bare Y/N never executes.
 */

import type { MemoryTier } from '../../src/shared/confirmation/types'

export type ImConfirmReply =
  | { kind: 'approve'; confirmId: string }
  | { kind: 'approve_and_trust'; confirmId: string }
  /** 记N <id>：确认并记住第 N 档（编号对应 memoryTiers 顺序）。 */
  | { kind: 'remember'; confirmId: string; tier: number }
  | { kind: 'reject'; confirmId: string }
  | { kind: 'trust_misclick' }
  | { kind: 'usage_hint' }
  | { kind: 'not_confirm' }

const CONFIRM_ID_RE = /^[0-9]{2}$/

export function parseImConfirmReply(raw: string): ImConfirmReply {
  const text = raw.trim()
  if (!text) return { kind: 'not_confirm' }

  if (text === '信任') return { kind: 'trust_misclick' }

  // Bare Y/N / synonyms without confirmId → usage hint (do not execute)
  const bareLower = text.toLowerCase()
  if (
    bareLower === 'y' ||
    bareLower === 'yes' ||
    bareLower === 'n' ||
    bareLower === 'no' ||
    text === '是' ||
    text === '确认' ||
    text === '否' ||
    text === '取消' ||
    bareLower === 'y trust' ||
    bareLower === 'yes trust' ||
    text === '确认并信任'
  ) {
    return { kind: 'usage_hint' }
  }

  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length < 2) {
    if (/^(y|yes|n|no|确认|是|否|取消)/i.test(text) || /^信任/.test(text)) {
      return { kind: 'usage_hint' }
    }
    return { kind: 'not_confirm' }
  }

  const verb = parts[0]!.toLowerCase()
  const idRaw = parts[1]!
  if (!CONFIRM_ID_RE.test(idRaw)) {
    if (/^(y|yes|n|no|确认)/i.test(text)) return { kind: 'usage_hint' }
    return { kind: 'not_confirm' }
  }
  const confirmId = idRaw.toUpperCase()

  // 记N <id> / N <id>：确认并记住第 N 档（memoryTiers 编号）。
  // 数字简写是 IM 用户常用格式；第二项仍必须是两位确认码。
  const remember = parts[0]!.match(/^记(\d+)$/) ?? parts[0]!.match(/^(\d+)$/)
  if (remember && parts.length === 2 && CONFIRM_ID_RE.test(idRaw)) {
    return { kind: 'remember', confirmId, tier: Number(remember[1]) }
  }
  if (remember && parts.length !== 2) return { kind: 'usage_hint' }

  // Y <id> TRUST / 确认 <id> 并信任
  if (parts.length >= 3) {
    const rest = parts.slice(2).join(' ').toLowerCase()
    if (
      (verb === 'y' || verb === 'yes' || parts[0] === '确认' || parts[0] === '是') &&
      (rest === 'trust' || rest === '并信任' || rest === '确认并信任')
    ) {
      return { kind: 'approve_and_trust', confirmId }
    }
  }

  if (parts.length > 2) return { kind: 'usage_hint' }

  if (verb === 'y' || verb === 'yes' || parts[0] === '是' || parts[0] === '确认') {
    return { kind: 'approve', confirmId }
  }
  if (verb === 'n' || verb === 'no' || parts[0] === '否' || parts[0] === '取消') {
    return { kind: 'reject', confirmId }
  }

  if (/^(y|yes|确认)/i.test(text) || /^信任/.test(text)) return { kind: 'usage_hint' }
  return { kind: 'not_confirm' }
}

export const IM_CONFIRM_USAGE_HINT =
  '请先引用当前确认提示，再回复 Y <两位确认码> 确认、N <两位确认码> 取消，或 Y <两位确认码> TRUST（将命令写入信任列表）。裸 Y/N 无效。'

export const IM_CONFIRM_TRUST_MISCLICK_HINT =
  '单独回复「信任」不会批准也不会写入信任列表。请引用当前确认提示，再回复 Y <两位确认码> 仅批准本次，或 Y <两位确认码> TRUST。'

export const IM_CONFIRM_PROMPT_SENDING_HINT = '确认提示仍在发送，请稍后引用该提示重试。'
export const IM_CONFIRM_QUOTE_REQUIRED_HINT = '请引用当前确认提示，再发送确认命令。未引用该提示的回复不会生效。'

export function formatImConfirmPromptFooter(opts?: {
  trustEligible?: boolean
  confirmId?: string
  memoryTiers?: MemoryTier[]
}): string {
  const id = opts?.confirmId ? ` ${opts.confirmId}` : ' <两位确认码>'
  const base =
    opts?.trustEligible === false
      ? `引用本条确认提示，再回复 Y${id} 确认，N${id} 取消`
      : `引用本条确认提示，再回复 Y${id} 确认，N${id} 取消，或 Y${id} TRUST`
  const tiers = opts?.memoryTiers
  if (!tiers || tiers.length === 0) return base
  // 记忆档位：用户可回复 `N <确认码>`，编号对应 memoryTiers 顺序。
  const tierText = tiers.map((m, i) => `${i + 1}${id} ${m.label}`).join('；')
  if (opts?.trustEligible === false) {
    return `引用本条确认提示，再回复 Y${id} 确认，N${id} 取消，或 ${tierText}`
  }
  return `引用本条确认提示，再回复 Y${id} 确认，N${id} 取消，或 Y${id} TRUST；${tierText}`
}
