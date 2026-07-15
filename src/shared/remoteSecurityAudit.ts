/**
 * Unified remote security audit schema + sanitizer (WP8).
 * Only allowlisted fields may be persisted; secrets/pairing codes/full scripts must never land.
 */

export const REMOTE_SECURITY_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type RemoteSecurityAuditEventType =
  | 'bind_change'
  | 'bind_reject'
  | 'sender_reject'
  | 'trust_add'
  | 'trust_revoke'
  | 'script_ask'
  | 'script_deny'
  | 'script_allow_execute'
  | 'skip_confirm'
  | 'outbound_write'
  | 'budget_pause'
  | 'budget_continue'
  | 'emergency_stop'
  | 'security_reject'

export const REMOTE_SECURITY_AUDIT_EVENT_TYPES: ReadonlySet<string> = new Set<RemoteSecurityAuditEventType>([
  'bind_change',
  'bind_reject',
  'sender_reject',
  'trust_add',
  'trust_revoke',
  'script_ask',
  'script_deny',
  'script_allow_execute',
  'skip_confirm',
  'outbound_write',
  'budget_pause',
  'budget_continue',
  'emergency_stop',
  'security_reject'
])

export const REMOTE_SECURITY_AUDIT_ALLOWLIST = new Set([
  'type',
  'channel',
  'sessionId',
  'requestId',
  'toolName',
  'toolUseId',
  'timestamp',
  'status',
  'reason',
  'category',
  'maskedOwnerOpenId',
  'ownerHash',
  'commandPreview',
  'executable',
  'patterns',
  'impact',
  'count',
  'taskId'
])

const SECRET_RE =
  /(?:sk-[a-zA-Z0-9]{10,}|Bearer\s+\S+|api[_-]?key|secret|password|token|cookie)=?\S*/gi
const PAIRING_HINT_RE = /(?:绑定|bind)\s+[0-9A-HJ-NP-Z]{6,12}/gi
const CODEISH_RE = /\b[0-9A-HJ-NP-Z]{8}\b/g
const ABS_PATH_RE = /(?:\/Users\/[^\s]+|\/home\/[^\s]+|[A-Za-z]:\\[^\s]+)/g

export function sanitizeRemoteSecurityAuditValue(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value
      .replace(SECRET_RE, '[redacted]')
      .replace(PAIRING_HINT_RE, '[bind-code]')
      .replace(CODEISH_RE, (m) => (/[A-Z]/.test(m) && /\d/.test(m) ? '[code]' : m))
      .replace(ABS_PATH_RE, '[path]')
      .slice(0, 200)
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => sanitizeRemoteSecurityAuditValue(v))
  }
  if (typeof value === 'object') {
    return sanitizeRemoteSecurityAuditFields(value as Record<string, unknown>)
  }
  return String(value).slice(0, 80)
}

/**
 * Drop unknown fields; sanitize known ones. Never persists plaintext pairing codes,
 * cookies, full commands/scripts, or absolute sensitive paths.
 */
export function sanitizeRemoteSecurityAuditFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!REMOTE_SECURITY_AUDIT_ALLOWLIST.has(k)) continue
    // Explicit denylist of dangerous keys even if somehow allowlisted later
    if (/code|cookie|script|password|token|secret/i.test(k) && k !== 'commandPreview') continue
    out[k] = sanitizeRemoteSecurityAuditValue(v)
  }
  return out
}

export type RemoteSecurityAlertKind = 'bind_change' | 'trust_add' | 'security_reject_burst'

export type SecurityRejectAlertState = {
  timestamps: number[]
}

export function noteSecurityReject(
  state: SecurityRejectAlertState,
  now: number,
  windowMs = 5 * 60_000
): { shouldAlert: boolean; state: SecurityRejectAlertState } {
  const timestamps = state.timestamps.filter((t) => now - t <= windowMs)
  timestamps.push(now)
  const shouldAlert = timestamps.length === 3
  return { shouldAlert, state: { timestamps: shouldAlert ? [] : timestamps } }
}
