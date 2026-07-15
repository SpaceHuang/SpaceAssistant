import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import {
  addTrustedCommand,
  addTrustedCommandAtomic,
  canShowShellTrustOption,
  cleanExpiredTrustedCommands,
  commandHasShellMetasyntax,
  confirmLegacyTrustConversion,
  formatTrustedCommandLabel,
  markExpiredTrustedCommands,
  matchesTrustedCommand,
  normalizeTrustedCommandList,
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

function activeTrust(partial: Partial<TrustedShellCommand> & Pick<TrustedShellCommand, 'id'>): TrustedShellCommand {
  return {
    schemaVersion: 2,
    executable: 'npm',
    fixedArgvPrefix: ['install'],
    trailingArgv: 'plain-tokens',
    source: 'desktop',
    command: 'npm install',
    createdAt: Date.now(),
    ...partial
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

  it('matches structured trust by argv token boundary (AC-Trust-Token)', () => {
    const list: TrustedShellCommand[] = [activeTrust({ id: '1' })]
    expect(matchesTrustedCommand('npm install', list)).toBe(true)
    expect(matchesTrustedCommand('npm install react', list)).toBe(true)
    expect(matchesTrustedCommand('npm run build', list)).toBe(false)
    expect(matchesTrustedCommand('npm install-extra', list)).toBe(false)
    expect(matchesTrustedCommand('npm testing', list)).toBe(false)
  })

  it('npm test does not match npm testing', () => {
    const list: TrustedShellCommand[] = [
      activeTrust({
        id: '1',
        executable: 'npm',
        fixedArgvPrefix: ['test'],
        command: 'npm test'
      })
    ]
    expect(matchesTrustedCommand('npm test', list)).toBe(true)
    expect(matchesTrustedCommand('npm testing', list)).toBe(false)
  })

  it('legacy entries do not authorize until converted-pending-review is confirmed', () => {
    const list = normalizeTrustedCommandList([
      { id: '1', command: 'npm install', createdAt: Date.now() }
    ])
    expect(list[0]?.legacyStatus).toBe('converted-pending-review')
    expect(matchesTrustedCommand('npm install', list)).toBe(false)
  })

  it('ignores expired trusted commands', () => {
    const list: TrustedShellCommand[] = [activeTrust({ id: '1', expired: true })]
    expect(matchesTrustedCommand('npm install', list)).toBe(false)
  })

  it('marks commands expired after 90 days idle', () => {
    const now = Date.now()
    const old = now - 91 * 24 * 60 * 60 * 1000
    const marked = markExpiredTrustedCommands(
      [activeTrust({ id: '1', executable: 'git', fixedArgvPrefix: ['status'], createdAt: old, lastUsedAt: old })],
      now
    )
    expect(marked[0]?.expired).toBe(true)
  })

  it('deduplicates addTrustedCommand and updates lastUsedAt', () => {
    const first = addTrustedCommand(db, 'npm install')
    const second = addTrustedCommand(db, 'npm install')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.id).toBe(second!.id)
    expect(second!.lastUsedAt).toBeDefined()
    expect(first!.schemaVersion).toBe(2)
    expect(first!.executable).toBe('npm')
  })

  it('refuses to persist meta commands as trust', () => {
    expect(addTrustedCommand(db, 'echo x > f')).toBeNull()
    expect(addTrustedCommand(db, 'npm test && rm -rf /')).toBeNull()
  })

  it('removeTrustedCommands deletes by id', () => {
    const entry = addTrustedCommand(db, 'npm test')
    expect(entry).not.toBeNull()
    const next = removeTrustedCommands(db, [entry!.id])
    expect(next).toHaveLength(0)
  })

  it('persistExpiredTrustedCommandMarks writes expired flag without deleting', () => {
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000
    const entry = addTrustedCommand(db, 'stale cmd')
    expect(entry).not.toBeNull()
    persistShellConfig(db, {
      trustedCommands: [{ ...entry!, lastUsedAt: old, createdAt: old, expired: false }]
    })
    persistExpiredTrustedCommandMarks(db)
    const list = readShellConfigFromDb(db).trustedCommands ?? []
    expect(list).toHaveLength(1)
    expect(list[0]?.expired).toBe(true)
  })

  it('cleanExpiredTrustedCommands removes expired entries', () => {
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000
    const entry = addTrustedCommand(db, 'old cmd')
    expect(entry).not.toBeNull()
    persistShellConfig(db, {
      trustedCommands: [{ ...entry!, lastUsedAt: old, createdAt: old }]
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

  it('shouldSkipShellConfirmForTrust with structured trust', () => {
    const analysis = askAnalysis()
    const shellConfig = {
      enabled: true,
      shellDefaultTimeoutSec: 300,
      trustedCommands: [activeTrust({ id: '1' })]
    }
    expect(shouldSkipShellConfirmForTrust('npm install react', analysis, shellConfig)).toBe(true)
  })

  it('trusted prefix with redirection must NOT skip confirm (AC-Trust-Meta-Neg)', () => {
    const analysis = askAnalysis()
    const shellConfig = {
      enabled: true,
      shellDefaultTimeoutSec: 300,
      trustedCommands: [
        activeTrust({
          id: '1',
          executable: 'echo',
          fixedArgvPrefix: ['x'],
          command: 'echo x'
        })
      ]
    }
    expect(shouldSkipShellConfirmForTrust('echo x > f', analysis, shellConfig)).toBe(false)
    expect(shouldSkipShellConfirmForTrust('echo x > f', { ...analysis, verdict: 'deny' }, shellConfig)).toBe(
      false
    )
  })

  describe('commandHasShellMetasyntax (Meta-Neg)', () => {
    const metaCases = [
      'npm test $(curl evil)',
      'npm test `curl evil`',
      'npm test > out.txt',
      'npm test >> out.txt',
      'npm test < in.txt',
      'npm test | grep x',
      'npm test && rm -rf /',
      'npm test || echo fail',
      'npm test ; echo done',
      'npm test\nrm -rf /',
      'FOO=bar npm test',
      'echo $HOME',
      'echo ${HOME}',
      'ls *.js',
      'ls file?.txt'
    ]
    for (const cmd of metaCases) {
      it(`treats as metasyntax: ${JSON.stringify(cmd)}`, () => {
        expect(commandHasShellMetasyntax(cmd)).toBe(true)
      })
    }

    const simpleCases = ['npm test', 'npm test react', 'git status', 'python --version', 'npm run build']
    for (const cmd of simpleCases) {
      it(`treats as simple: ${JSON.stringify(cmd)}`, () => {
        expect(commandHasShellMetasyntax(cmd)).toBe(false)
      })
    }

    it('trusted npm test never skips confirm for meta variants', () => {
      const analysis = askAnalysis()
      const shellConfig = {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        trustedCommands: [
          activeTrust({
            id: '1',
            executable: 'npm',
            fixedArgvPrefix: ['test'],
            command: 'npm test'
          })
        ]
      }
      const npmMeta = [
        'npm test $(curl evil)',
        'npm test `curl evil`',
        'npm test > out.txt',
        'npm test | grep x',
        'npm test && rm -rf /',
        'npm test ; echo done',
        'npm test $HOME'
      ]
      for (const cmd of npmMeta) {
        expect(shouldSkipShellConfirmForTrust(cmd, analysis, shellConfig)).toBe(false)
      }
      expect(shouldSkipShellConfirmForTrust('npm test', analysis, shellConfig)).toBe(true)
      expect(matchesTrustedCommand('npm test $(x)', shellConfig.trustedCommands)).toBe(false)
      expect(canShowShellTrustOption(analysis, 'npm test | cat')).toBe(false)
    })
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

  it('confirmLegacyTrustConversion activates pending-review entries', () => {
    persistShellConfig(db, {
      trustedCommands: [{ id: 'leg1', command: 'git status', createdAt: Date.now() }]
    })
    const listed = normalizeTrustedCommandList(readShellConfigFromDb(db).trustedCommands ?? [])
    expect(listed[0]?.legacyStatus).toBe('converted-pending-review')
    expect(matchesTrustedCommand('git status', listed)).toBe(false)
    const confirmed = confirmLegacyTrustConversion(db, 'leg1')
    expect(confirmed?.legacyStatus).toBeUndefined()
    expect(matchesTrustedCommand('git status', readShellConfigFromDb(db).trustedCommands)).toBe(true)
  })

  it('formatTrustedCommandLabel shows scope', () => {
    expect(formatTrustedCommandLabel(activeTrust({ id: '1' }))).toContain('npm install')
  })

  it('addTrustedCommandAtomic serializes concurrent writes', async () => {
    const results = await Promise.all([
      addTrustedCommandAtomic(db, 'npm test'),
      addTrustedCommandAtomic(db, 'npm test'),
      addTrustedCommandAtomic(db, 'npm test')
    ])
    const ids = new Set(results.filter(Boolean).map((r) => r!.id))
    expect(ids.size).toBe(1)
    expect(readShellConfigFromDb(db).trustedCommands?.length).toBe(1)
  })
})
