import { parsePythonModule } from '../../shell/scriptContentSecurity'
import { extractPowershellCommandFacts } from '../../shell/powershellCommandFacts'
import { foldStringIr, resolveIrChain, type IrScope } from '../../shell/scriptIr/pythonAdapter'
import type { IrExpr, IrModule, IrStmt } from '../../shell/scriptIr/types'
import { scriptParserService } from '../../shell/scriptParserService'
import * as ts from 'typescript'

export type ScriptPathFacts = { paths: string[]; completeness: 'complete' | 'unknown'; dynamicAccess: boolean }
export type ScriptPathLanguage = 'python' | 'javascript' | 'typescript' | 'powershell' | 'bash' | string

const FILE_CALLS = new Set([
  'open', 'builtins.open', 'io.open', 'pathlib.Path.open', 'pathlib.Path.read_text', 'pathlib.Path.read_bytes',
  'pathlib.Path.write_text', 'pathlib.Path.write_bytes', 'os.remove', 'os.unlink', 'os.rename',
  'os.replace', 'os.mkdir', 'os.makedirs', 'shutil.copy', 'shutil.copy2', 'shutil.move', 'shutil.rmtree'
])
const PROCESS_CALLS = new Set([
  'subprocess.run', 'subprocess.call', 'subprocess.Popen', 'subprocess.check_call',
  'subprocess.check_output', 'os.system', 'os.popen', 'os.exec', 'os.execv', 'os.execve',
  'os.spawn', 'pty.spawn', 'eval', 'exec', 'compile', '__import__', 'importlib.import_module'
])
const KNOWN_NON_IO_CALLS = new Set([
  'print', 'range', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes',
  'enumerate', 'zip', 'min', 'max', 'sum', 'abs', 'sorted', 'any', 'all', 'repr', 'type', 'isinstance'
])
const JS_FILE_APIS = new Set([
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'copyFile', 'copyFileSync',
  'lstat', 'lstatSync', 'mkdir', 'mkdirSync', 'open', 'openSync', 'readFile', 'readFileSync', 'readdir',
  'readdirSync', 'realpath', 'realpathSync', 'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'stat', 'statSync', 'unlink', 'unlinkSync', 'writeFile', 'writeFileSync', 'createReadStream', 'createWriteStream'
])
const JS_SAFE_CALLS = new Set(['console.log', 'console.info', 'console.warn', 'console.error', 'JSON.stringify', 'JSON.parse'])
const PS_FILE_APIS = new Set(['get-content', 'set-content', 'add-content', 'out-file', 'remove-item', 'new-item', 'copy-item', 'move-item', 'rename-item', 'clear-content'])
const PS_SAFE_CALLS = new Set(['write-output', 'write-host', 'write-warning', 'write-error', 'get-date', 'get-location', 'set-location', 'where-object', 'foreach-object', 'sort-object', 'select-object', 'measure-object'])

function emptyUnknown(): ScriptPathFacts {
  return { paths: [], completeness: 'unknown', dynamicAccess: true }
}

function newScope(): IrScope { return { modules: new Map(), attrs: new Map() } }

function bindImport(scope: IrScope, stmt: Extract<IrStmt, { kind: 'import' | 'from_import' }>): void {
  if (stmt.kind === 'import') {
    for (const item of stmt.names) {
      const root = item.module.split('.')[0] ?? item.module
      scope.modules.set(item.alias ?? root, item.module)
    }
  } else {
    for (const item of stmt.names) {
      if (item.name === '*') continue
      scope.attrs.set(item.alias ?? item.name, { module: stmt.module, attr: item.name })
    }
  }
}

function staticString(expr: IrExpr | undefined): string | null {
  if (!expr) return null
  return foldStringIr(expr)
}

function walkExpr(expr: IrExpr, scope: IrScope, paths: Set<string>, state: { unknown: boolean }): void {
  if (expr.kind === 'call') {
    const chain = resolveIrChain(expr.callee, scope).fullName
    if (chain && PROCESS_CALLS.has(chain)) state.unknown = true
    const pathMethod = expr.callee.kind === 'attr' ? expr.callee.attr : ''
    const receiver = expr.callee.kind === 'attr' ? expr.callee.base : undefined
    const receiverConstructor = receiver?.kind === 'call' ? resolveIrChain(receiver.callee, scope).fullName : undefined
    const isPathMethod = Boolean(receiverConstructor && (receiverConstructor === 'Path' || receiverConstructor.endsWith('.Path')) && ['open', 'read_text', 'read_bytes', 'write_text', 'write_bytes'].includes(pathMethod))
    if (isPathMethod) {
      const value = receiver?.kind === 'call' ? staticString(receiver.args[0]) : null
      if (value === null || receiver?.kind !== 'call' || receiver.args.length !== 1) state.unknown = true
      else paths.add(value)
    } else if (chain && FILE_CALLS.has(chain)) {
      const count = chain === 'os.rename' || chain === 'os.replace' || chain === 'shutil.copy' || chain === 'shutil.copy2' || chain === 'shutil.move' ? 2 : 1
      if (expr.args.length < count || expr.args.slice(0, count).some((arg) => staticString(arg) === null)) {
        state.unknown = true
      }
      for (const arg of expr.args.slice(0, count)) {
        const value = staticString(arg)
        if (value !== null) paths.add(value)
      }
      // Keyword paths are accepted only when their value is a static string.
      for (const kw of expr.kwargs) {
        if (['file', 'path', 'src', 'dst', 'source', 'destination'].includes(kw.name)) {
          const value = staticString(kw.value)
          if (value === null) state.unknown = true
          else paths.add(value)
        }
      }
    }
    const isPathConstructor = chain === 'Path' || Boolean(chain?.endsWith('.Path'))
    if (!(chain && (FILE_CALLS.has(chain) || PROCESS_CALLS.has(chain) || KNOWN_NON_IO_CALLS.has(chain))) && !isPathMethod && !isPathConstructor) state.unknown = true
    walkExpr(expr.callee, scope, paths, state)
    expr.args.forEach((arg) => walkExpr(arg, scope, paths, state))
    expr.kwargs.forEach((kw) => walkExpr(kw.value, scope, paths, state))
    return
  }
  switch (expr.kind) {
    case 'attr': walkExpr(expr.base, scope, paths, state); break
    case 'binop': walkExpr(expr.left, scope, paths, state); walkExpr(expr.right, scope, paths, state); break
    case 'unaryop': walkExpr(expr.operand, scope, paths, state); break
    case 'compare': walkExpr(expr.left, scope, paths, state); walkExpr(expr.right, scope, paths, state); break
    case 'boolop': expr.values.forEach((v) => walkExpr(v, scope, paths, state)); break
    case 'conditional': walkExpr(expr.test, scope, paths, state); walkExpr(expr.body, scope, paths, state); walkExpr(expr.orelse, scope, paths, state); break
    case 'list': case 'tuple': case 'set': expr.elts.forEach((v) => walkExpr(v, scope, paths, state)); break
    case 'dict': [...expr.keys, ...expr.values].forEach((v) => { if (v) walkExpr(v, scope, paths, state) }); break
    case 'subscript': walkExpr(expr.value, scope, paths, state); walkExpr(expr.index, scope, paths, state); break
    case 'slice': [expr.lower, expr.upper, expr.step].forEach((v) => { if (v) walkExpr(v, scope, paths, state) }); break
    case 'lambda': expr.defaults.forEach((v) => walkExpr(v, scope, paths, state)); walkExpr(expr.body, scope, paths, state); break
    case 'await': case 'starred': walkExpr(expr.value, scope, paths, state); break
    case 'yield': if (expr.value) walkExpr(expr.value, scope, paths, state); break
    case 'comprehension': walkExpr(expr.elt, scope, paths, state); expr.generators.forEach((g) => walkExpr(g.iter, scope, paths, state)); break
    case 'f_string': if (expr.interpolations.length) state.unknown = true; expr.interpolations.forEach((v) => walkExpr(v, scope, paths, state)); break
  }
}

function walkStatements(stmts: IrStmt[], inherited: IrScope, paths: Set<string>, state: { unknown: boolean }): void {
  const scope = { modules: new Map(inherited.modules), attrs: new Map(inherited.attrs) }
  for (const stmt of stmts) {
    if (stmt.kind === 'import' || stmt.kind === 'from_import') { bindImport(scope, stmt); continue }
    switch (stmt.kind) {
      case 'assign': stmt.targets.forEach((name) => { if (scope.modules.has(name) || scope.attrs.has(name)) state.unknown = true }); walkExpr(stmt.value, scope, paths, state); break
      case 'aug_assign': state.unknown = true; walkExpr(stmt.value, scope, paths, state); break
      case 'expr': walkExpr(stmt.value, scope, paths, state); break
      case 'if': walkExpr(stmt.test, scope, paths, state); walkStatements(stmt.body, scope, paths, state); walkStatements(stmt.orelse, scope, paths, state); break
      case 'for': walkExpr(stmt.iter, scope, paths, state); walkStatements(stmt.body, scope, paths, state); walkStatements(stmt.orelse, scope, paths, state); break
      case 'while': walkExpr(stmt.test, scope, paths, state); walkStatements(stmt.body, scope, paths, state); walkStatements(stmt.orelse, scope, paths, state); break
      case 'with': stmt.items.forEach((item) => walkExpr(item.contextExpr, scope, paths, state)); walkStatements(stmt.body, scope, paths, state); break
      case 'try': walkStatements(stmt.body, scope, paths, state); stmt.handlers.forEach((h) => { if (h.typeExpr) walkExpr(h.typeExpr, scope, paths, state); walkStatements(h.body, scope, paths, state) }); walkStatements(stmt.orelse, scope, paths, state); walkStatements(stmt.finalbody, scope, paths, state); break
      case 'function_def': state.unknown = true; stmt.defaults.forEach((v) => walkExpr(v, scope, paths, state)); stmt.decorators.forEach((v) => walkExpr(v, scope, paths, state)); walkStatements(stmt.body, scope, paths, state); break
      case 'class_def': state.unknown = true; stmt.bases.forEach((v) => walkExpr(v, scope, paths, state)); stmt.decorators.forEach((v) => walkExpr(v, scope, paths, state)); walkStatements(stmt.body, scope, paths, state); break
      case 'return': if (stmt.value) walkExpr(stmt.value, scope, paths, state); break
      case 'assert': walkExpr(stmt.test, scope, paths, state); break
      case 'raise': if (stmt.value) walkExpr(stmt.value, scope, paths, state); break
      case 'delete': stmt.targets.forEach((v) => { state.unknown = true; walkExpr(v, scope, paths, state) }); break
      case 'global_nonlocal': state.unknown = true; break
      case 'pass': case 'break': case 'continue': break
    }
  }
}

function staticTsString(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function extractTypeScriptPathFacts(code: string, language: 'javascript' | 'typescript'): ScriptPathFacts {
  const source = ts.createSourceFile(`run-script.${language === 'typescript' ? 'ts' : 'js'}`, code, ts.ScriptTarget.Latest, true, language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (parseDiagnostics.length > 0) return emptyUnknown()
  const modules = new Map<string, string>()
  const namedImports = new Map<string, { module: string; name: string }>()
  const paths = new Set<string>()
  const state = { unknown: false }
  const bindModule = (name: string, module: string) => { modules.set(name, module.replace(/^node:/, '')) }

  const moduleFromExpr = (expr: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expr)) return modules.get(expr.text)
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'require') {
      const moduleName = staticTsString(expr.arguments[0])
      if (!moduleName) state.unknown = true
      return moduleName?.replace(/^node:/, '')
    }
    return undefined
  }
  const resolveCall = (expr: ts.Expression): { module: string; name: string } | undefined => {
    if (ts.isIdentifier(expr)) return namedImports.get(expr.text)
    if (!ts.isPropertyAccessExpression(expr)) return undefined
    const module = moduleFromExpr(expr.expression)
    if (module) return { module, name: expr.name.text }
    const parent = resolveCall(expr.expression)
    if (parent) return { module: parent.module, name: `${parent.name}.${expr.name.text}` }
    return undefined
  }

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const module = statement.moduleSpecifier.text.replace(/^node:/, '')
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) bindModule(clause.name.text, module)
    const bindings = clause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) bindModule(bindings.name.text, module)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) namedImports.set(element.name.text, { module, name: element.propertyName?.text ?? element.name.text })
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassDeclaration(node) || ts.isImportEqualsDeclaration(node)) state.unknown = true
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const module = moduleFromExpr(node.initializer)
      if (module) bindModule(node.name.text, module)
    }
    if (ts.isCallExpression(node)) {
      const resolved = resolveCall(node.expression)
      const staticRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const moduleName = resolved?.module.replace(/^node:/, '')
      const callName = resolved?.name.split('.').at(-1) ?? ''
      if (moduleName === 'child_process' || moduleName === 'worker_threads') state.unknown = true
      else if (moduleName === 'fs' || moduleName === 'fs/promises') {
        if (!JS_FILE_APIS.has(callName)) state.unknown = true
        else {
          const count = ['rename', 'renameSync', 'copyFile', 'copyFileSync'].includes(callName) ? 2 : 1
          const targets = node.arguments.slice(0, count)
          if (targets.length < count) state.unknown = true
          for (const target of targets) {
            const value = staticTsString(target)
            if (value === undefined) state.unknown = true
            else paths.add(value)
          }
        }
      } else if (staticRequire) {
        const required = staticTsString(node.arguments[0])?.replace(/^node:/, '')
        if (required !== 'fs' && required !== 'fs/promises') state.unknown = true
      } else {
        const fullName = ts.isPropertyAccessExpression(node.expression)
          ? `${node.expression.expression.getText(source)}.${node.expression.name.text}`
          : ts.isIdentifier(node.expression) ? node.expression.text : ''
        if (!JS_SAFE_CALLS.has(fullName)) state.unknown = true
      }
      node.arguments.forEach(visit)
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (ts.isIdentifier(node.left) && (modules.has(node.left.text) || namedImports.has(node.left.text))) state.unknown = true
      if (ts.isPropertyAccessExpression(node.left)) {
        const binding = resolveCall(node.left)
        if (binding?.module === 'fs' || binding?.module === 'fs/promises') state.unknown = true
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return { paths: [...paths], completeness: state.unknown ? 'unknown' : 'complete', dynamicAccess: state.unknown }
}

function extractPowerShellPathFacts(code: string): ScriptPathFacts {
  if (!scriptParserService.getStatus().ready) return emptyUnknown()
  const facts = extractPowershellCommandFacts(code)
  if (!facts.ok) return emptyUnknown()
  const paths = new Set<string>()
  let unknown = facts.unresolved.length > 0 || facts.substitutions.length > 0
  for (const command of facts.commands) {
    const name = command.name.toLowerCase()
    if (name === 'start-process' || name === 'iex' || name === 'invoke-expression' || name === '&') { unknown = true; continue }
    if (PS_FILE_APIS.has(name)) {
      const values: string[] = []
      for (let i = 0; i < command.args.length; i += 1) {
        const arg = command.args[i]!
        if (/^-(?:literalpath|path|destination|newname)$/i.test(arg)) {
          const next = command.args[i + 1]
          if (!next || next.startsWith('-') || /[$(){}]/.test(next)) unknown = true
          else values.push(next.replace(/^(?:"(.*)"|'(.*)')$/, (_m, d: string | undefined, s: string | undefined) => d ?? s ?? next))
          i += 1
        } else if (!arg.startsWith('-')) {
          if (/[$(){}]/.test(arg)) unknown = true
          else values.push(arg.replace(/^(?:"(.*)"|'(.*)')$/, (_m, d: string | undefined, s: string | undefined) => d ?? s ?? arg))
        }
      }
      if (values.length === 0) unknown = true
      values.forEach((value) => paths.add(value))
    } else if (!PS_SAFE_CALLS.has(name)) unknown = true
  }
  return { paths: [...paths], completeness: unknown ? 'unknown' : 'complete', dynamicAccess: unknown }
}

/** 基于与脚本安全分析相同 Python 语法树 IR 提取文件路径；未知或间接效果一律 fail-closed。 */
export function extractScriptPathFacts(code: string, language: ScriptPathLanguage = 'python', preParsedIr?: IrModule): ScriptPathFacts {
  if (language === 'javascript' || language === 'typescript') return extractTypeScriptPathFacts(code, language)
  if (language === 'powershell') return extractPowerShellPathFacts(code)
  if (language !== 'python') return emptyUnknown()
  let ir = preParsedIr
  if (!ir) {
    try { ir = parsePythonModule(code) } catch { return emptyUnknown() }
  }
  if (!scriptParserService.getStatus().ready) return emptyUnknown()
  const paths = new Set<string>()
  const state = { unknown: false }
  try { walkStatements(ir.body, newScope(), paths, state) } catch { return emptyUnknown() }
  return { paths: [...paths], completeness: state.unknown ? 'unknown' : 'complete', dynamicAccess: state.unknown }
}
