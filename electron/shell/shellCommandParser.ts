const MAX_SEGMENTS = 50

export type ShellTrailingArgvMode = 'plain-tokens' | 'exact'

/**
 * Detects any shell metasyntax that must NEVER be persisted as trust nor match existing
 * trust to skip confirmation (P0 / AC-Trust-Meta-Neg).
 */
export function commandHasShellMetasyntax(command: string): boolean {
  if (typeof command !== 'string') return true
  const cmd = command
  if (/[\r\n]/.test(cmd)) return true
  if (cmd.includes('`')) return true
  if (cmd.includes('$(')) return true
  if (/\$\{/.test(cmd)) return true
  if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) return true
  if (/[|;<>&]/.test(cmd)) return true
  if (/[*?]/.test(cmd)) return true
  const firstToken = cmd.trim().split(/\s+/)[0] ?? ''
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) return true
  return false
}

export type ParsedSimpleShellCommand = {
  executable: string
  argv: string[]
  /** Original trimmed command string (normalized spaces between tokens when simple). */
  normalized: string
  hasMetasyntax: boolean
  /** True only for a single simple command that may be persisted as structured trust. */
  persistable: boolean
  /** How trailing args beyond fixedArgvPrefix should be matched when trusting. */
  trailingArgv: ShellTrailingArgvMode
  /** Human-readable reason when not persistable. */
  reason?: string
}

/** 将复合 shell 命令分段（引号内不拆分）。 */
export function parseShellSegments(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return ['']

  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (quote) {
      current += ch
      if (ch === quote && trimmed[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '&' && trimmed[i + 1] === '&') {
      pushSegment(segments, current)
      current = ''
      i++
      continue
    }
    if (ch === '|' && trimmed[i + 1] === '|') {
      pushSegment(segments, current)
      current = ''
      i++
      continue
    }
    if (ch === '|' || ch === ';') {
      pushSegment(segments, current)
      current = ''
      continue
    }
    current += ch
  }
  pushSegment(segments, current)

  if (segments.length > MAX_SEGMENTS) {
    throw new Error(`命令段数过多（>${MAX_SEGMENTS}），请拆分为多条命令`)
  }
  return segments
}

function pushSegment(segments: string[], raw: string): void {
  const s = raw.trim()
  if (s || segments.length === 0) segments.push(s)
}

/**
 * Tokenize a SIMPLE command (single segment) into whitespace-separated argv, respecting single
 * and double quotes and stripping the surrounding quote characters. Returns null when the input
 * cannot be safely tokenized (unbalanced quotes). Callers must first ensure the command has no
 * shell metasyntax; this does NOT interpret operators.
 */
export function tokenizeSimpleCommand(command: string): string[] | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const tokens: string[] = []
  let current = ''
  let hasCurrent = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasCurrent = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (hasCurrent) {
        tokens.push(current)
        current = ''
        hasCurrent = false
      }
      continue
    }
    current += ch
    hasCurrent = true
  }
  if (quote) return null
  if (hasCurrent) tokens.push(current)
  return tokens.length ? tokens : null
}

export interface ParsedTrustCommand {
  /** First token (program). Empty when not parseable. */
  executable: string
  /** Tokens after the executable. */
  argv: string[]
  /** True when the raw command contains shell metasyntax and thus cannot be trusted. */
  hasMetasyntax: boolean
  /** True only for a single simple command with no metasyntax (safe to persist as trust). */
  persistable: boolean
}

/**
 * Parse a command into a structured trust candidate. `hasMetasyntaxFn` is injected to avoid a
 * cyclic import with shellCommandTrust.
 */
export function parseShellCommandForTrust(
  command: string,
  hasMetasyntaxFn: (command: string) => boolean
): ParsedTrustCommand {
  const hasMeta = hasMetasyntaxFn(command)
  if (hasMeta) {
    return { executable: '', argv: [], hasMetasyntax: true, persistable: false }
  }
  const tokens = tokenizeSimpleCommand(command)
  if (!tokens || tokens.length === 0) {
    return { executable: '', argv: [], hasMetasyntax: false, persistable: false }
  }
  const [executable, ...argv] = tokens
  return { executable: executable!, argv, hasMetasyntax: false, persistable: true }
}

/**
 * Tokenize a single shell segment into argv with basic quote handling.
 * Returns null when quotes are unbalanced or tokenization fails.
 */
export function tokenizeShellArgv(segment: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  const s = segment.trim()
  if (!s) return []

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === '\\' && quote === '"' && i + 1 < s.length) {
        current += s[i + 1]!
        i++
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote) return null
  if (current) tokens.push(current)
  return tokens
}

/**
 * Parse a command for structured trust: only a single simple command (no metasyntax,
 * no multi-segment) is persistable. Complex but runnable commands are marked
 * hasMetasyntax / not persistable.
 */
export function parseSimpleShellCommand(command: string): ParsedSimpleShellCommand {
  const trimmed = typeof command === 'string' ? command.trim() : ''
  if (!trimmed) {
    return {
      executable: '',
      argv: [],
      normalized: '',
      hasMetasyntax: true,
      persistable: false,
      trailingArgv: 'exact',
      reason: 'empty'
    }
  }

  const hasMetasyntax = commandHasShellMetasyntax(trimmed)
  let segments: string[]
  try {
    segments = parseShellSegments(trimmed)
  } catch {
    return {
      executable: '',
      argv: [],
      normalized: trimmed,
      hasMetasyntax: true,
      persistable: false,
      trailingArgv: 'exact',
      reason: 'too_many_segments'
    }
  }

  if (segments.length !== 1 || hasMetasyntax) {
    const tokens = tokenizeShellArgv(segments[0] ?? trimmed) ?? []
    return {
      executable: tokens[0] ?? '',
      argv: tokens,
      normalized: trimmed,
      hasMetasyntax: true,
      persistable: false,
      trailingArgv: 'exact',
      reason: hasMetasyntax ? 'metasyntax' : 'multi_command'
    }
  }

  const argv = tokenizeShellArgv(segments[0]!)
  if (!argv || argv.length === 0) {
    return {
      executable: '',
      argv: [],
      normalized: trimmed,
      hasMetasyntax: false,
      persistable: false,
      trailingArgv: 'exact',
      reason: 'tokenize_failed'
    }
  }

  // Quoted args that contain spaces are boundary-clear → plain-tokens for trailing.
  // If any token itself embeds metasyntax chars that slipped through, refuse.
  for (const t of argv) {
    if (commandHasShellMetasyntax(t)) {
      return {
        executable: argv[0]!,
        argv,
        normalized: argv.join(' '),
        hasMetasyntax: true,
        persistable: false,
        trailingArgv: 'exact',
        reason: 'token_metasyntax'
      }
    }
  }

  return {
    executable: argv[0]!,
    argv,
    normalized: argv.join(' '),
    hasMetasyntax: false,
    persistable: true,
    trailingArgv: 'plain-tokens'
  }
}
