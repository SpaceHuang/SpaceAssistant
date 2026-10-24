import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { findSessionStorageModuleViolations, findSessionStoragePublicTypeLeaks, validateSessionStorageTransitions } from '../../scripts/check-session-storage-module-graph.mjs'

describe('session storage module graph rules', () => {
  it('requires metadata for each remaining SessionStorage transition edge', () => {
    const transitions = JSON.parse(readFileSync(path.resolve('scripts/session-storage-transitions.json'), 'utf8')) as Array<{
      source: string; target: string; symbols: string[]; typeOnly: boolean; owner: string; reason: string; exitStage: string; evidence: string
    }>
    expect(transitions.length).toBeGreaterThan(0)
    for (const transition of transitions) {
      expect(transition.source).toMatch(/^electron\//)
      expect(transition.target).toMatch(/^electron\/sessionStorage\//)
      expect(transition.symbols.length).toBeGreaterThan(0)
      expect(transition.owner.trim()).not.toBe('')
      expect(transition.reason.trim()).not.toBe('')
      expect(transition.exitStage.trim()).not.toBe('')
      expect(transition.evidence.trim()).not.toBe('')
    }
    expect(validateSessionStorageTransitions(transitions)).toEqual([])
    expect(validateSessionStorageTransitions([{ ...transitions[0], owner: '' }])).toContain('transition[0] owner is required')
    expect(validateSessionStorageTransitions([transitions[0], transitions[0]])).toContain('transition[1] duplicate transition edge')
    const scanner = readFileSync(path.resolve('scripts/check-session-storage-module-graph.mjs'), 'utf8')
    expect(scanner).not.toContain('runtimeBindingCallers')
    expect(scanner).not.toContain('runtimeFacadeCallers')
  })

  it('retires the legacy scanner and baseline after all exceptions are closed', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['check:session-storage-boundary']).toBe('node scripts/check-session-storage-module-graph.mjs')
    expect(existsSync(path.resolve('scripts/check-session-storage-boundary.mjs'))).toBe(false)
    expect(existsSync(path.resolve('scripts/session-storage-boundary-baseline.json'))).toBe(false)
  })

  it('runs the graph check from the stable boundary gate used by both Electron builds', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(packageJson.scripts['check:session-storage-boundary']).toContain('check-session-storage-module-graph.mjs')
    for (const name of ['build:electron', 'build:electron:incremental']) {
      const command = packageJson.scripts[name]
      expect(command).toContain('npm run check:session-storage-boundary')
      expect(command.indexOf('npm run check:session-storage-boundary')).toBeLessThan(command.indexOf('tsc -p tsconfig.electron.json'))
    }
    expect(execFileSync(process.execPath, [path.resolve('scripts/check-session-storage-module-graph.mjs'), '--probe-illegal-edge'], { encoding: 'utf8' }))
      .toMatch(/illegal-edge probes rejected as expected \(\d+ probes\)/)
  })

  it('blocks both Electron build command chains before compilation when the injected graph probe fails', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> }
    const sandbox = mkdtempSync(path.join(os.tmpdir(), 'session-storage-build-gate-'))
    try {
      const marker = path.join(sandbox, 'compiled')
      const fakeNpm = path.join(sandbox, 'npm')
      const fakeTsc = path.join(sandbox, 'tsc')
      const fakeRimraf = path.join(sandbox, 'rimraf')
      writeFileSync(fakeNpm, `#!/bin/sh\ncase "$*" in\n  *check:session-storage-boundary*) node "${path.resolve('scripts/check-session-storage-module-graph.mjs')}" --probe-illegal-edge; exit 1 ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 })
      writeFileSync(fakeTsc, `#!/bin/sh\nprintf compiled > "${marker}"\n`, { mode: 0o755 })
      writeFileSync(fakeRimraf, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const isolatedPath = `${sandbox}${path.delimiter}${process.env.PATH ?? ''}`
      for (const name of ['build:electron', 'build:electron:incremental']) {
        const command = packageJson.scripts[name]
        expect(command).toContain('npm run check:session-storage-boundary')
        const result = spawnSync('/bin/sh', ['-c', command], { cwd: path.resolve('.'), env: { ...process.env, PATH: isolatedPath }, encoding: 'utf8' })
        expect(result.status, `${name} must stop on the injected illegal edge`).not.toBe(0)
        expect(`${result.stdout}${result.stderr}`).toMatch(/illegal-edge probes rejected as expected \(\d+ probes\)/)
        expect(existsSync(marker)).toBe(false)
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('keeps cleanup estimates on the storage-owned ledger root resolver', () => {
    const file = 'electron/database/sessionStorageCleanupEstimate.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(source).toContain("from '../storage/sessionLedgerRoots'")
    expect(source).not.toContain('sessionLedgerRecovery')
  })

  it('keeps migration baseline reads and History seed writes in the SQLite owner', () => {
    const file = 'electron/sessionStorage/infrastructure/sqlite/sessionProjectionLegacyBaseline.ts'
      const source = readFileSync(path.resolve(file), 'utf8')
      expect(source).not.toContain("from '../database/operations'")
      expect(source).toContain('readLegacyProjectionMessages')
      expect(existsSync(path.resolve('electron/runtime/sessionProjectionLegacyBaseline.ts'))).toBe(false)
      expect(source).not.toContain('sqliteRuntimeBindings')
      expect(findSessionStorageModuleViolations(file, source)).toEqual([])
  })

  it('keeps the migration consistency audit and retirement classification inside the SQLite owner', () => {
    const file = 'electron/sessionStorage/infrastructure/sqlite/sessionProjectionConsistencyAudit.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(existsSync(path.resolve('electron/runtime/sessionProjectionConsistencyAudit.ts'))).toBe(false)
    expect(source).toContain("from './sessionLegacyQueryAdapter'")
    expect(source).not.toContain('sqliteRuntimeBindings')
    expect(findSessionStorageModuleViolations(file, source)).toEqual([])
  })

  it('keeps migration census and eligibility selection in the SQLite owner', () => {
    const file = 'electron/sessionStorage/infrastructure/sqlite/sessionProjectionMigrationInventory.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(existsSync(path.resolve('electron/runtime/sessionProjectionMigrationInventory.ts'))).toBe(false)
    expect(source).toContain("from './sessionLegacyQueryAdapter'")
    expect(source).not.toContain('sqliteRuntimeBindings')
    expect(findSessionStorageModuleViolations(file, source)).toEqual([])
  })

  it('keeps durable session projection migration writes inside the SQLite owner', () => {
    const file = 'electron/sessionStorage/infrastructure/sqlite/sessionProjectionMigration.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(existsSync(path.resolve('electron/runtime/sessionProjectionMigration.ts'))).toBe(false)
    expect(source).toContain("from './sessionProjectionRevalidationFacts'")
    expect(source).not.toContain('sqliteRuntimeBindings')
    expect(findSessionStorageModuleViolations(file, source)).toEqual([])
  })

  it('keeps turn context and route shadow reads in the SQLite adapter', () => {
    const file = 'electron/sessionStorage/infrastructure/sqlite/sessionStorageShadow.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(existsSync(path.resolve('electron/runtime/sessionStorageShadow.ts'))).toBe(false)
    expect(source).toContain("from './sessionLegacyQueryAdapter'")
    expect(source).not.toContain('sqliteRuntimeBindings')
    expect(findSessionStorageModuleViolations(file, source)).toEqual([])
  })

  it('keeps transcript selector implementation inside the SQLite adapter', () => {
    const runtimeFile = 'electron/runtime/sessionTranscriptSelector.ts'
    const projectionFile = 'electron/runtime/sessionTranscriptProjection.ts'
    expect(existsSync(path.resolve(runtimeFile))).toBe(false)
    const source = readFileSync(path.resolve(projectionFile), 'utf8')
    expect(source).not.toContain("from './sessionTranscriptSelector'")
    expect(source).toContain('selectRecentTurnRoutingMessages')
    expect(source).toContain('selectTurnContext')
  })

  it('routes legacy transcript query operations through the storage adapter', () => {
    const file = 'electron/runtime/sessionTranscriptProjection.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(source).not.toContain("from '../database/operations'")
    expect(source).toContain("from '../sessionStorage/sqliteRuntimeBindings'")
    expect(findSessionStorageModuleViolations(file, source)).toEqual([])
  })

  it('keeps startup ledger repair mechanics behind the SQLite History recovery host', () => {
    const main = readFileSync(path.resolve('electron/main.ts'), 'utf8')
    expect(main).toContain('recoverInterruptedInvocationsWithLedger')
    for (const implementationDetail of [
      'ensureCompactionTransaction', 'ensureRequestProjectionEvents', 'ensureRequestRetryEvent',
      'ensureRequestUsageEvent', 'ensureToolCallEvent', 'ensureToolResultEvent', 'reconcileInterruptedSessionEventLedger',
      'ledgerRecovery.toToolCallProjection', 'ledgerRecovery.toToolResultProjection', 'SqliteAgentHistory'
    ]) expect(main, implementationDetail).not.toContain(implementationDetail)
  })

  it('runs the History recovery phase through SessionRecoveryPort before turn snapshot recovery', () => {
    const main = readFileSync(path.resolve('electron/main.ts'), 'utf8')
    const historyPhase = main.indexOf('sessionStorage.recovery.recoverHistory()')
    const turnRuntime = main.indexOf('turnRuntime = createSessionTurnRuntime(')
    const dependentRecovery = main.indexOf('sessionStorage.recovery.recover()')
    expect(historyPhase).toBeGreaterThanOrEqual(0)
    expect(turnRuntime).toBeGreaterThan(historyPhase)
    expect(dependentRecovery).toBeGreaterThan(turnRuntime)
  })

  it('keeps MCP capability handlers on the injected configuration port', () => {
    const file = 'electron/capabilities/handlers/mcp.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(source).toContain('ctx.mcpConfig.addServer')
    expect(source).toContain('ctx.mcpConfig.listServers')
    expect(source).not.toContain("from '../../database")
    expect(source).not.toContain('getDbConnection')
  })

  it('keeps security IPC away from SQLite adapter construction', () => {
    const file = 'electron/ipc/securityIpc.ts'
    const source = readFileSync(path.resolve(file), 'utf8')
    expect(source).not.toContain('createSecuritySettingsStorage')
    expect(source).not.toContain('getDbConnection')
  })

  it('classifies startup History recovery composition as SQLite infrastructure', () => {
    const adapterFile = 'electron/sessionStorage/infrastructure/sqlite/sessionHistoryRecoveryHost.ts'
    expect(findSessionStorageModuleViolations(adapterFile, readFileSync(path.resolve(adapterFile), 'utf8'))).toEqual([])
  })

  it('allows domain dependencies on shared domain types only', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/domain/example.ts', `
      import type { Message } from '../../../src/shared/domainTypes'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/domain/example.ts', `
      import { getMessage } from '../../database/operations'
    `)).toEqual([{ category: 'domain', specifier: '../../database/operations', resolved: 'electron/database/operations' }])
  })

  it('allows public ports to use shared/domain/SDK contracts but rejects database ownership', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/public/example.ts', `
      import type { Message } from '../../../src/shared/domainTypes'
      import type { TurnState } from '../domain/turnState'
      import type { HistoryPort } from '../../../packages/agent-sdk/src/history'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/public/example.ts', `
      import type { AppDatabase } from '../../database'
    `)).toEqual([{ category: 'public', specifier: '../../database', resolved: 'electron/database' }])
  })

  it('classifies SQLite internals as infrastructure and constrains their host-only dependencies', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/internal/example.ts', `
      import { getSession } from '../../database/operations'
      import { sqlActiveTurnPredicate } from '../domain/turnState'
      import { DatabaseSync } from 'node:sqlite'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/internal/example.ts', `
      import { sendFeishuTextToTarget } from '../../feishu/feishuReply'
    `)).toEqual([{ category: 'infrastructure/sqlite', specifier: '../../feishu/feishuReply', resolved: 'electron/feishu/feishuReply' }])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/infrastructure/sqlite/sessionLedgerAvailabilityReader.ts', `
      import { sessionLedgerLocationIdentity } from '../../../sessionLedgerIdentity'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkReader.ts', `
      import { collectSpillDescriptorsStrict, readSourceTruthSpillSync, type SpillDescriptor } from '../../../storage/spillProtocol'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/infrastructure/sqlite/projectionHistoryChunkReader.ts', `
      import { createSpillStore } from '../../../storage/spillStore'
    `)).toEqual([{ category: 'infrastructure/sqlite', specifier: '../../../storage/spillStore', resolved: 'electron/storage/spillStore' }])
  })

  it('automatically protects new production modules added at the sessionStorage root', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/newPersistenceAdapter.ts', `
      import { sendFeishuTextToTarget } from '../feishu/feishuReply'
    `)).toEqual([{ category: 'composition', specifier: '../feishu/feishuReply', resolved: 'electron/feishu/feishuReply' }])
  })

  it('allows application ports to use shared contracts and rejects runtime or database dependencies', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/application/example.ts', `
      import type { TurnStorage } from '../../../src/shared/turnCoordinator'
      import type { SessionCommands } from '../public/ports'
      import type { ProjectionStateRecord } from '../domain/projectionState'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/application/example.ts', `
      import type { AppDatabase } from '../../database'
      import type { AgentContinuationRecord } from '../../runtime/agentContinuation'
    `)).toEqual([
      { category: 'application', specifier: '../../database', resolved: 'electron/database' },
      { category: 'application', specifier: '../../runtime/agentContinuation', resolved: 'electron/runtime/agentContinuation' }
    ])
  })

  it('allows host contracts to compose public and application ports but rejects database ownership', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/host/example.ts', `
      import type { SessionQueries } from '../public/ports'
      import type { SessionExecutionStore } from '../application/ports'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/host/example.ts', `
      import type { AppDatabase } from '../../database'
    `)).toEqual([{ category: 'host', specifier: '../../database', resolved: 'electron/database' }])
  })

  it('rejects external business dependencies on application, infrastructure and internal implementations', () => {
    expect(findSessionStorageModuleViolations('electron/remote/evilConsumer.ts', `
      import { readChatMessagesAfterPreparation } from '../sessionStorage/application/readChatMessages'
      import { createSqliteProjectionStateStore } from '../sessionStorage/infrastructure/sqlite/sessionProjectionStateStore'
      import { resolveSelectedMessageBodies } from '../sessionStorage/internal/messageBodyResolver'
    `)).toHaveLength(3)
    expect(findSessionStorageModuleViolations('electron/remote/validConsumer.ts', `
      import type { SessionStorage } from '../sessionStorage/host/ports'
      import type { SessionQueries } from '../sessionStorage/public/ports'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/runtime/sessionProjectionRejection.ts', `
      import { someNewSymbol } from '../sessionStorage/application/projectionService'
    `)).toHaveLength(1)
  })

  it('publishes the execution capability from the public contract module', () => {
    const publicExecution = readFileSync(path.resolve('electron/sessionStorage/public/execution.ts'), 'utf8')
    const applicationPorts = readFileSync(path.resolve('electron/sessionStorage/application/ports.ts'), 'utf8')
    expect(publicExecution).toMatch(/export interface SessionExecutionStore/)
    expect(applicationPorts).not.toMatch(/export interface SessionExecutionStore/)
    expect(findSessionStorageModuleViolations('electron/runtime/acceptedTurnContext.ts', `
      import type { SessionExecutionStore } from '../sessionStorage/public/execution'
    `)).toEqual([])
  })

  it('allows only named exports from the SQLite host binding module', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/sqliteRuntimeBindings.ts', `
      export { hasCurrentProjectionEligibility } from './infrastructure/sqlite/sessionProjectionRevalidationFacts'
      export { resolveSelectedMessageBodies } from './internal/messageBodyResolver'
    `)).toEqual([])
    expect(findSessionStorageModuleViolations('electron/sessionStorage/sqliteRuntimeBindings.ts', `
      export * from './infrastructure/sqlite/sessionProjectionRevalidationFacts'
      export { unregistered } from './infrastructure/sqlite/unregistered'
    `)).toHaveLength(2)
  })

  it('keeps every cross-directory exception precise and reviewable', () => {
    const entries = JSON.parse(readFileSync(path.resolve('scripts/session-storage-cross-directory-exceptions.json'), 'utf8')) as Array<{
      source: string; target: string; symbols: string[]; typeOnly: boolean; owner: string; reason: string; exitStage: string; evidence: string
    }>
    expect(entries).toHaveLength(0)
    for (const entry of entries) {
      expect(entry.source).toMatch(/^electron\//)
      expect(entry.target).toMatch(/^electron\/sessionStorage\/(application|infrastructure|internal)\//)
      expect(entry.symbols.length).toBeGreaterThan(0)
      expect(typeof entry.typeOnly).toBe('boolean')
      expect(entry.owner.trim()).not.toBe('')
      expect(entry.reason.trim()).not.toBe('')
      expect(entry.exitStage).toBe('P5')
      expect(entry.evidence.trim()).not.toBe('')
    }
  })

  it('catches re-exports and dynamic low-level imports in the domain category', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/domain/example.ts', `
      export * from '../../runtime/sqliteAgentHistory'
      const sqlite = require('node:sqlite')
      const fs = import('node:fs')
    `)).toEqual([
      { category: 'domain', specifier: '../../runtime/sqliteAgentHistory', resolved: 'electron/runtime/sqliteAgentHistory' },
      { category: 'domain', specifier: 'node:sqlite', resolved: 'node:sqlite' },
      { category: 'domain', specifier: 'node:fs', resolved: 'node:fs' }
    ])
  })

  it('rejects exported DTOs that expose database and SQLite implementation types, including aliases', () => {
    expect(findSessionStoragePublicTypeLeaks('electron/sessionStorage/public/example.ts', `
      import type { AppDatabase as StorageHandle } from '../../database'
      import type { DatabaseSync } from 'node:sqlite'
      export type ExampleDto = { handle: StorageHandle; connection: DatabaseSync }
    `)).toEqual(['AppDatabase', 'DatabaseSync'])
    expect(findSessionStoragePublicTypeLeaks('electron/sessionStorage/public/example.ts', `
      export type ExampleDto = { id: string; content: string }
    `)).toEqual([])
    expect(findSessionStoragePublicTypeLeaks('electron/sessionStorage/public/example.ts', `
      import type { AppDatabase as StorageHandle } from '../../database'
      type InternalHandle = StorageHandle
      export interface ExampleDto { storage: InternalHandle }
    `)).toEqual(['AppDatabase'])
  })

  it('rejects public ports that relay internal exports through another public module', () => {
    expect(findSessionStorageModuleViolations('electron/sessionStorage/public/example.ts', `
      export { SqliteSessionStorage } from './ports'
    `)).toEqual([{ category: 'public', specifier: './ports', resolved: 'electron/sessionStorage/public/ports' }])
  })

  it('detects implementation type leaks through exported interfaces and source re-exports', () => {
    expect(findSessionStoragePublicTypeLeaks('electron/sessionStorage/public/example.ts', `
      import type { DatabaseSync as Connection } from 'node:sqlite'
      export interface StorageDto { connection: Connection }
    `)).toEqual(['DatabaseSync'])
    expect(findSessionStoragePublicTypeLeaks('electron/sessionStorage/public/example.ts', `
      export type { DatabaseSync } from 'node:sqlite'
    `)).toEqual(['DatabaseSync'])
  })
})
