#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compilerConfig = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
const compilerOptions = compilerConfig.error ? {} : ts.parseJsonConfigFileContent(compilerConfig.config, ts.sys, root).options
const exceptionEntries = JSON.parse(readFileSync(path.join(root, 'scripts/session-storage-cross-directory-exceptions.json'), 'utf8'))
const crossDirectoryExceptions = new Map(exceptionEntries.map((entry) => [
  `${entry.source}|${entry.target}|${entry.symbols.join(',')}|${entry.typeOnly}`, entry]))
const observedCrossDirectoryExceptions = new Set()
const sessionStorageTransitions = JSON.parse(readFileSync(path.join(root, 'scripts/session-storage-transitions.json'), 'utf8'))
const transitionByEdge = new Map(sessionStorageTransitions.map((entry) => [`${entry.source}|${entry.target}`, entry]))
const observedSessionStorageTransitions = new Set()

export function validateSessionStorageTransitions(entries) {
  if (!Array.isArray(entries)) return ['transition manifest must be an array']
  const errors = []
  const seen = new Set()
  for (const [index, entry] of entries.entries()) {
    const prefix = `transition[${index}]`
    if (!entry || typeof entry !== 'object') { errors.push(`${prefix} must be an object`); continue }
    if (typeof entry.source !== 'string' || !/^electron\//.test(entry.source)) errors.push(`${prefix} source must be an electron path`)
    if (typeof entry.target !== 'string' || !/^electron\/sessionStorage\//.test(entry.target)) errors.push(`${prefix} target must be a SessionStorage path`)
    if (!Array.isArray(entry.symbols) || entry.symbols.length === 0 || entry.symbols.some((symbol) => typeof symbol !== 'string' || !symbol.trim())) {
      errors.push(`${prefix} symbols must contain named exports`)
    } else if (new Set(entry.symbols).size !== entry.symbols.length) errors.push(`${prefix} symbols contain duplicates`)
    if (typeof entry.typeOnly !== 'boolean') errors.push(`${prefix} typeOnly must be boolean`)
    for (const field of ['owner', 'reason', 'exitStage', 'evidence']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) errors.push(`${prefix} ${field} is required`)
    }
    if (typeof entry.source === 'string' && typeof entry.target === 'string') {
      const key = `${entry.source}|${entry.target}`
      if (seen.has(key)) errors.push(`${prefix} duplicate transition edge`)
      seen.add(key)
    }
  }
  return errors
}

function categoryFor(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  if (normalized.startsWith('electron/database/')) return 'database-adapter'
  if (normalized === 'electron/runtime/sessionStorageCleanupAuthorization.ts') return 'session-cleanup-host'
  if (normalized === 'electron/runtime/agentContinuation.ts') return 'session-history-host'
  if (/^electron\//.test(normalized) && !normalized.startsWith('electron/sessionStorage/')) return 'external-electron'
  if (normalized === 'electron/sessionStorage/sqliteRuntimeBindings.ts') return 'sqlite-host-bindings'
  if (normalized === 'electron/sessionStorage/maintenance.ts') return 'maintenance'
  if (normalized.startsWith('electron/sessionStorage/internal/')) return 'infrastructure/sqlite'
  const match = /^electron\/sessionStorage\/(domain|public|application|infrastructure(?:\/[^/]+)?|host|maintenance)\//.exec(normalized)
  if (match?.[1]?.startsWith('infrastructure')) return 'infrastructure/sqlite'
  if (match) return match[1]
  if (/^electron\/sessionStorage\/[^/]+\.(?:ts|tsx|mts|cts)$/u.test(normalized)) return 'composition'
  return undefined
}

function moduleEdges(sourceFile) {
  const edges = []
  const add = (specifier, symbols = ['*'], typeOnly = false) => {
    const resolvedModule = ts.resolveModuleName(specifier, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule
    const resolved = resolvedModule
      ? path.relative(root, resolvedModule.resolvedFileName).replaceAll('\\', '/').replace(/\.(?:tsx?|mts|cts|jsx?)$/u, '')
      : specifier
    edges.push({ specifier, resolved, symbols, typeOnly })
  }
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
      (ts.isStringLiteral(node.moduleSpecifier) || ts.isNoSubstitutionTemplateLiteral(node.moduleSpecifier))) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause
      const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : !!node.isTypeOnly
      const symbols = []
      if (ts.isImportDeclaration(node) && node.importClause) {
        if (node.importClause.name) symbols.push('default')
        const bindings = node.importClause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) symbols.push('*')
        else if (bindings && ts.isNamedImports(bindings)) symbols.push(...bindings.elements.map((element) => element.propertyName?.text ?? element.name.text))
      } else if (clause && ts.isNamedExports(clause)) symbols.push(...clause.elements.map((element) => element.propertyName?.text ?? element.name.text))
      else if (clause && ts.isNamespaceExport(clause)) symbols.push('*')
      add(node.moduleSpecifier.text, symbols.length ? symbols : ['*'], typeOnly)
    }
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text, ['*'], true)
    else if (ts.isCallExpression(node) && node.arguments.length === 1 &&
      (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0].text, ['*'], false)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return edges
}

function nonStaticModuleLoads(sourceFile) {
  const loads = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0]
      // Require quoted static specifiers. Template literals are rejected even without substitutions
      // so import paths have one unambiguous form for the edge scanner to audit.
      if (!ts.isStringLiteral(argument)) {
        loads.push({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          kind: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import()' : 'require()' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return loads
}

function referencesSessionStorageSql(sourceFile) {
  const tableAccess = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|DELETE\s+FROM)\s+(?:main\.)?(?:sessions|messages|turns|agent_history_[a-z_]+|session_[a-z_]+)\b/iu
  const constants = new Map()
  const evaluateString = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isIdentifier(node)) return constants.get(node.text)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluateString(node.left)
      const right = evaluateString(node.right)
      return left !== undefined && right !== undefined ? left + right : undefined
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text
      for (const span of node.templateSpans) {
        const expression = evaluateString(span.expression)
        if (expression === undefined) return undefined
        value += expression + span.literal.text
      }
      return value
    }
    return undefined
  }
  const collectConstants = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = evaluateString(node.initializer)
      if (value !== undefined) constants.set(node.name.text, value)
    }
    ts.forEachChild(node, collectConstants)
  }
  // Resolve local literal constants before evaluating SQL expressions so common
  // aliasing, concatenation, and template interpolation cannot hide table names.
  for (let pass = 0; pass < 3; pass++) collectConstants(sourceFile)
  let found = false
  const visit = (node) => {
    const value = evaluateString(node)
    if (value !== undefined && tableAccess.test(value)) found = true
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** Resolve imports using the repository TypeScript configuration and enforce categorized module rules. */
export function findSessionStorageModuleViolations(filePath, source) {
  const category = categoryFor(filePath)
  if (!category) return []
  const sourceFile = ts.createSourceFile(path.resolve(root, filePath), source, ts.ScriptTarget.Latest, true)
  const normalizedFile = filePath.replaceAll('\\', '/')
  const sessionStorageSql = referencesSessionStorageSql(sourceFile)
  const rawSessionMessageReads = new Set(['getMessage', 'getMessages', 'getMessageSkeletons', 'getChatMessagePage',
    'getMessagesPageWithSequence', 'getSearchCorpusPage', 'searchMessages', 'getApiContextBaseline', 'getTurnContext', 'resolveRetryContext'])
  const rawSessionMessageWrites = new Set(['appendMessage', 'updateMessageContent', 'deleteMessage', 'deleteMessages',
    'updateMessageStatus', 'updateMessageMetadata'])
  const allowed = (edge) => {
    if (category === 'database-adapter') return true
    if (category === 'session-cleanup-host') return edge.resolved.startsWith('electron/database/') || edge.resolved === 'electron/database' ||
      edge.resolved.startsWith('electron/sessionStorage/') || edge.resolved.startsWith('electron/runtime/') || edge.resolved.startsWith('src/shared/') ||
      edge.resolved.startsWith('node:')
    if (category === 'session-history-host') return edge.resolved.startsWith('electron/database/') || edge.resolved === 'electron/database' ||
      edge.resolved.startsWith('electron/runtime/') || edge.resolved === 'electron/turnRuntime' || edge.resolved.startsWith('electron/sessionStorage/') || edge.resolved.startsWith('src/shared/') ||
      edge.resolved.startsWith('packages/agent-sdk/') || edge.resolved.startsWith('node:')
    if (category === 'external-electron') {
      const storageImplementation = normalizedFile.startsWith('electron/storage/') && !normalizedFile.includes('__gate_probe__')
      const databaseConnectionEdge = (edge.resolved === 'electron/database/sqliteStore' || edge.resolved === 'electron/database') &&
        (edge.symbols.includes('*') || edge.symbols.includes('getDbConnection'))
      if (!storageImplementation && databaseConnectionEdge && sessionStorageSql && normalizedFile !== 'electron/main.ts') return false
      if (edge.resolved === 'electron/runtime/sqliteAgentHistory' && !normalizedFile.endsWith('/agentContinuation.ts')) return false
      if (edge.resolved === 'electron/database' && edge.symbols.includes('*')) return false
      if (!storageImplementation && edge.resolved === 'electron/database/operations' &&
        edge.symbols.some((symbol) => rawSessionMessageWrites.has(symbol))) return false
    }
    if (category === 'external-electron' && !normalizedFile.startsWith('electron/storage/') && edge.resolved === 'electron/database/operations' &&
      edge.symbols.some((symbol) => rawSessionMessageReads.has(symbol))) return false
    if (category === 'external-electron' && edge.resolved === 'electron/sessionStorage/sqliteRuntimeBindings') {
      const key = `${normalizedFile}|${edge.resolved}`
      const transition = transitionByEdge.get(key)
      const approved = !!transition && transition.typeOnly === edge.typeOnly && edge.symbols.length > 0 && edge.symbols.every((symbol) => transition.symbols.includes(symbol))
      if (approved) observedSessionStorageTransitions.add(key)
      return approved
    }
    if (category === 'external-electron' && /^electron\/sessionStorage\/[^/]+$/.test(edge.resolved)) {
      if (edge.resolved === 'electron/sessionStorage/contracts') return edge.typeOnly
      if (edge.resolved === 'electron/sessionStorage/sqliteSessionStorage' && !edge.typeOnly) {
        const compositionSymbols = new Map([
          ['electron/main.ts', new Set(['createSessionLedgerRecoveryBindings', 'createSessionTurnRuntime',
            'createSqliteProjectionBuildTask', 'createSqliteSessionStorage', 'createSqliteSessionStorageHost',
            'createSqliteStartupHistoryRecoveryBindings', 'startSessionProjectionRevalidationDrain'])],
          ['electron/testSupport/sessionStorageComposition.ts', new Set(['createSessionTurnRuntime', 'createSqliteSessionStorage'])],
        ])
        const allowedSymbols = compositionSymbols.get(normalizedFile)
        if (allowedSymbols && edge.symbols.length > 0 && edge.symbols.every((symbol) => allowedSymbols.has(symbol))) return true
      }
      const key = `${normalizedFile}|${edge.resolved}`
      const transition = transitionByEdge.get(key)
      const approved = !!transition && transition.typeOnly === edge.typeOnly && edge.symbols.length > 0 && edge.symbols.every((symbol) => transition.symbols.includes(symbol))
      if (approved) observedSessionStorageTransitions.add(key)
      return approved
    }
    if (category === 'external-electron') return !/^electron\/sessionStorage\/(?:application|infrastructure|internal)\//.test(edge.resolved)
    if (category === 'domain') return edge.resolved === 'src/shared/domainTypes'
    if (category === 'public') {
      return edge.resolved.startsWith('src/shared/') ||
        edge.resolved.startsWith('electron/sessionStorage/domain/') ||
        ['electron/sessionStorage/public/model', 'electron/sessionStorage/public/readPreparation'].includes(edge.resolved) ||
        (edge.resolved === 'electron/sessionStorage/public/ports' && edge.typeOnly && edge.symbols.length === 1 && edge.symbols[0] === 'SessionHistoryPort') ||
        edge.resolved.startsWith('packages/agent-sdk/')
    }
    if (category === 'sqlite-host-bindings') {
      const namedBindings = new Map([
        ['electron/sessionStorage/infrastructure/sqlite/sessionProjectionRevalidationFacts', new Set([
          'computeCanonicalProjectionFingerprint', 'hasCurrentProjectionEligibility', 'publishTranscriptParityProof',
          'refreshValidatedProjectionFastPath', 'validateAndCacheCanonicalProjection',
          'validateCanonicalProjection'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionLegacyQueryAdapter', new Set([
          'readLegacyProjectionMessages', 'readLegacyTurnContextSkeleton', 'iterateLegacyTurnRoutingSkeletons',
          'readLegacyApiContextBaseline', 'readLegacyChatMessagePage', 'readLegacyMessage', 'readLegacyMessageSkeletons',
          'readLegacyMessages', 'readLegacyMessagesPageWithSequence', 'readLegacySearchCorpusPage', 'readLegacyRetryContext',
          'ApiContextBaselineResult', 'ChatMessagePage', 'MessageSearchHit',
          'MessagesPageWithSequence', 'RetryContextTarget', 'SearchCorpusPage'])],
        ['electron/sessionStorage/internal/messageBodyResolver', new Set(['resolveSelectedMessageBodies'])],
        ['electron/sessionStorage/application/projectionService', new Set(['createProjectionService'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionProjectionStateStore', new Set(['createSqliteProjectionStateStore'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionApiRouteProjectionFence', new Set(['createSqliteSessionApiRouteProjectionFence'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionProjectionEligibility', new Set(['hasRejectedTranscriptParityStateInConnection'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionEventRetentionAdapter', new Set([
          'createSessionLedgerCompactionDependencyGuard', 'createCanonicalSessionProjectionRetentionPreparer'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionHistoryRecoveryHost', new Set(['createSqliteStartupHistoryRecoveryBindings'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionTranscriptSelector', new Set(['selectRecentTurnRoutingMessages', 'selectTurnContext'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionProjectionRejection', new Set([
          'clearProjectionRejection', 'computeLegacyProjectionDigest', 'consultProjectionRejection', 'getProjectionRejection',
          'listProjectionRejectionWork', 'markProjectionRejectionStale', 'projectionRejectionBackoffDelayMs',
          'readProjectionO1Metadata', 'recordProjectionRejection', 'ProjectionO1Metadata', 'ProjectionRejectionRow',
          'ProjectionRejectionVerdict'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionProjectionMigration', new Set([
          'cancelSessionProjectionMigration', 'getSessionProjectionMigrationRun', 'listLegacyRequiredSessionProjections',
          'pauseSessionProjectionMigration', 'resumeSessionProjectionMigration', 'runEligibleSessionProjectionMigration',
          'runSessionProjectionMigrationBatch', 'startSessionProjectionMigration', 'LegacyRequiredSessionProjection',
          'LegacyRequiredSessionProjectionReport', 'SessionProjectionMigrationExecutionReport',
          'SessionProjectionMigrationItemOutcome', 'SessionProjectionMigrationRun'])],
        ['electron/sessionStorage/infrastructure/sqlite/sessionProjectionMigrationInventory', new Set([
          'buildSessionProjectionMigrationInventory', 'classifySessionProjectionMigrationScope', 'SessionProjectionMigrationInventoryError',
          'SessionProjectionMigrationDisposition', 'SessionProjectionMigrationInventory', 'SessionProjectionMigrationInventoryEntry',
          'SessionProjectionMigrationScope'])],
      ])
      const allowedSymbols = namedBindings.get(edge.resolved)
      return edge.symbols.length > 0 && !!allowedSymbols && edge.symbols.every((symbol) => allowedSymbols.has(symbol))
    }
    if (category === 'application') {
      return edge.resolved.startsWith('src/shared/') ||
        edge.resolved.startsWith('electron/sessionStorage/domain/') ||
        edge.resolved.startsWith('electron/sessionStorage/public/') ||
        edge.resolved.startsWith('electron/sessionStorage/application/')
    }
    if (category === 'host') {
      return edge.resolved.startsWith('src/shared/') ||
        edge.resolved.startsWith('packages/agent-sdk/') ||
        edge.resolved.startsWith('electron/sessionStorage/public/') ||
        edge.resolved.startsWith('electron/sessionStorage/application/') ||
        edge.resolved.startsWith('electron/sessionStorage/host/')
    }
    if (category === 'maintenance') {
      return edge.resolved === 'electron/sessionStorage/internal/sqliteCleanup'
    }
    if (category === 'composition') {
      return edge.resolved.startsWith('electron/sessionStorage/') || edge.resolved.startsWith('electron/database/') ||
        edge.resolved === 'electron/database' || edge.resolved.startsWith('electron/storage/') ||
        edge.resolved.startsWith('electron/runtime/') || edge.resolved.startsWith('electron/queue/') ||
        ['electron/sessionMetadataKeys', 'electron/chatMessageBuild', 'electron/sessionContextCompaction',
          'electron/sessionEvents', 'electron/queueInputFingerprint', 'electron/turnRuntime'].includes(edge.resolved) ||
        edge.resolved.startsWith('src/shared/') || edge.resolved.startsWith('packages/agent-sdk/') || edge.resolved.startsWith('node:')
    }
    if (category === 'infrastructure/sqlite') {
      return edge.resolved.startsWith('electron/database/') || edge.resolved === 'electron/database' ||
        edge.resolved.startsWith('electron/sessionStorage/domain/') ||
        edge.resolved.startsWith('electron/sessionStorage/internal/') ||
        edge.resolved.startsWith('electron/sessionStorage/infrastructure/') ||
        /^electron\/sessionStorage\/[^/]+$/.test(edge.resolved) ||
        ['electron/sessionStorage/application/ports', 'electron/sessionStorage/application/projectionBuildCoordinator',
          'electron/sessionStorage/application/projectionService', 'electron/sessionStorage/application/projectionChatBodyCacheReader',
          'electron/sessionStorage/application/projectionOutputManifest',
          'electron/sessionStorage/host/ports', 'electron/sessionStorage/host/sessionProjectionRevalidationQueue',
          'electron/sessionStorage/host/sessionCommitService'].includes(edge.resolved) ||
        edge.resolved.startsWith('electron/sessionStorage/public/') ||
        edge.resolved.startsWith('src/shared/') || edge.resolved.startsWith('packages/agent-sdk/') || edge.resolved.startsWith('node:') ||
        edge.resolved === 'electron/storage/sessionLedgerRoots' ||
        edge.resolved === 'electron/storage/spillProtocol' ||
        edge.resolved === 'electron/sessionLedgerIdentity' ||
        ['electron/sessionEvents', 'electron/queueInputFingerprint', 'electron/agentLogger/agentLogger', 'electron/runtime/sqliteAgentHistory',
          'electron/runtime/sessionProjectionMigrationInventory', 'electron/runtime/sessionProjectionLegacyBaseline',
          'electron/runtime/sessionStorageShadow',
          'electron/runtime/agentContinuation',
          'electron/runtime/continuationSummary', 'electron/runtime/terminalOutcome', 'electron/runtime/canonicalHistory',
          'electron/turnRuntime', 'electron/chatMessageBuild', 'electron/sessionContextCompaction', 'electron/sessionMetadataKeys'].includes(edge.resolved) ||
        edge.resolved.startsWith('src/shared/') || edge.resolved.startsWith('packages/agent-sdk/') || edge.resolved.startsWith('node:') ||
        edge.resolved === '../../node_modules/@types/proper-lockfile/index.d' ||
        edge.resolved === '../../node_modules/@types/proper-lockfile/index.d'
    }
    return false
  }
  const violations = moduleEdges(sourceFile).filter((edge) => {
    if (allowed(edge)) return false
    if (category === 'external-electron') {
      const exceptionKey = `${filePath.replaceAll('\\', '/')}|${edge.resolved}|${edge.symbols.join(',')}|${edge.typeOnly}`
      if (crossDirectoryExceptions.has(exceptionKey)) {
        observedCrossDirectoryExceptions.add(exceptionKey)
        return false
      }
    }
    return true
  }).map(({ specifier, resolved }) => ({ category, specifier, resolved }))
  for (const load of nonStaticModuleLoads(sourceFile)) {
    violations.push({ category, specifier: `${load.kind}@${load.line}:<non-static>`, resolved: '<dynamic-module-load>' })
  }
  return violations
}

/** Find implementation-only types reachable from exported declarations in the public port category. */
export function findSessionStoragePublicTypeLeaks(filePath, source) {
  if (!filePath.replaceAll('\\', '/').startsWith('electron/sessionStorage/public/')) return []
  const sourceFile = ts.createSourceFile(path.resolve(root, filePath), source, ts.ScriptTarget.Latest, true)
  const forbidden = new Set(['AppDatabase', 'DatabaseSync', 'StatementSync', 'SQLInputValue', 'SQLOutputValue'])
  const importedForbidden = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const resolved = moduleEdges(ts.createSourceFile(sourceFile.fileName, statement.getFullText(sourceFile), ts.ScriptTarget.Latest, true))[0]?.resolved
    const bindings = statement.importClause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (forbidden.has(imported) || (imported === 'AppDatabase' && /(?:^|\/)database(?:\/|$)/.test(resolved ?? ''))) {
        importedForbidden.set(element.name.text, imported)
      }
    }
  }

  const aliasDependencies = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) continue
    const dependencies = new Set()
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        const imported = importedForbidden.get(node.text)
        if (forbidden.has(node.text)) dependencies.add(node.text)
        if (imported) dependencies.add(imported)
        if (aliasDependencies.has(node.text)) for (const dependency of aliasDependencies.get(node.text)) dependencies.add(dependency)
      }
      ts.forEachChild(node, visit)
    }
    visit(statement.type)
    aliasDependencies.set(statement.name.text, dependencies)
  }

  const leaks = new Set()
  for (const statement of sourceFile.statements) {
    const isExported = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (!isExported && !ts.isExportDeclaration(statement)) continue
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        const imported = importedForbidden.get(node.text)
        if (forbidden.has(node.text)) leaks.add(node.text)
        if (imported) leaks.add(imported)
        for (const dependency of aliasDependencies.get(node.text) ?? []) leaks.add(dependency)
      }
      ts.forEachChild(node, visit)
    }
    visit(statement)
  }
  return [...leaks].sort()
}

function filesUnder(directory) {
  return ts.sys.directoryExists(directory) ? ts.sys.readDirectory(directory, ['.ts', '.tsx', '.mts', '.cts'], ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'], undefined) : []
}

function rootProductionFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx|mts|cts)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
}

function runIllegalEdgeProbes() {
    const probes = [
      ['domain raw DB access', 'electron/sessionStorage/domain/__gate_probe__.ts', `import { getSession } from '../../database/operations'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['public internal re-export', 'electron/sessionStorage/public/__gate_probe__.ts', `export * from '../internal/example'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['public implementation type leak', 'electron/sessionStorage/public/__gate_probe__.ts', `import type { DatabaseSync } from 'node:sqlite'; export type ProbeDto = { db: DatabaseSync }`,
        (file, source) => findSessionStoragePublicTypeLeaks(file, source).includes('DatabaseSync')],
      ['new root implementation file', 'electron/sessionStorage/__gate_probe__.ts', `import { sendFeishuTextToTarget } from '../feishu/feishuReply'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['external application edge', 'electron/remote/__gate_probe__.ts', `import { readChatMessagesAfterPreparation } from '../sessionStorage/application/readChatMessages'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['external internal edge', 'electron/storage/__gate_probe__.ts', `import { resolveSelectedMessageBodies } from '../sessionStorage/internal/messageBodyResolver'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['infrastructure reverse application edge', 'electron/sessionStorage/infrastructure/sqlite/__gate_probe__.ts', `import { runProjectionBuildSlice } from '../../../application/unregisteredService'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['maintenance unapproved implementation edge', 'electron/sessionStorage/maintenance.ts', `export * from './application/unregisteredService'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['SQLite host binding unregistered edge', 'electron/sessionStorage/sqliteRuntimeBindings.ts', `export { unregistered } from './infrastructure/sqlite/unregistered'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['runtime binding unapproved caller', 'electron/runtime/__gate_probe__.ts', `import { validateCanonicalProjection } from '../sessionStorage/sqliteRuntimeBindings'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['external raw session message read', 'electron/ipc/__gate_probe__.ts', `import { getMessages } from '../database/operations'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['external implementation binding import', 'electron/ipc/__gate_probe__.ts', `import { createProjectionService, createSqliteProjectionStateStore } from '../sessionStorage/sqliteRuntimeBindings'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['external implementation re-export import', 'electron/ipc/__gate_probe__.ts', `import { certifyCanonicalSessionApiRead } from '../sessionStorage/certification'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['IPC raw database connection to session tables', 'electron/ipc/__gate_probe__.ts', `import { getDbConnection } from '../database/sqliteStore'; export const read = (db) => getDbConnection(db).prepare('SELECT id FROM messages').all()`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['IPC History implementation', 'electron/ipc/__gate_probe__.ts', `import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['IPC database namespace barrel', 'electron/ipc/__gate_probe__.ts', `import * as database from '../database'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['IPC low-level session write', 'electron/ipc/__gate_probe__.ts', `import { appendMessage } from '../database/operations'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['remote raw database connection to session tables', 'electron/remote/__gate_probe__.ts', `import { getDbConnection } from '../database/sqliteStore'; export const read = (db) => getDbConnection(db).prepare('SELECT id FROM messages').all()`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['aliased raw connection with composed session SQL', 'electron/remote/__gate_probe__.ts', `import { getDbConnection as openConnection } from '../database/sqliteStore'; const table = 'messages'; const sql = \`SELECT id FROM \${table}\`; export const read = (db) => openConnection(db).prepare(sql).all()`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['remote History implementation', 'electron/remote/__gate_probe__.ts', `import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['remote database namespace barrel', 'electron/remote/__gate_probe__.ts', `import * as database from '../database'; export const read = (db) => database.getDbConnection(db).prepare('SELECT id FROM sessions').all()`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['remote low-level session write', 'electron/remote/__gate_probe__.ts', `import { appendMessage } from '../database/operations'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['external SQLite composition re-export import', 'electron/ipc/__gate_probe__.ts', `import { createSessionTurnRuntime } from '../sessionStorage/sqliteSessionStorage'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['process composition unregistered SQLite symbol', 'electron/main.ts', `import { createSqliteProjectionStateStore } from './sessionStorage/sqliteSessionStorage'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['test composition unregistered SQLite symbol', 'electron/testSupport/sessionStorageComposition.ts', `import { createSqliteSessionStorageHost } from '../sessionStorage/sqliteSessionStorage'`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['template-literal static implementation import', 'electron/ipc/__gate_probe__.ts', 'import(`../sessionStorage/application/readMessages`)',
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0],
      ['non-static dynamic module load', 'electron/ipc/__gate_probe__.ts', `const modulePath = '../sessionStorage/infrastructure/sqlite/sessionProjectionStateStore'; import(modulePath)`,
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0]
    ]
    const missed = probes.filter(([, file, source, rejects]) => !rejects(file, source))
    if (missed.length > 0) {
      console.error('[check:session-storage-module-graph] illegal-edge probes were not rejected:')
      for (const [name] of missed) console.error(`  - ${name}`)
      return false
    }
    console.log(`[check:session-storage-module-graph] illegal-edge probes rejected as expected (${probes.length} probes)`)
    return true
}

function main() {
  const transitionErrors = validateSessionStorageTransitions(sessionStorageTransitions)
  if (transitionErrors.length) {
    console.error('[check:session-storage-module-graph] invalid SessionStorage transition manifest:')
    for (const error of transitionErrors) console.error(`  - ${error}`)
    process.exitCode = 1
    return
  }
  if (!runIllegalEdgeProbes()) {
    process.exitCode = 1
    return
  }
  if (process.argv.includes('--probe-illegal-edge')) return
  const sourceRoot = path.join(root, 'electron/sessionStorage')
  observedCrossDirectoryExceptions.clear()
  observedSessionStorageTransitions.clear()
  const files = [...rootProductionFiles(sourceRoot), ...['domain', 'public', 'application', 'infrastructure', 'host', 'maintenance', 'internal'].flatMap((category) => filesUnder(path.join(sourceRoot, category))),
    ...ts.sys.readDirectory(path.join(root, 'electron'), ['.ts', '.tsx', '.mts', '.cts'], ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'], undefined)
      .filter((file) => !path.relative(root, file).replaceAll('\\', '/').startsWith('electron/sessionStorage/'))]
  const violations = []
  for (const file of files) {
    const relative = path.relative(root, file).replaceAll('\\', '/')
    for (const violation of findSessionStorageModuleViolations(relative, readFileSync(file, 'utf8'))) {
      violations.push(`${relative}|${violation.specifier}|${violation.resolved}`)
    }
    for (const leakedType of findSessionStoragePublicTypeLeaks(relative, readFileSync(file, 'utf8'))) {
      violations.push(`${relative}|public DTO leaks implementation type ${leakedType}`)
    }
  }
  if (violations.length) {
    console.error('[check:session-storage-module-graph] module category violations:')
    for (const violation of violations.sort()) console.error(`  - ${violation}`)
    process.exitCode = 1
    return
  }
  const staleExceptions = [...crossDirectoryExceptions.keys()].filter((key) => !observedCrossDirectoryExceptions.has(key))
  if (staleExceptions.length) {
    console.error('[check:session-storage-module-graph] stale cross-directory exceptions:')
    for (const key of staleExceptions) console.error(`  - ${key}`)
    process.exitCode = 1
    return
  }
  const staleTransitions = [...transitionByEdge.keys()].filter((key) => !observedSessionStorageTransitions.has(key))
  if (staleTransitions.length) {
    console.error('[check:session-storage-module-graph] stale SessionStorage transitions:')
    for (const key of staleTransitions) console.error(`  - ${key}`)
    process.exitCode = 1
    return
  }
  console.log(`[check:session-storage-module-graph] OK: categorized session-storage modules (${files.length} files); pending cross-directory exceptions (${crossDirectoryExceptions.size})`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
