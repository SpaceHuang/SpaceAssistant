import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import {
  addTrustedCommand,
  canShowShellTrustOption,
  cleanExpiredTrustedCommands,
  markExpiredTrustedCommands,
  matchesTrustedCommand,
  normalizeTrustedCommandPrefix,
  persistExpiredTrustedCommandMarks,
  removeTrustedCommands,
  shouldSkipRunScriptConfirmForAutoAllow,
  shouldSkipShellConfirmForTrust
} from './shellCommandTrust'
import { persistShellConfig, readShellConfigFromDb } from './shellConfigDb'
import type { ShellAnalysisResult } from './shellTypes'
import type { TrustedShellCommand } from '../../src/shared/domainTypes'

function askAnalysis(overrides: Partial<ShellAnalysisResult['shellSecurityHints']> = {}): ShellAnalysisResult {
  return {
    verdict: 'ask',
    segments: [],
    pathVerdict: {
      decision: 'ask',
      violations: [],
      warnings: [],
      outsideWorkDirRisk: false,
      requiresRiskAck: false
    },
    shellSecurityHints: {
      requiresRiskAck: false,
      outsideWorkDirRisk: false,
      ...overrides
    }
  }
}

describe('shellCommandTrust', () => {
  let dbPath: string
  let db: AppDatabase

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sa-trust-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    db = openDatabase(dbPath)
  })

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath)
    } catch {
      /* ignore */
    }
  })

  it('normalizes command prefix', () => {
    expect(normalizeTrustedCommandPrefix('  npm install  ')).toBe('npm install')
  })

  it('matches trusted command by prefix', () => {
    const list: TrustedShellCommand[] = [
      { id: '1', command: 'npm install', createdAt: Date.now() }
    ]
    expect(matchesTrustedCommand('npm install', list)).toBe(true)
    expect(matchesTrustedCommand('npm install react', list)).toBe(true)
    expect(matchesTrustedCommand('npm run build', list)).toBe(false)
    expect(matchesTrustedCommand('npm install-extra', list)).toBe(false)
  })

  it('ignores expired trusted commands', () => {
    const list: TrustedShellCommand[] = [
      { id: '1', command: 'npm install', createdAt: Date.now(), expired: true }
    ]
    expect(matchesTrustedCommand('npm install', list)).toBe(false)
  })

  it('marks commands expired after 90 days idle', () => {
    const now = Date.now()
    const old = now - 91 * 24 * 60 * 60 * 1000
    const marked = markExpiredTrustedCommands([
      { id: '1', command: 'git status', createdAt: old, lastUsedAt: old }
    ], now)
    expect(marked[0]?.expired).toBe(true)
  })

  it('deduplicates addTrustedCommand and updates lastUsedAt', () => {
    const first = addTrustedCommand(db, 'npm install')
    const second = addTrustedCommand(db, 'npm install')
    expect(first.id).toBe(second.id)
    expect(second.lastUsedAt).toBeDefined()
  })

  it('removeTrustedCommands deletes by id', () => {
    const entry = addTrustedCommand(db, 'npm test')
    const next = removeTrustedCommands(db, [entry.id])
    expect(next).toHaveLength(0)
  })

  it('persistExpiredTrustedCommandMarks writes expired flag without deleting', () => {
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000
    const entry = addTrustedCommand(db, 'stale cmd')
    persistShellConfig(db, {
      trustedCommands: [{ ...entry, lastUsedAt: old, createdAt: old, expired: false }]
    })
    persistExpiredTrustedCommandMarks(db)
    const list = readShellConfigFromDb(db).trustedCommands ?? []
    expect(list).toHaveLength(1)
    expect(list[0]?.expired).toBe(true)
  })

  it('cleanExpiredTrustedCommands removes expired entries', () => {
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000
    const entry = addTrustedCommand(db, 'old cmd')
    persistShellConfig(db, {
      trustedCommands: [{ ...entry, lastUsedAt: old, createdAt: old }]
    })
    cleanExpiredTrustedCommands(db)
    expect(readShellConfigFromDb(db).trustedCommands ?? []).toHaveLength(0)
  })

  it('canShowShellTrustOption rejects risk ack and weak deny', () => {
    expect(canShowShellTrustOption(askAnalysis())).toBe(true)
    expect(canShowShellTrustOption(askAnalysis({ requiresRiskAck: true }))).toBe(false)
    expect(
      canShowShellTrustOption(
        askAnalysis({ securityWarning: 'warn', denyType: 'weak', validatorId: 'dangerous_git' })
      )
    ).toBe(false)
    expect(canShowShellTrustOption({ ...askAnalysis(), verdict: 'deny' })).toBe(false)
  })

  it('shouldSkipShellConfirmForTrust with trusted prefix', () => {
    const analysis = askAnalysis()
    const shellConfig = {
      enabled: true,
      shellDefaultTimeoutSec: 300,
      trustedCommands: [{ id: '1', command: 'npm install', createdAt: Date.now() }]
    }
    expect(shouldSkipShellConfirmForTrust('npm install react', analysis, shellConfig)).toBe(true)
  })

  it('shouldSkipRunScriptConfirmForAutoAllow when auto allow enabled', () => {
    expect(shouldSkipRunScriptConfirmForAutoAllow({ enabled: true, shellDefaultTimeoutSec: 300 })).toBe(
      false
    )
    expect(
      shouldSkipRunScriptConfirmForAutoAllow({
        enabled: true,
        shellDefaultTimeoutSec: 300,
        autoAllowScriptExecution: true
      })
    ).toBe(true)
  })

  it('shouldSkipShellConfirmForTrust ignores autoAllowScriptExecution', () => {
    const analysis = askAnalysis()
    expect(
      shouldSkipShellConfirmForTrust('echo hi', analysis, {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        autoAllowScriptExecution: true
      })
    ).toBe(false)
  })
})
