import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import type { ShellAnalysisResult } from './shellTypes'
import type { ShellConfig, TrustedShellCommand } from '../../src/shared/domainTypes'
import { persistShellConfig, readShellConfigFromDb } from './shellConfigDb'

const TRUST_EXPIRE_MS = 90 * 24 * 60 * 60 * 1000

export function normalizeTrustedCommandPrefix(command: string): string {
  return command.trim()
}

/**
 * Detects any shell metasyntax that must NEVER be persisted as trust nor match existing
 * trust to skip confirmation (P0 guardrail, AC-Trust-Meta-Neg): command substitution `$()`,
 * backticks, pipes, redirects (`>` `>>` `<`), logical ops `&&`/`||`, `;`, newlines,
 * background `&`, env-prefix assignments (`VAR=val cmd`), variable expansions (`$FOO` / `${}`)
 * and globs (`*` / `?`).
 */
export function commandHasShellMetasyntax(command: string): boolean {
  if (typeof command !== 'string') return true
  const cmd = command
  if (/[\r\n]/.test(cmd)) return true
  if (cmd.includes('`')) return true
  if (cmd.includes('$(')) return true
  if (/\$\{/.test(cmd)) return true
  if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) return true
  // pipes, semicolons, redirects, logical/background operators
  if (/[|;<>&]/.test(cmd)) return true
  // globs
  if (/[*?]/.test(cmd)) return true
  // leading environment-variable assignment: `FOO=bar cmd`
  const firstToken = cmd.trim().split(/\s+/)[0] ?? ''
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) return true
  return false
}

export function matchesTrustedCommand(command: string, trustedCommands?: TrustedShellCommand[]): boolean {
  if (!trustedCommands?.length) return false
  const cmd = command.trim()
  // Meta commands can never match persisted trust.
  if (commandHasShellMetasyntax(command)) return false
  return trustedCommands.some((t) => {
    if (t.expired) return false
    const prefix = normalizeTrustedCommandPrefix(t.command)
    if (!prefix) return false
    // Meta in the trusted prefix itself is never a valid authorization basis.
    if (commandHasShellMetasyntax(prefix)) return false
    return cmd === prefix || cmd.startsWith(prefix + ' ')
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
  // Never offer trust for commands containing shell metasyntax.
  if (command != null && commandHasShellMetasyntax(command)) return false
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
  // Meta commands never skip confirm via trust.
  if (commandHasShellMetasyntax(command)) return false
  if (!matchesTrustedCommand(command, shellConfig?.trustedCommands)) return false
  return canShowShellTrustOption(analysis, command)
}

export function addTrustedCommand(db: AppDatabase, command: string): TrustedShellCommand {
  const prefix = normalizeTrustedCommandPrefix(command)
  const shell = readShellConfigFromDb(db)
  const list = [...(shell.trustedCommands ?? [])]
  const now = Date.now()
  const existing = list.find((t) => normalizeTrustedCommandPrefix(t.command) === prefix)
  if (existing) {
    existing.lastUsedAt = now
    existing.expired = false
    persistShellConfig(db, { trustedCommands: list })
    return existing
  }
  const entry: TrustedShellCommand = {
    id: randomUUID(),
    command: prefix,
    createdAt: now,
    lastUsedAt: now,
    expired: false
  }
  list.push(entry)
  persistShellConfig(db, { trustedCommands: list })
  return entry
}

export function touchTrustedCommand(db: AppDatabase, command: string): void {
  const prefix = normalizeTrustedCommandPrefix(command)
  const shell = readShellConfigFromDb(db)
  const list = shell.trustedCommands ?? []
  const item = list.find((t) => normalizeTrustedCommandPrefix(t.command) === prefix)
  if (!item) return
  item.lastUsedAt = Date.now()
  item.expired = false
  persistShellConfig(db, { trustedCommands: [...list] })
}

export function removeTrustedCommands(db: AppDatabase, ids: string[]): TrustedShellCommand[] {
  const shell = readShellConfigFromDb(db)
  const idSet = new Set(ids)
  const next = (shell.trustedCommands ?? []).filter((t) => !idSet.has(t.id))
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
  const marked = markExpiredTrustedCommands(shell.trustedCommands ?? [])
  const before = marked.filter((t) => t.expired).length
  const next = marked.filter((t) => !t.expired)
  persistShellConfig(db, { trustedCommands: next })
  return before
}

export function listTrustedCommands(db: AppDatabase): TrustedShellCommand[] {
  const shell = readShellConfigFromDb(db)
  return markExpiredTrustedCommands(shell.trustedCommands ?? [])
}

/** 将超过 90 天未使用的记录标记为过期并持久化（不删除） */
export function persistExpiredTrustedCommandMarks(db: AppDatabase): TrustedShellCommand[] {
  const shell = readShellConfigFromDb(db)
  const prev = shell.trustedCommands ?? []
  const marked = markExpiredTrustedCommands(prev)
  const changed = marked.some((t, i) => Boolean(t.expired) !== Boolean(prev[i]?.expired))
  if (changed) {
    persistShellConfig(db, { trustedCommands: marked })
  }
  return marked
}
