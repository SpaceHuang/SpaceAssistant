/**
 * Shared IM confirm reply protocol for Feishu / WeChat (remote private-chat security).
 * Case-insensitive; trim before match.
 */

export type ImConfirmReply =
  | { kind: 'approve' }
  | { kind: 'approve_and_trust' }
  | { kind: 'reject' }
  | { kind: 'trust_misclick' }
  | { kind: 'usage_hint' }
  | { kind: 'not_confirm' }

const APPROVE = new Set(['y', 'yes', '是', '确认'])
const REJECT = new Set(['n', 'no', '否', '取消'])
const APPROVE_TRUST = new Set(['y trust', 'yes trust', '确认并信任'])

export function parseImConfirmReply(raw: string): ImConfirmReply {
  const text = raw.trim()
  if (!text) return { kind: 'not_confirm' }
  const lower = text.toLowerCase()

  if (text === '信任') return { kind: 'trust_misclick' }
  if (APPROVE_TRUST.has(lower) || APPROVE_TRUST.has(text)) return { kind: 'approve_and_trust' }
  if (APPROVE.has(lower) || APPROVE.has(text)) return { kind: 'approve' }
  if (REJECT.has(lower) || REJECT.has(text)) return { kind: 'reject' }

  // Lookalike trust phrases that are not exact protocol → usage hint if starts with confirm family
  if (/^(y|yes|确认)/i.test(text) || /^信任/.test(text)) return { kind: 'usage_hint' }

  return { kind: 'not_confirm' }
}

export const IM_CONFIRM_USAGE_HINT =
  '请回复 Y 确认、N 取消，或回复「确认并信任」/ Y trust（将命令写入信任列表）。单独回复「信任」无效。'

export const IM_CONFIRM_TRUST_MISCLICK_HINT =
  '单独回复「信任」不会批准也不会写入信任列表。请回复 Y 仅批准本次，或「确认并信任」/ Y trust。'

export function formatImConfirmPromptFooter(opts?: { trustEligible?: boolean }): string {
  if (opts?.trustEligible === false) {
    return '回复 Y 确认，N 取消'
  }
  return '回复 Y 确认，N 取消，或「确认并信任」/ Y trust'
}
