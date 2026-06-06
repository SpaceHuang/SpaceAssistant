import { randomUUID } from 'crypto'
import type { AppDatabase } from '../database'
import type { ShellAnalysisResult } from './shellTypes'
import type { ShellConfig, TrustedShellCommand } from '../../src/shared/domainTypes'
import { persistShellConfig, readShellConfigFromDb } from './shellConfigDb'

const TRUST_EXPIRE_MS = 90 * 24 * 60 * 60 * 1000

export function normalizeTrustedCommandPrefix(command: string): string {
  return command.trim()
}

export function matchesTrustedCommand(command: string, trustedCommands?: TrustedShellCommand[]): boolean {
  if (!trustedCommands?.length) return false
  const cmd = command.trim()
  return trustedCommands.some((t) => {
    if (t.expired) return false
    const prefix = normalizeTrustedCommandPrefix(t.command)
    if (!prefix) return false
    return cmd === prefix || cmd.startsWith(prefix + ' ')
  })
}

export function canShowShellTrustOption(analysis: ShellAnalysisResult): boolean {
  if (analysis.verdict === 'deny') return false
  const hints = analysis.shellSecurityHints
  if (hints.requiresRiskAck) return false
  if (hints.securityWarning) return false
  if (hints.denyType === 'weak') return false
  return true
}

export function shouldSkipShellConfirmForTrust(
  command: string,
  analysis: ShellAnalysisResult,
  shellConfig?: ShellConfig | null
): boolean {
  if (analysis.verdict === 'deny') return false

  if (shellConfig?.autoAllowScriptExecution) {
    if (analysis.shellSecurityHints.requiresRiskAck) return false
    return true
  }

  if (!matchesTrustedCommand(command, shellConfig?.trustedCommands)) return false
  return canShowShellTrustOption(analysis)
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
