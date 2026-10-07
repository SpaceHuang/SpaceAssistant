#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'electron')
const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-storage-boundary-baseline.json')
const protectedModules = [
  /(?:^|\/)runtime\/(?:sessionTranscriptProjection|sessionContentWriteAuthority|sessionStorageShadow|sessionStorageCutover|sqliteAgentHistory|sessionTranscriptStartup|sessionLedgerRecovery)$/,
  /(?:^|\/)database\/(?:sessionTranscript|agentHistoryStorage)$/
]
const protectedDatabaseOperations = new Set([
  'appendMessage', 'appendMessagesAtomically', 'createSession', 'deleteSession', 'getApiContextBaseline', 'getChatMessagePage',
  'getMessage', 'getMessageSequence', 'getMessages', 'getMessagesPageWithSequence', 'getSearchCorpusPage', 'getSession',
  'getSessionMessageRevisionSnapshot', 'getTurnContext', 'hasVisionInTurnRoutingContext', 'listSessions', 'prepareTurnAtomically',
  'resolveRetryContext', 'searchMessages', 'updateMessageContent', 'updateMessageContentIfStreaming', 'updateQueuedUserMessageContent',
  'deleteQueuedUserMessage', 'reorderQueuedUserMessages', 'enqueueQueuedUserMessage'
])
const implementationOwners = new Set([
  // Public database re-export surface and its forwarding entrypoint are audited as a unit.
  'electron/database.ts', 'electron/database/index.ts',
  'electron/sessionStorage/queries.ts', 'electron/sessionStorage/routingQueries.ts', 'electron/sessionStorage/commands.ts', 'electron/sessionStorage/sqliteSessionStorage.ts',
  'electron/sessionStorage/continuationSources.ts',
  'electron/sessionStorage/recovery.ts', 'electron/sessionStorage/recoveryDatabaseAdapter.ts', 'electron/sessionStorage/recoveryHelpers.ts',
  'electron/sessionStorage/coordinator.ts',
  'electron/sessionStorage/execution.ts',
  'electron/runtime/sessionTranscriptProjection.ts', 'electron/runtime/sessionContentWriteAuthority.ts',
  'electron/runtime/sessionTranscriptSelector.ts',
  'electron/runtime/sessionStorageShadow.ts', 'electron/runtime/sessionStorageCutover.ts',
  'electron/runtime/sqliteAgentHistory.ts', 'electron/runtime/sessionTranscriptStartup.ts', 'electron/runtime/sessionLedgerRecovery.ts',
  'electron/database/operations.ts', 'electron/database/sessionTranscript.ts', 'electron/database/agentHistoryStorage.ts',
  // Transaction participants and offline/production maintenance owners retain privileged readers.
  'electron/runtime/agentContinuation.ts', 'electron/runtime/hostedTurnHandoff.ts',
  'electron/runtime/sessionProjectionConsistencyAudit.ts', 'electron/runtime/sessionProjectionLegacyBaseline.ts',
  'electron/runtime/sessionProjectionMigration.ts', 'electron/runtime/sessionProjectionMigrationInventory.ts',
  'electron/runtime/sessionStorageCleanupAuthorization.ts', 'electron/runtime/sessionStorageCleanupProduction.ts'
])

function importedNames(node) {
  if (!node.importClause) return null
  const bindings = node.importClause.namedBindings
  if (!bindings) return node.importClause.name ? [node.importClause.name.text] : null
  if (ts.isNamespaceImport(bindings)) return null
  return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text)
}

function exportedNames(node) {
  if (!node.exportClause) return null
  if (ts.isNamespaceExport(node.exportClause)) return null
  return node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text)
}

function isDatabaseOperationsModule(specifier) {
  return /(?:^|\/)database(?:\/(?:operations|index))?$/.test(specifier.replaceAll('\\', '/'))
}

function isProtectedModule(specifier) {
  const normalized = specifier.replaceAll('\\', '/')
  return protectedModules.some((pattern) => pattern.test(normalized))
}

/** Return parsed, protected dependency edges without matching comments or string contents. */
export function findProtectedSessionStorageImports(filePath, source) {
  const relativeFile = filePath.replaceAll('\\', '/')
  if (implementationOwners.has(relativeFile) || relativeFile.startsWith('electron/sessionStorage/internal/')) return []
  const sourceFile = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, relativeFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const result = []
  const compilerConfigPath = path.join(root, 'tsconfig.json')
  const configFile = ts.readConfigFile(compilerConfigPath, ts.sys.readFile)
  const compilerOptions = configFile.error ? {} : ts.parseJsonConfigFileContent(configFile.config, ts.sys, root).options
  const resolvedSpecifier = (specifier) => {
    const resolved = ts.resolveModuleName(specifier, path.resolve(root, relativeFile), compilerOptions, ts.sys).resolvedModule?.resolvedFileName
    return resolved ? path.relative(root, resolved).replaceAll('\\', '/').replace(/\.(?:tsx?|mts|cts|jsx?)$/u, '') : specifier
  }
  const add = (specifier, symbols) => {
    const resolved = resolvedSpecifier(specifier)
    if (isProtectedModule(specifier) || isProtectedModule(resolved)) result.push({ specifier, symbols })
    else if ((isDatabaseOperationsModule(specifier) || isDatabaseOperationsModule(resolved)) && (symbols === null || symbols.some((symbol) => protectedDatabaseOperations.has(symbol)))) {
      result.push({ specifier, symbols: symbols === null ? null : symbols.filter((symbol) => protectedDatabaseOperations.has(symbol)) })
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, importedNames(node))
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, exportedNames(node))
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text, null)
    else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0].text, null)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return result
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name)
    return statSync(file).isDirectory() ? filesUnder(file) : /\.(?:ts|tsx|mts|cts)$/.test(file) ? [file] : []
  })
}

function collectViolations() {
  const violations = []
  for (const file of filesUnder(sourceRoot)) {
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(file) || file.includes(`${path.sep}testSupport${path.sep}`)) continue
    const relativeFile = path.relative(root, file).replaceAll('\\', '/')
    for (const edge of findProtectedSessionStorageImports(relativeFile, readFileSync(file, 'utf8'))) {
      for (const symbol of edge.symbols ?? ['*']) violations.push(`${relativeFile}|${edge.specifier}|${symbol}`)
    }
  }
  return [...new Set(violations)].sort()
}

function main() {
  const current = collectViolations()
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`[check:session-storage-boundary] wrote ${current.length} existing exceptions`)
    return
  }
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : []
  const additions = current.filter((item) => !baseline.includes(item))
  if (additions.length > 0) {
    console.error('[check:session-storage-boundary] new session-storage dependency violations:')
    for (const item of additions) console.error(`  - ${item}`)
    process.exitCode = 1
    return
  }
  console.log(`[check:session-storage-boundary] OK: ${current.length} existing exceptions, no additions`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
