#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sharedDir = path.join(root, 'src', 'shared')

function filesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) {
      return name === '__tests__' ? [] : filesUnder(file)
    }
    return /\.(?:ts|tsx|mts|cts)$/.test(file) && !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(file) ? [file] : []
  })
}

export function importsFrom(source, fileName = 'source.ts') {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
  const imports = []

  function addStringLiteral(node) {
    if (ts.isStringLiteralLike(node)) imports.push(node.text)
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      addStringLiteral(node.moduleSpecifier)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addStringLiteral(node.argument.literal)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      if (isRequire || isDynamicImport) addStringLiteral(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

export function isAgentSdkSpecifier(specifier) {
  if (specifier === '@spaceassistant/agent-sdk') return true
  const segments = specifier.replaceAll('\\', '/').split('/')
  return segments.some((segment, index) => segment === 'packages' && segments[index + 1] === 'agent-sdk')
}

export function scanSharedDependencies(directory = sharedDir, repositoryRoot = root) {
  const failures = []
  for (const file of filesUnder(directory)) {
    const rel = path.relative(repositoryRoot, file)
    for (const spec of importsFrom(readFileSync(file, 'utf8'), file)) {
      if (isAgentSdkSpecifier(spec)) {
        failures.push(`${rel}: src/shared 不得依赖 Agent SDK (${spec})`)
      }
    }
  }
  return failures
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArgIndex = process.argv.indexOf('--root')
  const scanRoot = rootArgIndex >= 0 ? path.resolve(process.argv[rootArgIndex + 1] ?? '.') : root
  const failures = scanSharedDependencies(path.join(scanRoot, 'src', 'shared'), scanRoot)
  if (failures.length) {
    console.error('[check:agent-sdk-dependencies] 依赖方向违规:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('[check:agent-sdk-dependencies] OK: src/shared 生产代码不依赖 Agent SDK')
}
