/**
 * Shared IM confirm reply protocol for Feishu / WeChat.
 * Requires explicit confirmId: Y|N <confirmId>, Y <confirmId> TRUST.
 * Bare Y/N never executes.
 */

export type ImConfirmReply =
  | { kind: 'approve'; confirmId: string }
  | { kind: 'approve_and_trust'; confirmId: string }
  | { kind: 'reject'; confirmId: string }
  | { kind: 'trust_misclick' }
  | { kind: 'usage_hint' }
  | { kind: 'not_confirm' }

const CONFIRM_ID_RE = /^[0-9A-HJKMNP-TV-Z]{4}$/i

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
  '请回复 Y <确认码> 确认、N <确认码> 取消，或 Y <确认码> TRUST（将命令写入信任列表）。裸 Y/N 无效。'

export const IM_CONFIRM_TRUST_MISCLICK_HINT =
  '单独回复「信任」不会批准也不会写入信任列表。请回复 Y <确认码> 仅批准本次，或 Y <确认码> TRUST。'

export function formatImConfirmPromptFooter(opts?: {
  trustEligible?: boolean
  confirmId?: string
}): string {
  const id = opts?.confirmId ? ` ${opts.confirmId}` : ' <确认码>'
  if (opts?.trustEligible === false) {
    return `回复 Y${id} 确认，N${id} 取消`
  }
  return `回复 Y${id} 确认，N${id} 取消，或 Y${id} TRUST`
}
