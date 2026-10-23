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

function categoryFor(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  if (/^electron\//.test(normalized) && !normalized.startsWith('electron/sessionStorage/')) return 'external-electron'
  if (normalized === 'electron/sessionStorage/maintenance.ts') return 'maintenance'
  if (normalized.startsWith('electron/sessionStorage/internal/')) return 'infrastructure/sqlite'
  const match = /^electron\/sessionStorage\/(domain|public|application|infrastructure(?:\/[^/]+)?|host|maintenance)\//.exec(normalized)
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
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
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
    else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0].text, ['*'], false)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return edges
}

/** Resolve imports using the repository TypeScript configuration and enforce categorized module rules. */
export function findSessionStorageModuleViolations(filePath, source) {
  const category = categoryFor(filePath)
  if (!category) return []
  const sourceFile = ts.createSourceFile(path.resolve(root, filePath), source, ts.ScriptTarget.Latest, true)
  const allowed = (edge) => {
    if (category === 'external-electron') return !/^electron\/sessionStorage\/(?:application|infrastructure|internal)\//.test(edge.resolved)
    if (category === 'domain') return edge.resolved === 'src/shared/domainTypes'
    if (category === 'public') {
      return edge.resolved.startsWith('src/shared/') ||
        edge.resolved.startsWith('electron/sessionStorage/domain/') ||
        ['electron/sessionStorage/public/model', 'electron/sessionStorage/public/readPreparation'].includes(edge.resolved) ||
        (edge.resolved === 'electron/sessionStorage/public/ports' && edge.typeOnly && edge.symbols.length === 1 && edge.symbols[0] === 'SessionHistoryPort') ||
        edge.resolved.startsWith('packages/agent-sdk/')
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
          'electron/sessionStorage/host/ports'].includes(edge.resolved) ||
        edge.resolved.startsWith('electron/sessionStorage/public/') ||
        edge.resolved === 'electron/storage/sessionLedgerRoots' ||
        edge.resolved === 'electron/storage/spillProtocol' ||
        edge.resolved === 'electron/sessionLedgerIdentity' ||
        ['electron/sessionEvents', 'electron/queueInputFingerprint', 'electron/runtime/sqliteAgentHistory',
          'electron/runtime/sessionStorageShadow', 'electron/runtime/sessionTranscriptProjection',
          'electron/runtime/sessionContentWriteAuthority', 'electron/runtime/agentContinuation',
          'electron/runtime/continuationSummary', 'electron/runtime/terminalOutcome', 'electron/runtime/canonicalHistory',
          'electron/turnRuntime', 'electron/chatMessageBuild', 'electron/sessionContextCompaction', 'electron/sessionMetadataKeys'].includes(edge.resolved) ||
        edge.resolved.startsWith('src/shared/') || edge.resolved.startsWith('packages/agent-sdk/') || edge.resolved.startsWith('node:') ||
        edge.resolved === '../../node_modules/@types/proper-lockfile/index.d' ||
        edge.resolved === '../../node_modules/@types/proper-lockfile/index.d'
    }
    return false
  }
  return moduleEdges(sourceFile).filter((edge) => {
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

function main() {
  if (process.argv.includes('--probe-illegal-edge')) {
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
        (file, source) => findSessionStorageModuleViolations(file, source).length > 0]
    ]
    const missed = probes.filter(([, file, source, rejects]) => !rejects(file, source))
    if (missed.length > 0) {
      console.error('[check:session-storage-module-graph] illegal-edge probes were not rejected:')
      for (const [name] of missed) console.error(`  - ${name}`)
      process.exitCode = 1
      return
    }
    console.log(`[check:session-storage-module-graph] illegal-edge probes rejected as expected (${probes.length} probes)`)
    return
  }
  const sourceRoot = path.join(root, 'electron/sessionStorage')
  observedCrossDirectoryExceptions.clear()
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
  console.log(`[check:session-storage-module-graph] OK: categorized session-storage modules (${files.length} files); pending cross-directory exceptions (${crossDirectoryExceptions.size})`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
