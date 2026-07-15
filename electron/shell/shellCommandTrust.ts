import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import type { ShellAnalysisResult } from './shellTypes'
import type {
  ShellConfig,
  TrustedShellCommand,
  TrustedShellSource
} from '../../src/shared/domainTypes'
import { persistShellConfig, readShellConfigFromDb } from './shellConfigDb'
import {
  commandHasShellMetasyntax,
  parseSimpleShellCommand,
  type ParsedSimpleShellCommand
} from './shellCommandParser'

export { commandHasShellMetasyntax, parseSimpleShellCommand }
export type { ParsedSimpleShellCommand }

const TRUST_EXPIRE_MS = 90 * 24 * 60 * 60 * 1000

/** Synchronizes structured trust writes across desktop / IM channels. */
let trustWriteChain: Promise<unknown> = Promise.resolve()

function withTrustWriteLock<T>(fn: () => T): Promise<T> {
  const run = trustWriteChain.then(() => fn())
  trustWriteChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function normalizeTrustedCommandPrefix(command: string): string {
  return command.trim()
}

/** Display label for settings / logs (never used alone for authorization). */
export function formatTrustedCommandLabel(entry: TrustedShellCommand): string {
  if (entry.schemaVersion === 2 && entry.executable) {
    const prefix = entry.fixedArgvPrefix?.length
      ? [entry.executable, ...entry.fixedArgvPrefix].join(' ')
      : entry.executable
    const trail = entry.trailingArgv === 'exact' ? '' : ' …'
    return `${prefix}${trail}`
  }
  return entry.command?.trim() || entry.executable || ''
}

export function isStructuredTrustActive(entry: TrustedShellCommand): boolean {
  if (entry.expired) return false
  if (entry.legacyStatus === 'converted-pending-review' || entry.legacyStatus === 'invalid') {
    return false
  }
  return entry.schemaVersion === 2 && Boolean(entry.executable)
}

function argvMatchesTrust(cmdArgv: string[], entry: TrustedShellCommand): boolean {
  if (!entry.executable) return false
  if (cmdArgv[0] !== entry.executable) return false
  const fixed = entry.fixedArgvPrefix ?? []
  if (cmdArgv.length < 1 + fixed.length) return false
  for (let i = 0; i < fixed.length; i++) {
    if (cmdArgv[i + 1] !== fixed[i]) return false
  }
  const rest = cmdArgv.slice(1 + fixed.length)
  if (entry.trailingArgv === 'exact') {
    return rest.length === 0
  }
  // plain-tokens: any remaining tokens allowed (already stripped of metasyntax by parser)
  return true
}

export function matchesTrustedCommand(
  command: string,
  trustedCommands?: TrustedShellCommand[]
): boolean {
  if (!trustedCommands?.length) return false
  if (commandHasShellMetasyntax(command)) return false
  const parsed = parseSimpleShellCommand(command)
  if (!parsed.persistable || parsed.hasMetasyntax) return false

  return trustedCommands.some((t) => {
    if (!isStructuredTrustActive(t)) return false
    if (commandHasShellMetasyntax(formatTrustedCommandLabel(t))) return false
    return argvMatchesTrust(parsed.argv, t)
  })
}

export function canShowShellTrustOption(
  analysis: ShellAnalysisResult,
  command?: string
): boolean {
  if (analysis.verdict === 'deny') return false
  const hints = analysis.shellSecurityHints
  if (hints.requiresRiskAck) return false
  if (hints.securityWarning) return false
  if (hints.denyType === 'weak') return false
  if (command != null) {
    if (commandHasShellMetasyntax(command)) return false
    const parsed = parseSimpleShellCommand(command)
    if (!parsed.persistable) return false
  }
  return true
}

/** run_script（Python）在开启自动执行时跳过确认卡片 */
export function shouldSkipRunScriptConfirmForAutoAllow(shellConfig?: ShellConfig | null): boolean {
  return shellConfig?.autoAllowScriptExecution === true
}

export function shouldSkipShellConfirmForTrust(
  command: string,
  analysis: ShellAnalysisResult,
  shellConfig?: ShellConfig | null
): boolean {
  if (analysis.verdict === 'deny') return false
  if (commandHasShellMetasyntax(command)) return false
  if (!matchesTrustedCommand(command, shellConfig?.trustedCommands)) return false
  return canShowShellTrustOption(analysis, command)
}

export type AddTrustedCommandOptions = {
  source?: TrustedShellSource
  /** Override trailing match mode (default from parser: plain-tokens). */
  trailingArgv?: 'plain-tokens' | 'exact'
}

/**
 * Persist a structured trust entry. Meta / non-persistable commands return null (no write).
 * Dual-channel callers should use {@link addTrustedCommandAtomic}.
 */
export function addTrustedCommand(
  db: AppDatabase,
  command: string,
  opts?: AddTrustedCommandOptions
): TrustedShellCommand | null {
  const parsed = parseSimpleShellCommand(command)
  if (!parsed.persistable || parsed.hasMetasyntax) return null

  const source = opts?.source ?? 'desktop'
  const trailingArgv = opts?.trailingArgv ?? parsed.trailingArgv
  const shell = readShellConfigFromDb(db)
  const list = normalizeTrustedCommandList([...(shell.trustedCommands ?? [])])
  const now = Date.now()

  const existing = list.find(
    (t) =>
      isStructuredTrustActive(t) &&
      t.executable === parsed.executable &&
      arraysEqual(t.fixedArgvPrefix ?? [], parsed.argv.slice(1)) &&
      (t.trailingArgv ?? 'plain-tokens') === trailingArgv
  )
  // Dedup by executable + full argv as fixed prefix with plain-tokens trailing empty rest
  const existingByScope = list.find((t) => {
    if (t.expired || t.legacyStatus === 'invalid') return false
    if (t.schemaVersion !== 2 || !t.executable) return false
    if (t.executable !== parsed.executable) return false
    const fixed = t.fixedArgvPrefix ?? []
    // Same executable + same fixed prefix length matching all trusted tokens as fixed
    if (fixed.length !== parsed.argv.length - 1) return false
    return arraysEqual(fixed, parsed.argv.slice(1))
  })

  const hit = existing ?? existingByScope
  if (hit) {
    hit.lastUsedAt = now
    hit.expired = false
    hit.legacyStatus = undefined
    hit.schemaVersion = 2
    hit.source = hit.source ?? source
    persistShellConfig(db, { trustedCommands: list })
    return hit
  }

  const entry: TrustedShellCommand = {
    id: randomUUID(),
    schemaVersion: 2,
    executable: parsed.executable,
    fixedArgvPrefix: parsed.argv.slice(1),
    trailingArgv,
    source,
    command: parsed.normalized,
    createdAt: now,
    lastUsedAt: now,
    expired: false
  }
  list.push(entry)
  persistShellConfig(db, { trustedCommands: list })
  return entry
}

/** Serialize trust writes so desktop + IM races only create one entry. */
export async function addTrustedCommandAtomic(
  db: AppDatabase,
  command: string,
  opts?: AddTrustedCommandOptions
): Promise<TrustedShellCommand | null> {
  return withTrustWriteLock(() => addTrustedCommand(db, command, opts))
}

export function confirmLegacyTrustConversion(
  db: AppDatabase,
  id: string
): TrustedShellCommand | null {
  const shell = readShellConfigFromDb(db)
  const list = normalizeTrustedCommandList([...(shell.trustedCommands ?? [])])
  const item = list.find((t) => t.id === id)
  if (!item || item.legacyStatus !== 'converted-pending-review') return null
  if (item.schemaVersion !== 2 || !item.executable) return null
  item.legacyStatus = undefined
  item.lastUsedAt = Date.now()
  persistShellConfig(db, { trustedCommands: list })
  return item
}

export function touchTrustedCommand(db: AppDatabase, command: string): void {
  if (!matchesTrustedCommand(command, readShellConfigFromDb(db).trustedCommands)) return
  const parsed = parseSimpleShellCommand(command)
  if (!parsed.persistable) return
  const shell = readShellConfigFromDb(db)
  const list = normalizeTrustedCommandList([...(shell.trustedCommands ?? [])])
  const item = list.find((t) => isStructuredTrustActive(t) && argvMatchesTrust(parsed.argv, t))
  if (!item) return
  item.lastUsedAt = Date.now()
  item.expired = false
  persistShellConfig(db, { trustedCommands: list })
}

export function removeTrustedCommands(db: AppDatabase, ids: string[]): TrustedShellCommand[] {
  const shell = readShellConfigFromDb(db)
  const idSet = new Set(ids)
  const next = normalizeTrustedCommandList(shell.trustedCommands ?? []).filter(
    (t) => !idSet.has(t.id)
  )
  persistShellConfig(db, { trustedCommands: next })
  return next
}

export function markExpiredTrustedCommands(
  trustedCommands: TrustedShellCommand[],
  now = Date.now()
): TrustedShellCommand[] {
  return trustedCommands.map((t) => {
    const last = t.lastUsedAt ?? t.createdAt
    if (now - last > TRUST_EXPIRE_MS) return { ...t, expired: true }
    return t
  })
}

export function cleanExpiredTrustedCommands(db: AppDatabase): number {
  const shell = readShellConfigFromDb(db)
  const marked = markExpiredTrustedCommands(normalizeTrustedCommandList(shell.trustedCommands ?? []))
  const before = marked.filter((t) => t.expired).length
  const next = marked.filter((t) => !t.expired)
  persistShellConfig(db, { trustedCommands: next })
  return before
}

export function listTrustedCommands(db: AppDatabase): TrustedShellCommand[] {
  const shell = readShellConfigFromDb(db)
  return markExpiredTrustedCommands(normalizeTrustedCommandList(shell.trustedCommands ?? []))
}

/** 将超过 90 天未使用的记录标记为过期并持久化（不删除） */
export function persistExpiredTrustedCommandMarks(db: AppDatabase): TrustedShellCommand[] {
  const shell = readShellConfigFromDb(db)
  const prev = normalizeTrustedCommandList(shell.trustedCommands ?? [])
  const marked = markExpiredTrustedCommands(prev)
  const changed = marked.some((t, i) => Boolean(t.expired) !== Boolean(prev[i]?.expired))
  if (changed) {
    persistShellConfig(db, { trustedCommands: marked })
  }
  return marked
}

/**
 * Normalize legacy `command`-only entries into schema v2 with legacyStatus.
 * Convertible simple commands → converted-pending-review (no skip until confirmed).
 * Unparseable → invalid.
 */
export function normalizeTrustedCommandList(
  trustedCommands: TrustedShellCommand[]
): TrustedShellCommand[] {
  return trustedCommands.map((raw) => normalizeTrustedCommandEntry(raw))
}

export function normalizeTrustedCommandEntry(raw: TrustedShellCommand): TrustedShellCommand {
  if (raw.schemaVersion === 2 && raw.executable) {
    return {
      ...raw,
      fixedArgvPrefix: raw.fixedArgvPrefix ?? [],
      trailingArgv: raw.trailingArgv ?? 'plain-tokens',
      command: raw.command ?? formatTrustedCommandLabel(raw)
    }
  }

  const legacyCmd = raw.command?.trim() ?? ''
  if (!legacyCmd) {
    return { ...raw, schemaVersion: 2, legacyStatus: 'invalid', expired: true }
  }
  const parsed = parseSimpleShellCommand(legacyCmd)
  if (!parsed.persistable || parsed.hasMetasyntax) {
    return {
      ...raw,
      schemaVersion: 2,
      command: legacyCmd,
      legacyStatus: 'invalid',
      expired: true
    }
  }
  return {
    ...raw,
    schemaVersion: 2,
    executable: parsed.executable,
    fixedArgvPrefix: parsed.argv.slice(1),
    trailingArgv: parsed.trailingArgv,
    command: parsed.normalized,
    legacyStatus: 'converted-pending-review'
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
