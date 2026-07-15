/**
 * Feishu lark-cli argv impact classifier (WP7).
 * Classifies AFTER assertSafeLarkCliArgs tokenization — never fuzzy-match full command strings.
 * Unknown / missing args / parse failure → high-impact (ask). Low-impact writes may follow
 * larkCliWriteRequiresConfirm; high-impact always ask.
 */

export type LarkCliImpact = 'read' | 'low_write' | 'high_impact' | 'unknown'

export type LarkCliImpactResult = {
  impact: LarkCliImpact
  reason: string
  /** Stable category id for audit/detail only. */
  category?: string
}

const HIGH_MESSAGE = new Set(['group', 'chat'])
const DELETE_TOKENS = new Set(['delete', 'remove', 'batch-delete', 'batch_delete', 'destroy'])
const PERM_TOKENS = new Set(['permission', 'permissions', 'share', 'acl', 'member', 'members', 'role'])
const BATCH_TOKENS = new Set(['batch', 'bulk', 'batch-create', 'batch_create', 'batch-update', 'batch_update'])

function asStringArgv(argv: unknown): string[] | null {
  if (!Array.isArray(argv) || argv.length === 0) return null
  if (!argv.every((a): a is string => typeof a === 'string')) return null
  return argv
}

/**
 * Deterministic classifier on tokenized argv (args[0]=subcommand like message/doc/...).
 * Accepts untrusted tool input: non-arrays, empty, and non-string elements → unknown (fail closed).
 */
export function classifyLarkCliImpact(argv: unknown): LarkCliImpactResult {
  const tokens = asStringArgv(argv)
  if (!tokens) {
    if (!Array.isArray(argv) || argv.length === 0) {
      return { impact: 'unknown', reason: 'missing_argv', category: 'missing' }
    }
    return { impact: 'unknown', reason: 'non_string_argv', category: 'invalid' }
  }
  const sub = tokens[0]?.toLowerCase() ?? ''
  const rest = tokens.slice(1).map((a) => a.toLowerCase())
  const joined = rest.join(' ')

  // Read-ish verbs early
  if (rest.some((t) => t === 'get' || t === 'list' || t === 'search' || t === 'info' || t === 'show')) {
    if (!rest.some((t) => DELETE_TOKENS.has(t) || BATCH_TOKENS.has(t) || PERM_TOKENS.has(t))) {
      return { impact: 'read', reason: 'read_verb', category: 'read' }
    }
  }

  if (sub === 'message' || sub === 'mail') {
    if (rest.includes('send') || rest.includes('create') || rest.includes('reply')) {
      // Group / multi-person indicators
      if (
        rest.some((t) => HIGH_MESSAGE.has(t)) ||
        joined.includes('--chat-type') && joined.includes('group') ||
        rest.includes('--receive-id-type') && (joined.includes('chat_id') || joined.includes('open_chat_id'))
      ) {
        return { impact: 'high_impact', reason: 'group_or_multi_message', category: 'group_message' }
      }
      // Multiple receive ids
      const receiveIdx = rest.findIndex((t) => t === '--receive-id' || t === '--user-ids')
      if (receiveIdx >= 0 && rest[receiveIdx + 1]?.includes(',')) {
        return { impact: 'high_impact', reason: 'multi_recipient', category: 'multi_message' }
      }
      return { impact: 'low_write', reason: 'single_message', category: 'message' }
    }
  }

  if (sub === 'doc' || sub === 'wiki' || sub === 'bitable') {
    if (rest.some((t) => DELETE_TOKENS.has(t))) {
      return { impact: 'high_impact', reason: 'delete_doc_or_record', category: 'delete' }
    }
    if (rest.some((t) => BATCH_TOKENS.has(t))) {
      return { impact: 'high_impact', reason: 'batch_write', category: 'batch' }
    }
    if (rest.some((t) => PERM_TOKENS.has(t))) {
      return { impact: 'high_impact', reason: 'permission_or_share', category: 'permission' }
    }
    if (rest.some((t) => t === 'create' || t === 'update' || t === 'write' || t === 'append')) {
      return { impact: 'low_write', reason: 'single_doc_write', category: 'doc_write' }
    }
  }

  if (sub === 'calendar') {
    if (rest.some((t) => t === 'create' || t === 'invite' || t === 'update')) {
      if (
        rest.includes('--attendees') ||
        rest.includes('--attendee') ||
        joined.includes('attendee') ||
        rest.includes('--user-ids')
      ) {
        return { impact: 'high_impact', reason: 'calendar_invite_others', category: 'calendar_invite' }
      }
      return { impact: 'low_write', reason: 'calendar_self', category: 'calendar' }
    }
    if (rest.some((t) => DELETE_TOKENS.has(t))) {
      return { impact: 'high_impact', reason: 'calendar_delete', category: 'delete' }
    }
  }

  if (rest.some((t) => PERM_TOKENS.has(t))) {
    return { impact: 'high_impact', reason: 'permission_or_share', category: 'permission' }
  }
  if (rest.some((t) => DELETE_TOKENS.has(t) || BATCH_TOKENS.has(t))) {
    return { impact: 'high_impact', reason: 'destructive_or_batch', category: 'delete' }
  }

  // Write-ish without clear classification
  if (rest.some((t) => t === 'create' || t === 'update' || t === 'send' || t === 'write' || t === 'set')) {
    return { impact: 'unknown', reason: 'unclassified_write', category: 'unknown_write' }
  }

  if (sub === 'api' || sub === 'auth' || sub === 'config') {
    return { impact: 'unknown', reason: 'opaque_subcommand', category: 'unknown' }
  }

  if (rest.length === 0) {
    return { impact: 'unknown', reason: 'missing_action', category: 'missing' }
  }

  // Unrecognized action verbs → fail closed
  if (rest.some((t) => t === 'invoke' || t === 'call' || t === 'exec')) {
    return { impact: 'unknown', reason: 'opaque_action', category: 'unknown' }
  }

  return { impact: 'read', reason: 'default_read', category: 'read' }
}

/**
 * Whether lark write needs confirm given impact + config.
 * high_impact / unknown → always ask; low_write follows switch; read → no.
 */
export function larkCliWriteNeedsConfirm(
  argv: unknown,
  larkCliWriteRequiresConfirm: boolean
): boolean {
  const { impact } = classifyLarkCliImpact(argv)
  if (impact === 'read') return false
  if (impact === 'high_impact' || impact === 'unknown') return true
  return larkCliWriteRequiresConfirm
}
