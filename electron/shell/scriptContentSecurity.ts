/**
 * Python `run_script` content security analyzer.
 * P1-T3 起：解析前端为 tree-sitter-python（ScriptParserService）+ scriptIr 适配器产出的
 * 事实 IR；本文件保留 Analyzer（A0–A9/B1–B11）/ uncertainty collector / 模式 ID 体系等全部
 * 判定语义，消费对象自研 AST 换为 IR（§2.2 锚点契约逐条保持）。
 */
import { scriptParserService } from './scriptParserService'
import { adaptPythonModule, foldStringIr } from './scriptIr/pythonAdapter'
import { type IrExpr, type IrModule, type IrStmt, type SourceRange } from './scriptIr/types'
import type { ScriptFinding, ScriptFindingEvidence, ScriptUncertainty } from '../../src/shared/confirmation/types'

export interface ScriptAnalysisResult {
  findings: ScriptFinding[]
  coverage: 'complete' | 'partial' | 'failed'
  totalCount: number
  uncertainties: ScriptUncertainty[]
  reason?: string
}

export interface PatternHit {
  pattern: string
  range?: SourceRange
  evidence?: ScriptFindingEvidence
}

// --- Dangerous sets ---

export const DANGEROUS_MODULES = new Set([
  'os',
  'subprocess',
  'pty',
  'ctypes',
  'cffi',
  'socket',
  'urllib',
  'http',
  'requests',
  'httpx',
  'importlib',
  'builtins',
  'shutil',
  'pathlib',
  'sys',
  'asyncio',
  'multiprocessing', 'concurrent', 'pickle', 'marshal', 'ftplib', 'smtplib', 'xmlrpc', 'telnetlib'
])

export const NETWORK_MODULES = new Set([
  'socket',
  'urllib',
  'http',
  'requests',
  'httpx', 'ftplib', 'smtplib', 'xmlrpc', 'telnetlib'
])

export const DANGEROUS_ATTRS = new Set([
  'system',
  'popen',
  'remove',
  'unlink',
  'rmtree',
  'rmdir',
  'exec',
  'eval',
  'execv',
  'execve',
  'execvp',
  'call',
  'run',
  'Popen',
  'check_output',
  'check_call',
  'CDLL',
  'WinDLL',
  // Process-creation capability table (WP3 item 2): os.spawn*/posix_spawn* family.
  'spawnl',
  'spawnle',
  'spawnlp',
  'spawnlpe',
  'spawnv',
  'spawnve',
  'spawnvp',
  'spawnvpe',
  'posix_spawn',
  'posix_spawnp',
  // asyncio.create_subprocess_* family.
  'create_subprocess_exec',
  'create_subprocess_shell'
])

/** os.spawn family / posix_spawn family attrs — merged into the A1 (process creation) ask bucket. */
const OS_SPAWN_ATTRS = new Set([
  'spawnl',
  'spawnle',
  'spawnlp',
  'spawnlpe',
  'spawnv',
  'spawnve',
  'spawnvp',
  'spawnvpe',
  'posix_spawn',
  'posix_spawnp'
])

/** asyncio.create_subprocess_* attrs — merged into the A1 (process creation) ask bucket. */
const ASYNCIO_PROCESS_ATTRS = new Set(['create_subprocess_exec', 'create_subprocess_shell'])
const PROCESS_CREATION_CALLS = new Set(['Process', 'Pool', 'ProcessPoolExecutor'])
const DESERIALIZATION_CALLS = new Set(['load', 'loads'])

/** Reflection builtins whose behavior remains uncertain, even when their arguments resolve. */
const REFLECTION_NAMES = new Set(['getattr', 'hasattr', 'setattr', 'delattr', 'vars', 'globals', 'locals'])

/** Bare builtin identifiers whose direct aliasing (`f = eval`) must still be tracked as dangerous. */
const DANGEROUS_BUILTIN_NAMES = new Set([
  'eval',
  'exec',
  'compile',
  '__import__',
  'getattr',
  'hasattr',
  'setattr',
  'delattr',
  'vars',
  'globals',
  'locals'
])

const A1_OS_ATTRS = new Set(['system', 'popen'])
const EXEC_NAMES = new Set(['eval', 'exec', 'compile'])
const DECODE_FUNCS = new Set(['b64decode', 'decode', 'fromhex'])
const EXEC_IMPORT_NAMES = new Set(['eval', 'exec', 'compile', '__import__'])

/** 解析失败 / 服务未就绪（等价 parse 失败，§3 不变量 1(a)(b)）。 */
export class ScriptParseUnavailableError extends Error {
  constructor(public readonly reason: 'not_initialized' | 'parse_error') {
    super(`script parse unavailable: ${reason}`)
    this.name = 'ScriptParseUnavailableError'
  }
}

/**
 * P1-T3：ScriptParserService.parse('python') → scriptIr 适配器 → IR 根。
 * 失败语义与旧实现对齐：抛错（解析失败 → ScriptParseUnavailableError；适配器未覆盖
 * 构造 → IrCoverageError），由调用方既有 catch 通道统一落 `A-fail`/`extraction-failed`。
 */
export function parsePythonModule(source: string): IrModule {
  const outcome = scriptParserService.parse('python', source)
  if (!outcome.ok) throw new ScriptParseUnavailableError(outcome.reason)
  try {
    return adaptPythonModule(outcome.tree)
  } finally {
    outcome.tree.delete()
  }
}

// --- String folding（IR 版本，折叠规则与旧实现一致 + f-string 全静态折叠）---

export function foldStringExpr(expr: IrExpr): string | null {
  return foldStringIr(expr)
}

// --- Scope / resolution ---

interface Binding {
  module: string
  attr?: string
}

/** Facts-stage heap escape state: shared by lexical child scopes; invalidation is monotonic for this analysis. */
interface HeapFacts {
  invalidatedObjects: Set<number>
  nextObjectId: number
  expressionObjectIds: WeakMap<object, number>
}

interface Scope {
  modules: Map<string, string>
  attrs: Map<string, Binding>
  unknownRoots: Set<string>
  knownPrimitiveRoots: Set<string>
  mutableObjectIds: Map<string, Set<number>>
  heap: HeapFacts
  knownClassRoots: Set<string>
  shadowedBuiltinRoots: Set<string>
  classBody: boolean
}

function createScope(parent?: Scope): Scope {
  return {
    modules: new Map(parent?.modules),
    attrs: new Map(parent?.attrs),
    unknownRoots: new Set(parent?.unknownRoots),
    knownPrimitiveRoots: new Set(parent?.knownPrimitiveRoots),
    mutableObjectIds: new Map([...parent?.mutableObjectIds ?? []].map(([key, ids]) => [key, new Set(ids)])),
    heap: parent?.heap ?? { invalidatedObjects: new Set(), nextObjectId: 1, expressionObjectIds: new WeakMap() },
    knownClassRoots: new Set(parent?.knownClassRoots),
    shadowedBuiltinRoots: new Set(parent?.shadowedBuiltinRoots),
    classBody: parent?.classBody ?? false
  }
}

function isKnownPrimitiveExpr(expr: IrExpr, scope: Scope): boolean {
  switch (expr.kind) {
    case 'string': case 'number': case 'bool': case 'none': case 'ellipsis': return true
    case 'name': return scope.knownPrimitiveRoots.has(expr.id) &&
      [...(scope.mutableObjectIds.get(expr.id) ?? [])].every((id) => !scope.heap.invalidatedObjects.has(id))
    case 'f_string': return expr.interpolations.every((item) => isKnownPrimitiveExpr(item, scope))
    case 'list': case 'tuple': case 'set': return expr.elts.every((item) => isKnownPrimitiveExpr(item, scope))
    case 'dict': return expr.keys.every((item) => item === null || isKnownPrimitiveExpr(item, scope)) && expr.values.every((item) => isKnownPrimitiveExpr(item, scope))
    case 'slice': return (!expr.lower || isKnownPrimitiveExpr(expr.lower, scope)) && (!expr.upper || isKnownPrimitiveExpr(expr.upper, scope)) && (!expr.step || isKnownPrimitiveExpr(expr.step, scope))
    case 'subscript': return isKnownPrimitiveExpr(expr.value, scope) && isKnownPrimitiveExpr(expr.index, scope)
    case 'binop': return isKnownPrimitiveExpr(expr.left, scope) && isKnownPrimitiveExpr(expr.right, scope)
    case 'unaryop': return isKnownPrimitiveExpr(expr.operand, scope)
    case 'compare': return isKnownPrimitiveExpr(expr.left, scope) && isKnownPrimitiveExpr(expr.right, scope)
    case 'boolop': return expr.values.every((item) => isKnownPrimitiveExpr(item, scope))
    case 'conditional': return isKnownPrimitiveExpr(expr.test, scope) && isKnownPrimitiveExpr(expr.body, scope) && isKnownPrimitiveExpr(expr.orelse, scope)
    case 'comprehension': {
      const child = createScope(scope)
      for (const generator of expr.generators) {
        if (!isKnownPrimitiveIterable(generator.iter, child) || generator.conditions.some((condition) => !isKnownPrimitiveExpr(condition, child))) return false
        for (const target of bindingNames(generator.target)) { child.unknownRoots.delete(target); child.knownPrimitiveRoots.add(target); child.mutableObjectIds.delete(target) }
      }
      return expr.elt.kind === 'tuple' ? expr.elt.elts.every((item) => isKnownPrimitiveExpr(item, child)) : isKnownPrimitiveExpr(expr.elt, child)
    }
    default: return false
  }
}

function isKnownPrimitiveIterable(expr: IrExpr, scope: Scope): boolean {
  if (isKnownPrimitiveExpr(expr, scope)) return true
  if (expr.kind !== 'call' || expr.callee.kind !== 'name' || expr.callee.id !== 'range') return false
  return expr.args.every((arg) => isKnownPrimitiveExpr(arg, scope)) && expr.kwargs.every((arg) => isKnownPrimitiveExpr(arg.value, scope))
}

function hasKnownAttributeOrigin(expr: IrExpr, scope: Scope): boolean {
  const chain = resolveExprChain(expr, scope)
  return Boolean(chain.root && (scope.modules.has(chain.root) || scope.attrs.has(chain.root) || scope.knownPrimitiveRoots.has(chain.root) || scope.knownClassRoots.has(chain.root)))
}

function expressionObjectId(expr: IrExpr, scope: Scope): number {
  let id = scope.heap.expressionObjectIds.get(expr)
  if (id === undefined) { id = scope.heap.nextObjectId++; scope.heap.expressionObjectIds.set(expr, id) }
  return id
}

function collectAssignedObjectIds(expr: IrExpr, scope: Scope, output = new Set<number>()): Set<number> {
  const initialSize = output.size
  const visit = (node: IrExpr | null | undefined) => { if (node) collectAssignedObjectIds(node, scope, output) }
  switch (expr.kind) {
    case 'name': {
      for (const id of scope.mutableObjectIds.get(expr.id) ?? []) output.add(id)
      if (output.size === initialSize && !isKnownPrimitiveExpr(expr, scope) && !scope.modules.has(expr.id)) output.add(expressionObjectId(expr, scope))
      break
    }
    case 'list': case 'dict': case 'set':
      output.add(expressionObjectId(expr, scope))
      if (expr.kind === 'dict') { expr.keys.forEach(visit); expr.values.forEach(visit) } else expr.elts.forEach(visit)
      break
    case 'tuple': expr.elts.forEach(visit); break
    case 'conditional': visit(expr.body); visit(expr.orelse); break
    case 'binop': { const before = output.size; visit(expr.left); visit(expr.right); if (output.size > before) output.add(expressionObjectId(expr, scope)); break }
    case 'comprehension': if (expr.compKind !== 'generator') output.add(expressionObjectId(expr, scope)); visit(expr.elt); expr.generators.forEach((g) => { visit(g.iter); g.conditions.forEach(visit) }); break
    case 'call': case 'attr': case 'subscript': case 'await': case 'lambda':
      if (!isKnownPrimitiveExpr(expr, scope)) output.add(expressionObjectId(expr, scope))
      if (expr.kind === 'call') { visit(expr.callee); expr.args.forEach(visit); expr.kwargs.forEach((kw) => visit(kw.value)) }
      else if (expr.kind === 'attr') visit(expr.base)
      else if (expr.kind === 'subscript') { visit(expr.value); visit(expr.index) }
      else if (expr.kind === 'await') visit(expr.value)
      else expr.defaults.forEach(visit)
      break
    case 'slice': visit(expr.lower); visit(expr.upper); visit(expr.step); break
    case 'starred': visit(expr.value); break
    case 'unaryop': visit(expr.operand); break
    case 'compare': visit(expr.left); visit(expr.right); break
    case 'boolop': expr.values.forEach(visit); break
    case 'f_string': expr.interpolations.forEach(visit); break
    case 'named_expr': visit(expr.value); break
    case 'yield': visit(expr.value); break
  }
  if (!isKnownPrimitiveExpr(expr, scope) && output.size === initialSize && expr.kind !== 'name' && expr.kind !== 'tuple') output.add(expressionObjectId(expr, scope))
  return output
}

function setPrimitiveBinding(target: string, value: IrExpr, scope: Scope): void {
  const objectIds = collectAssignedObjectIds(value, scope)
  if (objectIds.size) scope.mutableObjectIds.set(target, objectIds)
  else scope.mutableObjectIds.delete(target)
  if (isKnownPrimitiveExpr(value, scope)) scope.knownPrimitiveRoots.add(target)
  else scope.knownPrimitiveRoots.delete(target)
}

function invalidateBinding(name: string, scope: Scope): void {
  const key = name.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return
  if (key === 'print') scope.shadowedBuiltinRoots.add(key)
  scope.modules.delete(key)
  scope.attrs.delete(key)
  scope.knownPrimitiveRoots.delete(key)
  scope.mutableObjectIds.delete(key)
  scope.knownClassRoots.delete(key)
  scope.unknownRoots.add(key)
}

function bindingNames(text: string): string[] {
  return text.split(',').map((name) => name.trim()).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
}

function collectExprWrites(expr: IrExpr, names: Set<string>): void {
  const visit = (e: IrExpr | null | undefined) => { if (e) collectExprWrites(e, names) }
  switch (expr.kind) {
    case 'named_expr': names.add(expr.target); visit(expr.value); break
    case 'attr': visit(expr.base); break
    case 'call': visit(expr.callee); expr.args.forEach(visit); expr.kwargs.forEach((kw) => visit(kw.value)); break
    case 'binop': case 'compare': visit(expr.left); visit(expr.right); break
    case 'unaryop': visit(expr.operand); break
    case 'await': case 'starred': visit(expr.value); break
    case 'boolop': expr.values.forEach(visit); break
    case 'conditional': visit(expr.test); visit(expr.body); visit(expr.orelse); break
    case 'list': case 'tuple': case 'set': expr.elts.forEach(visit); break
    case 'dict': expr.keys.forEach(visit); expr.values.forEach(visit); break
    case 'subscript': visit(expr.value); visit(expr.index); break
    case 'slice': visit(expr.lower); visit(expr.upper); visit(expr.step); break
    case 'f_string': expr.interpolations.forEach(visit); break
    case 'lambda': expr.defaults.forEach(visit); break
    case 'comprehension': visit(expr.elt); expr.generators.forEach((g) => { visit(g.iter); g.conditions.forEach(visit) }); break
    case 'yield': visit(expr.value); break
  }
}

function writtenNames(stmts: IrStmt[]): Set<string> {
  const names = new Set<string>()
  const add = (raw: string) => raw.split(',').forEach((name) => { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())) names.add(name.trim()) })
  for (const stmt of stmts) {
    if (stmt.kind === 'assign') { stmt.targets.forEach(add); collectExprWrites(stmt.value, names); if (stmt.annotation) collectExprWrites(stmt.annotation, names) }
    else if (stmt.kind === 'annotation') collectExprWrites(stmt.annotation, names)
    else if (stmt.kind === 'aug_assign') { add(stmt.target); collectExprWrites(stmt.targetExpr, names); collectExprWrites(stmt.value, names) }
    else if (stmt.kind === 'for') { add(stmt.target); writtenNames([...stmt.body, ...stmt.orelse]).forEach((n) => names.add(n)) }
    else if (stmt.kind === 'if' || stmt.kind === 'while') { collectExprWrites(stmt.test, names); writtenNames([...stmt.body, ...stmt.orelse]).forEach((n) => names.add(n)) }
    else if (stmt.kind === 'with') { stmt.items.flatMap((item) => item.optionalVars).forEach(add); writtenNames(stmt.body).forEach((n) => names.add(n)) }
    else if (stmt.kind === 'try') writtenNames([...stmt.body, ...stmt.handlers.flatMap((h) => h.body), ...stmt.orelse, ...stmt.finalbody]).forEach((n) => names.add(n))
    else if (stmt.kind === 'function_def' || stmt.kind === 'class_def') { add(stmt.name); if (stmt.kind === 'function_def') { stmt.defaults.forEach((e) => collectExprWrites(e, names)); stmt.decorators.forEach((e) => collectExprWrites(e, names)); (stmt.annotations ?? []).forEach((e) => collectExprWrites(e, names)) } else { stmt.bases.forEach((e) => collectExprWrites(e, names)); stmt.decorators.forEach((e) => collectExprWrites(e, names)) } }
    else if (stmt.kind === 'import') stmt.names.forEach((item) => add(item.alias ?? item.module.split('.')[0]!))
    else if (stmt.kind === 'from_import') stmt.names.forEach((item) => { if (item.name !== '*') add(item.alias ?? item.name) })
    else if (stmt.kind === 'expr') collectExprWrites(stmt.value, names)
    else if (stmt.kind === 'return') collectExprWrites(stmt.value ?? { kind: 'none' }, names)
    else if (stmt.kind === 'raise') { collectExprWrites(stmt.value ?? { kind: 'none' }, names); collectExprWrites(stmt.cause ?? { kind: 'none' }, names) }
    else if (stmt.kind === 'assert') { collectExprWrites(stmt.test, names); if (stmt.message) collectExprWrites(stmt.message, names) }
  }
  return names
}

function invalidateBranchWrites(stmts: IrStmt[], scope: Scope, preserve: ReadonlySet<string> = new Set()): void {
  for (const name of writtenNames(stmts)) if (!preserve.has(name)) invalidateBinding(name, scope)
}

function mutableObjectsReachable(expr: IrExpr, scope: Scope, output = new Set<number>()): Set<number> {
  const visit = (item: IrExpr | null | undefined) => { if (item) mutableObjectsReachable(item, scope, output) }
  switch (expr.kind) {
    case 'name': {
      const ids = scope.mutableObjectIds.get(expr.id)
      if (ids) for (const id of ids) output.add(id)
      break
    }
    case 'list': case 'tuple': case 'set': expr.elts.forEach(visit); break
    case 'dict': expr.keys.forEach(visit); expr.values.forEach(visit); break
    case 'attr': visit(expr.base); break
    case 'subscript': visit(expr.value); visit(expr.index); break
    case 'slice': visit(expr.lower); visit(expr.upper); visit(expr.step); break
    case 'starred': case 'await': visit(expr.value); break
    case 'call': visit(expr.callee); expr.args.forEach(visit); expr.kwargs.forEach((kw) => visit(kw.value)); break
    case 'binop': case 'compare': visit(expr.left); visit(expr.right); break
    case 'unaryop': visit(expr.operand); break
    case 'boolop': expr.values.forEach(visit); break
    case 'conditional': visit(expr.test); visit(expr.body); visit(expr.orelse); break
    case 'f_string': expr.interpolations.forEach(visit); break
    case 'lambda': expr.defaults.forEach(visit); break
    case 'comprehension': visit(expr.elt); expr.generators.forEach((g) => { visit(g.iter); g.conditions.forEach(visit) }); break
    case 'named_expr': visit(expr.value); break
    case 'yield': visit(expr.value); break
  }
  return output
}

export interface ResolvedChain {
  root: string | null
  module: string | null
  attrs: string[]
  fullName: string | null
}

export function resolveExprChain(expr: IrExpr, scope: Scope): ResolvedChain {
  const attrs: string[] = []
  let root: string | null = null
  let module: string | null = null
  let cur: IrExpr = expr

  if (cur.kind === 'name') {
    root = cur.id
    if (scope.unknownRoots.has(cur.id)) {
      module = null
    } else if (scope.modules.has(cur.id)) {
      module = scope.modules.get(cur.id)!
    } else if (scope.attrs.has(cur.id)) {
      const b = scope.attrs.get(cur.id)!
      module = b.module
      if (b.attr) attrs.push(b.attr)
    } else {
      module = cur.id
    }
    return { root, module, attrs, fullName: module + (attrs.length ? '.' + attrs.join('.') : '') }
  }

  if (cur.kind === 'attr') {
    const base = resolveExprChain(cur.base, scope)
    attrs.push(...base.attrs, cur.attr)
    module = base.module
    root = base.root
    const mod = module ?? base.root
    return { root, module: mod, attrs, fullName: mod ? mod + '.' + attrs.join('.') : null }
  }

  if (cur.kind === 'call') {
    return resolveExprChain(cur.callee, scope)
  }

  return { root: null, module: null, attrs: [], fullName: null }
}

function isDangerousModule(name: string | null): boolean {
  return name !== null && DANGEROUS_MODULES.has(name.split('.')[0]!)
}

function isNetworkModule(name: string | null): boolean {
  return name !== null && NETWORK_MODULES.has(name.split('.')[0]!)
}

function implicitAssignmentTarget(target: string): boolean {
  const bracket = target.indexOf('[')
  // The IR does not prove the concrete receiver protocol at an indexed write target.
  if (bracket >= 0) return true
  return target.includes('.')
}

function isDangerousAttr(name: string): boolean {
  return DANGEROUS_ATTRS.has(name)
}

function isWriteMode(mode: string | null): boolean {
  if (!mode) return false
  return /[wax\+]/.test(mode) && !/^r$/.test(mode)
}

function classifyPath(path: string): 'absolute' | 'dotdot' | 'relative' {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return 'absolute'
  if (/(^|[\\/])\.\.([\\/]|$)/.test(path) || path.startsWith('..')) return 'dotdot'
  return 'relative'
}

function sameRange(a?: SourceRange, b?: SourceRange): boolean {
  return a === b || (!!a && !!b && a.startLine === b.startLine && a.startCol === b.startCol && a.endLine === b.endLine && a.endCol === b.endCol)
}

function applyImportStmt(stmt: Extract<IrStmt, { kind: 'import' }>, scope: Scope): void {
  for (const { module, alias } of stmt.names) {
    const root = module.split('.')[0]!
    const bound = alias ?? root
    if (bound === 'print') scope.shadowedBuiltinRoots.add(bound)
    scope.unknownRoots.delete(bound)
    scope.knownPrimitiveRoots.delete(bound)
    scope.mutableObjectIds.delete(bound)
    scope.knownClassRoots.delete(bound)
    scope.attrs.delete(bound)
    scope.modules.set(bound, root)
  }
}

function applyFromImportStmt(stmt: Extract<IrStmt, { kind: 'from_import' }>, scope: Scope): void {
  const mod = stmt.module
  for (const { name, alias } of stmt.names) {
    if (name === '*') {
      scope.modules.set(mod, mod)
      continue
    }
    const bound = alias ?? name
    if (bound === 'print') scope.shadowedBuiltinRoots.add(bound)
    scope.unknownRoots.delete(bound)
    scope.knownPrimitiveRoots.delete(bound)
    scope.mutableObjectIds.delete(bound)
    scope.knownClassRoots.delete(bound)
    scope.modules.delete(bound)
    scope.attrs.set(bound, { module: mod, attr: name })
    if (isDangerousAttr(name)) {
      scope.attrs.set(bound, { module: mod, attr: name })
    }
  }
}

/**
 * Track name → dangerous module / callable after simple assignments (closes rebind bypass).
 * Also tracks direct aliasing of bare dangerous builtins (e.g. `imp = __import__`,
 * `g = getattr`) which are never registered via import/from-import scope tracking.
 */
function applyAssignmentRebind(target: string, value: IrExpr, scope: Scope): void {
  // facts: name spelling alone cannot prove a trusted builtin after any local rebinding.
  if (target === 'print') scope.shadowedBuiltinRoots.add(target)
  const sourceModuleBinding = value.kind === 'name' ? scope.modules.get(value.id) : undefined
  const sourceAttrBinding = value.kind === 'name' ? scope.attrs.get(value.id) : undefined
  const sourceAttrChain = value.kind === 'attr' ? resolveExprChain(value, scope) : undefined
  const sourceUnknown = value.kind === 'name' && scope.unknownRoots.has(value.id)
  // A binding update replaces every old proof atomically. Parallel maps must never retain an
  // earlier module/attribute/class/primitive claim after the name is rebound.
  scope.unknownRoots.delete(target)
  scope.modules.delete(target)
  scope.attrs.delete(target)
  scope.knownClassRoots.delete(target)
  setPrimitiveBinding(target, value, scope)
  if (value.kind === 'name') {
    if (sourceUnknown) {
      scope.unknownRoots.add(target)
      return
    }
    if (sourceModuleBinding) {
      scope.modules.set(target, sourceModuleBinding)
      return
    }
    if (sourceAttrBinding) {
      scope.attrs.set(target, { module: sourceAttrBinding.module, attr: sourceAttrBinding.attr })
      return
    }
    if (DANGEROUS_BUILTIN_NAMES.has(value.id)) {
      scope.attrs.set(target, { module: 'builtins', attr: value.id })
      return
    }
    return
  }
  if (value.kind === 'attr') {
    const lastAttr = sourceAttrChain?.attrs.at(-1)
    if (sourceAttrChain?.module && lastAttr) {
      scope.attrs.set(target, { module: sourceAttrChain.module, attr: lastAttr })
      return
    }
    return
  }
  if (value.kind === 'call' || value.kind === 'comprehension') scope.unknownRoots.add(target)
}

/** Extract a static Path(...) constructor literal path, if resolvable, for write-path checks. */
function extractPathLiteral(base: IrExpr, scope: Scope): string | null {
  if (base.kind === 'call') {
    const ctor = resolveExprChain(base.callee, scope)
    const pathBinding = ctor.root ? scope.attrs.get(ctor.root) : undefined
    const isPath = (ctor.module === 'pathlib' && ctor.attrs.at(-1) === 'Path') ||
      (pathBinding?.module === 'pathlib' && pathBinding.attr === 'Path')
    if (isPath && base.args.length === 1 && base.kwargs.length === 0) {
      const arg = base.args[0]
      return arg ? foldStringExpr(arg) : null
    }
  }
  return null
}

function isDecodeCall(expr: IrExpr): boolean {
  if (expr.kind !== 'call') return false
  const chain = resolveExprChain(expr.callee, createScope())
  const last = chain.attrs[chain.attrs.length - 1] ?? chain.module
  return last !== null && DECODE_FUNCS.has(last)
}

function decodeFunctionName(expr: IrExpr): string {
  if (expr.kind !== 'call') return 'unknown'
  const chain = resolveExprChain(expr.callee, createScope())
  return chain.attrs.at(-1) ?? chain.module ?? 'unknown'
}

type DecodeBinding = { name: string; stmtOffset: number; decodeFn: string }

function isExecImportCallee(callee: IrExpr): boolean {
  if (callee.kind === 'name') return EXEC_IMPORT_NAMES.has(callee.id)
  if (callee.kind === 'attr') {
    const folded = foldStringExpr({ kind: 'string', value: callee.attr }) // noop, attr is ident
    void folded
    return EXEC_IMPORT_NAMES.has(callee.attr)
  }
  const chain = resolveExprChain(callee, createScope())
  const last = chain.attrs[chain.attrs.length - 1]
  if (last && EXEC_IMPORT_NAMES.has(last)) return true
  if (chain.module === 'builtins' && last && EXEC_IMPORT_NAMES.has(last)) return true
  return false
}

// --- Analyzer ---


class Analyzer {
  private readonly hits: PatternHit[] = []
  private readonly uncertainties: ScriptUncertainty[] = []
  private activeRange?: SourceRange
  private activeExpr?: IrExpr
  private activeScope?: Scope

  analyze(ast: IrModule): PatternHit[] {
    this.walkStmts(ast.body, createScope(), 0)
    return this.hits
  }

  getUncertainties(): ScriptUncertainty[] { return this.uncertainties }

  private addHit(pattern: string, evidenceOverride?: ScriptFindingEvidence): void {
    const range = this.activeExpr?.range ?? this.activeRange
    const evidence = evidenceOverride ?? this.findingEvidence(pattern)
    const existing = this.hits.find((hit) => hit.pattern === pattern && sameRange(hit.range, range))
    if (existing) {
      if (!existing.evidence && evidence) existing.evidence = evidence
      return
    }
    this.hits.push({ pattern, range, evidence })
  }

  private findingEvidence(pattern: string): ScriptFindingEvidence | undefined {
    const expr = this.activeExpr
    if (!expr || expr.kind !== 'call') return undefined
    const scope = this.activeScope ?? createScope()
    const chain = resolveExprChain(expr.callee, scope)
    const attr = chain.attrs.at(-1) ?? (expr.callee.kind === 'name' ? expr.callee.id : '')
    if (pattern === 'A1') {
      const argvLiteral = expr.args[0] ? foldStringExpr(expr.args[0]) ?? undefined : undefined
      return { kind: 'process-create', module: chain.module ?? chain.root ?? 'unknown', attr, argvLiteral }
    }
    if (pattern === 'A2') {
      const pathExpr = expr.args[0] ?? (expr.callee.kind === 'attr' ? expr.callee.base : undefined)
      const rawPath = pathExpr ? foldStringIr(pathExpr) : null
      return { kind: 'fs-destructive', operation: attr || 'unknown', rawPath, pathClass: rawPath ? classifyPath(rawPath) : 'unresolved' }
    }
    if (pattern === 'A7' || pattern === 'A8') {
      const isOpen = expr.callee.kind === 'name' && expr.callee.id === 'open'
      const pathExpr = isOpen ? expr.args[0] : expr.callee.kind === 'attr' ? expr.callee.base : undefined
      const modeExpr = expr.kwargs.find((kw) => kw.name === 'mode')?.value ?? expr.args[1]
      const mode = isOpen && modeExpr ? foldStringIr(modeExpr) : null
      // A call's first argument is not necessarily its resulting path (for example os.path.join).
      const rawPath = pathExpr ? foldStringIr(pathExpr) ?? extractPathLiteral(pathExpr, scope) : null
      return {
        kind: 'write-path',
        call: isOpen ? 'open' : attr || 'unknown',
        mode,
        rawPath,
        pathClass: rawPath ? classifyPath(rawPath) : 'unresolved'
      }
    }
    if (pattern === 'A3') {
      const entry = attr || (expr.callee.kind === 'name' ? expr.callee.id : 'unknown')
      const arg = expr.args[0]
      return { kind: 'dynamic-exec', entry, ...(arg?.kind === 'name' ? { boundName: arg.id } : {}) }
    }
    if (pattern === 'A4' || pattern === 'B4' || pattern === 'B10') {
      const moduleName = foldStringExpr(expr.args[0] ?? { kind: 'none' })
      const isImportCall = attr === 'import_module' || attr === '__import__' || expr.callee.kind === 'name' && expr.callee.id === '__import__'
      if (pattern === 'B4' && !isImportCall) {
        return { kind: 'alias', alias: chain.root ?? attr, resolved: chain.fullName ?? attr }
      }
      if (pattern !== 'B10' || isImportCall) {
        return { kind: 'dynamic-import', moduleName, ...(expr.args[1]?.kind === 'name' ? { boundName: expr.args[1].id } : {}) }
      }
    }
    if (pattern === 'A5') {
      const module = chain.module === 'cffi' ? 'cffi' : 'ctypes'
      const symbol = expr.args[0] ? foldStringExpr(expr.args[0]) ?? undefined : undefined
      return { kind: 'native-code', module, ...(symbol ? { symbol } : {}) }
    }
    if (pattern === 'A6' || pattern === 'B10') {
      const module = chain.module ?? chain.root ?? 'unknown'
      const hostLiteral = expr.args[0] ? foldStringExpr(expr.args[0]) : null
      let host: string | undefined
      if (hostLiteral) {
        try { host = new URL(hostLiteral).hostname || undefined } catch { host = undefined }
      }
      return { kind: 'network', module, attr, ...(host ? { host } : {}) }
    }
    if (pattern === 'A9') {
      const rawPath = expr.args[0] ? foldStringExpr(expr.args[0]) : null
      return { kind: 'cwd-change', rawPath, pathClass: rawPath ? classifyPath(rawPath) : 'unresolved' }
    }
    if (['B1', 'B2', 'B3', 'B8'].includes(pattern)) {
      const target = expr.args[1] ? foldStringExpr(expr.args[1]) : null
      return { kind: 'reflection', target: target ?? attr, ...(chain.fullName ? { resolvedChain: chain.fullName } : {}) }
    }
    if (['B5', 'B6', 'B7'].includes(pattern)) {
      return { kind: 'alias', alias: chain.root ?? attr, resolved: chain.fullName ?? attr }
    }
    if (pattern === 'B9') {
      return { kind: 'dynamic-dispatch', unresolvableReason: expr.callee.kind === 'subscript' ? 'computed-member-index' : 'unresolved-reflection-target' }
    }
    return undefined
  }

  private walkStmts(stmts: IrStmt[], scope: Scope, startIndex: number, inheritedDecodeBindings?: DecodeBinding[]): void {
    // v5 评审 N14:decode→exec 链必须贯穿块边界——if test 里的 walrus 登记、
    // while body 内的 decode 赋值,在其后的语句(含嵌套块)应可见(词法作用域真实语义;
    // 窗口 ≤3 语句由 checkB11 兜底防远距误报)。
    const decodeBindings = inheritedDecodeBindings ?? []

    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]!
      this.activeRange = stmt.range
      const stmtIndex = startIndex + i

      if (stmt.kind === 'import') {
        applyImportStmt(stmt, scope)
        continue
      }

      if (stmt.kind === 'from_import') {
        applyFromImportStmt(stmt, scope)
        const mod = stmt.module.split('.')[0]!
        if (isDangerousModule(mod)) {
          for (const { name, alias } of stmt.names) {
            if (name !== '*' && isDangerousAttr(name)) {
              this.addHit(alias ? 'B7' : 'B6', {
                kind: 'alias', alias: alias ?? name, resolved: `${mod}.${name}`
              })
            }
          }
        }
        continue
      }

      if (stmt.kind === 'assign') {
        this.checkImplicitAssignmentTargets(stmt.targets, stmt.range, scope)
        if (stmt.unpacksValue && !isKnownPrimitiveIterable(stmt.value, scope) && stmt.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.range, sourceStatus: 'unknown', dynamicAccess: true })
        if (stmt.annotation) this.analyzeExpr(stmt.annotation, scope, decodeBindings, stmtIndex)
        const modName = this.extractImportModuleName(stmt.value)
        // Update existing binding state first; a modeled dynamic import result then gets its
        // precise module origin, matching the value actually assigned.
        for (const target of stmt.targets.flatMap(bindingNames)) applyAssignmentRebind(target, stmt.value, scope)
        if (modName) {
          for (const target of stmt.targets.flatMap(bindingNames)) { scope.unknownRoots.delete(target); scope.modules.set(target, modName) }
          if (isDangerousModule(modName)) {
            const importEvidence: ScriptFindingEvidence = { kind: 'dynamic-import', moduleName: modName, boundName: stmt.targets[0]! }
            this.addHit('B4', importEvidence)
            this.addHit('B10', importEvidence)
          }
        }
        // Same-scope rebind: x = os / y = os.system / z = o (alias) / w = y (callable alias)
        if (isDecodeCall(stmt.value) && stmt.targets.length === 1) {
          decodeBindings.push({ name: stmt.targets[0]!, stmtOffset: stmtIndex, decodeFn: decodeFunctionName(stmt.value) })
        }
        this.analyzeExpr(stmt.value, scope)
        continue
      }

      if (stmt.kind === 'annotation') {
        this.analyzeExpr(stmt.annotation, scope, decodeBindings, stmtIndex)
        continue
      }

      if (stmt.kind === 'expr') {
        this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
        continue
      }

      if (stmt.kind === 'if') {
        // N14:if test 是 walrus 的典型位置——decode 登记必须进主链
        if (!isKnownPrimitiveExpr(stmt.test, scope) && stmt.test.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.test.range, sourceStatus: 'unknown', dynamicAccess: true })
        this.analyzeExpr(stmt.test, scope, decodeBindings, stmtIndex)
        const child = createScope(scope)
        this.walkStmts(stmt.body, child, stmtIndex, decodeBindings)
        this.walkStmts(stmt.orelse, child, stmtIndex, decodeBindings)
        invalidateBranchWrites([...stmt.body, ...stmt.orelse], scope)
        continue
      }

      if (stmt.kind === 'for') {
        this.analyzeExpr(stmt.iter, scope, decodeBindings, stmtIndex)
        if (!isKnownPrimitiveIterable(stmt.iter, scope) && stmt.range) {
          this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.range, sourceStatus: 'unknown', dynamicAccess: true })
        }
        const child = createScope(scope)
        for (const target of bindingNames(stmt.target)) {
          child.modules.delete(target)
          child.attrs.delete(target)
          child.mutableObjectIds.delete(target)
          if (isKnownPrimitiveIterable(stmt.iter, scope)) {
            child.unknownRoots.delete(target)
            child.knownPrimitiveRoots.add(target)
          } else {
            child.knownPrimitiveRoots.delete(target)
            child.unknownRoots.add(target)
          }
        }
        const loopWrites = writtenNames(stmt.body)
        invalidateBranchWrites(stmt.body, child)
        this.walkStmts(stmt.body, child, stmtIndex, decodeBindings)
        // P0-3 评审修复：for...else 的 else 体在循环正常结束时真实执行——必须分析
        this.walkStmts(stmt.orelse, child, stmtIndex, decodeBindings)
        if (stmt.targetUnpacks && !isKnownPrimitiveIterable(stmt.iter, scope) && stmt.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.range, sourceStatus: 'unknown', dynamicAccess: true })
        invalidateBranchWrites([...stmt.body, ...stmt.orelse], scope)
        continue
      }

      // —— IR 扩展语句（tree-sitter 全语法；判定语义保守对齐：体/表达式递归，不新增黑名单）——
      if (stmt.kind === 'aug_assign') {
        this.checkImplicitAssignmentTargets([stmt.target], stmt.range, scope)
        const knownOperation = ['+=', '-=', '*=', '/=', '//=', '%=', '**=', '<<=', '>>=', '&=', '|=', '^='].includes(stmt.op) &&
          isKnownPrimitiveExpr(stmt.targetExpr, scope) && isKnownPrimitiveExpr(stmt.value, scope)
        if (knownOperation) {
          const binaryOp = stmt.op.slice(0, -1)
          const combined: IrExpr = { kind: 'binop', op: binaryOp, left: stmt.targetExpr, right: stmt.value, ...(stmt.range ? { range: stmt.range } : {}) }
          applyAssignmentRebind(stmt.target, combined, scope)
        } else {
          if (stmt.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.range, sourceStatus: 'unknown', dynamicAccess: true })
          invalidateBinding(stmt.target, scope)
        }
        if (isDecodeCall(stmt.value)) decodeBindings.push({ name: stmt.target, stmtOffset: stmtIndex, decodeFn: decodeFunctionName(stmt.value) })
        this.analyzeExpr(stmt.targetExpr, scope, decodeBindings, stmtIndex)
        this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
        continue
      }
      if (stmt.kind === 'while') {
        const loopState = createScope(scope)
        const loopWrites = writtenNames([...stmt.body, ...stmt.orelse])
        const bodyWrites = writtenNames(stmt.body)
        const elseWrites = writtenNames(stmt.orelse)
        const stableLoopWrites = new Set<string>()
        const assignments = new Map<string, IrExpr[]>()
        const primitiveSelfUpdates = new Set<string>()
        const unknownRebindings = new Set<string>()
        const deletedBindings = new Set<string>()
        const collectWalrusWrites = (expr: IrExpr): void => {
          const writes = new Set<string>()
          collectExprWrites(expr, writes)
          writes.forEach((name) => unknownRebindings.add(name))
        }
        const collectAssignments = (items: IrStmt[]) => { for (const item of items) {
          if (item.kind === 'assign') {
            for (const target of item.targets) for (const name of bindingNames(target)) {
              assignments.set(name, [...assignments.get(name) ?? [], item.value])
              if (item.targets.length === 1 && item.targets.every((value) => !value.includes(',')) && item.value.kind === 'binop' &&
                ((item.value.left.kind === 'name' && item.value.left.id === name && isKnownPrimitiveExpr(item.value.right, scope)) ||
                 (item.value.right.kind === 'name' && item.value.right.id === name && isKnownPrimitiveExpr(item.value.left, scope)))) primitiveSelfUpdates.add(name)
            }
            if (item.annotation) collectWalrusWrites(item.annotation)
            collectWalrusWrites(item.value)
          }
          else if (item.kind === 'aug_assign') {
            assignments.set(item.target, [...assignments.get(item.target) ?? [], item.value])
            if (isKnownPrimitiveExpr(item.targetExpr, scope) && isKnownPrimitiveExpr(item.value, scope)) primitiveSelfUpdates.add(item.target)
            collectWalrusWrites(item.value)
            collectWalrusWrites(item.targetExpr)
          }
          else if (item.kind === 'expr') collectWalrusWrites(item.value)
          else if (item.kind === 'assert') { collectWalrusWrites(item.test); if (item.message) collectWalrusWrites(item.message) }
          else if (item.kind === 'raise') { if (item.value) collectWalrusWrites(item.value); if (item.cause) collectWalrusWrites(item.cause) }
          else if (item.kind === 'annotation') collectWalrusWrites(item.annotation)
          else if (item.kind === 'delete') { for (const target of item.targets) if (target.kind === 'name') deletedBindings.add(target.id) }
          else if (item.kind === 'import') { for (const imported of item.names) unknownRebindings.add(imported.alias ?? imported.module.split('.')[0]!) }
          else if (item.kind === 'from_import') { for (const imported of item.names) if (imported.name !== '*') unknownRebindings.add(imported.alias ?? imported.name) }
          else if (item.kind === 'function_def') {
            unknownRebindings.add(item.name)
            item.defaults.forEach(collectWalrusWrites)
            item.decorators.forEach(collectWalrusWrites)
            item.annotations?.forEach(collectWalrusWrites)
          }
          else if (item.kind === 'class_def') {
            unknownRebindings.add(item.name)
            item.bases.forEach(collectWalrusWrites)
            item.decorators.forEach(collectWalrusWrites)
          }
          if (item.kind === 'if' || item.kind === 'while' || item.kind === 'for') {
            if (item.kind === 'if' || item.kind === 'while') collectWalrusWrites(item.test)
            else { collectWalrusWrites(item.iter); for (const name of bindingNames(item.target)) unknownRebindings.add(name) }
            collectAssignments([...item.body, ...item.orelse])
          } else if (item.kind === 'try') {
            item.handlers.forEach((handler) => { if (handler.typeExpr) collectWalrusWrites(handler.typeExpr) })
            item.handlers.forEach((handler) => { if (handler.name) unknownRebindings.add(handler.name) })
            collectAssignments([...item.body, ...item.handlers.flatMap((handler) => handler.body), ...item.orelse, ...item.finalbody])
          }
          else if (item.kind === 'with') { item.items.flatMap((context) => context.optionalVars).forEach((name) => unknownRebindings.add(name)); item.items.forEach((context) => collectWalrusWrites(context.contextExpr)); collectAssignments(item.body) }
        } }
        collectAssignments(stmt.body)
        collectAssignments(stmt.orelse)
        const readNamesIn = (expr: IrExpr): Set<string> => {
          const readNames = new Set<string>()
          const collectReads = (node: IrExpr) => {
            if (node.kind === 'name') { readNames.add(node.id); return }
            const visit = (value: IrExpr | null | undefined) => { if (value) collectReads(value) }
            switch (node.kind) {
              case 'f_string': node.interpolations.forEach(visit); break
              case 'list': case 'tuple': case 'set': node.elts.forEach(visit); break
              case 'dict': node.keys.forEach(visit); node.values.forEach(visit); break
              case 'slice': visit(node.lower); visit(node.upper); visit(node.step); break
              case 'subscript': visit(node.value); visit(node.index); break
              case 'binop': case 'compare': visit(node.left); visit(node.right); break
              case 'unaryop': case 'await': case 'starred': visit(node.kind === 'unaryop' ? node.operand : node.value); break
              case 'boolop': node.values.forEach(visit); break
              case 'conditional': visit(node.test); visit(node.body); visit(node.orelse); break
              case 'call': visit(node.callee); node.args.forEach(visit); node.kwargs.forEach((kw) => visit(kw.value)); break
              case 'comprehension': visit(node.elt); node.generators.forEach((generator) => { visit(generator.iter); generator.conditions.forEach(visit) }); break
              case 'lambda': node.defaults.forEach(visit); visit(node.body); break
              case 'named_expr': visit(node.value); break
              case 'yield': visit(node.value); break
              default: break
            }
          }
          collectReads(expr)
          return readNames
        }
        const dependsOnLoopWrite = (expr: IrExpr, target: string): boolean => {
          const reads = readNamesIn(expr)
          for (const name of reads) {
            if (!loopWrites.has(name) || (primitiveSelfUpdates.has(name) && name === target)) continue
            return true
          }
          return false
        }
        const mayRemainPrimitive = (name: string): boolean => {
          const values = assignments.get(name) ?? []
          if (unknownRebindings.has(name) || deletedBindings.has(name)) return false
          return values.length > 0 && values.every((value) => isKnownPrimitiveExpr(value, scope) &&
            (!dependsOnLoopWrite(value, name) || (primitiveSelfUpdates.has(name) && [...readNamesIn(value)].every((read) => read === name))))
        }
        for (const name of loopWrites) {
          if (scope.knownPrimitiveRoots.has(name) && (!bodyWrites.has(name) || mayRemainPrimitive(name)) && (!elseWrites.has(name) || mayRemainPrimitive(name))) stableLoopWrites.add(name)
        }
        invalidateBranchWrites([...stmt.body, ...stmt.orelse], loopState, stableLoopWrites)
        const testNames = new Set<string>()
        const collectTestNames = (node: IrExpr) => {
          if (node.kind === 'name') { testNames.add(node.id); return }
          const visit = (value: IrExpr | null | undefined) => { if (value) collectTestNames(value) }
          switch (node.kind) {
            case 'compare': case 'binop': visit(node.left); visit(node.right); break
            case 'unaryop': visit(node.operand); break
            case 'boolop': node.values.forEach(visit); break
            case 'conditional': visit(node.test); visit(node.body); visit(node.orelse); break
            default: break
          }
        }
        collectTestNames(stmt.test)
        const primitiveLoopCondition = isKnownPrimitiveExpr(stmt.test, scope) && [...testNames].every((name) => !loopWrites.has(name) || stableLoopWrites.has(name))
        if (!primitiveLoopCondition && !isKnownPrimitiveExpr(stmt.test, loopState) && stmt.test.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.test.range, sourceStatus: 'unknown', dynamicAccess: true })
        this.analyzeExpr(stmt.test, loopState, decodeBindings, stmtIndex)
        this.walkStmts(stmt.body, loopState, stmtIndex, decodeBindings)
        if (!primitiveLoopCondition && !isKnownPrimitiveExpr(stmt.test, loopState) && stmt.test.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.test.range, sourceStatus: 'unknown', dynamicAccess: true })
        // P1-1 评审修复（补全）：while...else 的 else 体在循环正常结束时真实执行——必须分析
        this.walkStmts(stmt.orelse, loopState, stmtIndex, decodeBindings)
        invalidateBranchWrites([...stmt.body, ...stmt.orelse], scope, stableLoopWrites)
        continue
      }
      if (stmt.kind === 'with') {
        const child = createScope(scope)
        for (const item of stmt.items) {
          const knownOpen = item.contextExpr.kind === 'call' && item.contextExpr.callee.kind === 'name' && item.contextExpr.callee.id === 'open'
          if (!knownOpen && !isKnownPrimitiveExpr(item.contextExpr, scope) && item.contextExpr.range) {
            this.uncertainties.push({ kind: 'implicit-call-unresolved', range: item.contextExpr.range, sourceStatus: 'unknown', dynamicAccess: true })
          }
          this.analyzeExpr(item.contextExpr, scope, decodeBindings, stmtIndex)
          for (const target of item.optionalVars) {
            if (knownOpen) {
              child.unknownRoots.delete(target)
              child.knownPrimitiveRoots.add(target)
            } else {
              child.knownPrimitiveRoots.delete(target)
              child.unknownRoots.add(target)
            }
          }
        }
        this.walkStmts(stmt.body, child, stmtIndex, decodeBindings)
        invalidateBranchWrites(stmt.body, scope)
        continue
      }
      if (stmt.kind === 'try') {
        this.walkStmts(stmt.body, createScope(scope), stmtIndex, decodeBindings)
        for (const handler of stmt.handlers) {
          if (handler.typeExpr) this.analyzeExpr(handler.typeExpr, scope, decodeBindings, stmtIndex)
          const handlerScope = createScope(scope)
          if (handler.name) invalidateBinding(handler.name, handlerScope)
          this.walkStmts(handler.body, handlerScope, stmtIndex, decodeBindings)
        }
        this.walkStmts(stmt.orelse, createScope(scope), stmtIndex, decodeBindings)
        this.walkStmts(stmt.finalbody, createScope(scope), stmtIndex, decodeBindings)
        const handlerBindings = stmt.handlers.flatMap((handler) => handler.name ? [{ kind: 'delete' as const, targets: [{ kind: 'name' as const, id: handler.name }] }] : [])
        invalidateBranchWrites([...stmt.body, ...stmt.handlers.flatMap((handler) => handler.body), ...handlerBindings, ...stmt.orelse, ...stmt.finalbody], scope)
        for (const handler of stmt.handlers) if (handler.name) invalidateBinding(handler.name, scope)
        continue
      }
      if (stmt.kind === 'function_def') {
        if (stmt.name === 'print') scope.shadowedBuiltinRoots.add(stmt.name)
        if (stmt.decorators.length > 0 && stmt.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.range, sourceStatus: 'unknown', dynamicAccess: true })
        for (const d of stmt.decorators) this.analyzeExpr(d, scope, decodeBindings, stmtIndex)
        // P0-1 评审修复：默认参数值在 def 定义时真实执行——必须分析
        for (const dv of stmt.defaults) this.analyzeExpr(dv, scope, decodeBindings, stmtIndex)
        for (const annotation of stmt.annotations ?? []) this.analyzeExpr(annotation, scope, decodeBindings, stmtIndex)
        // 函数体在定义作用域内静态可见：递归捕获（禁止 def 内危险调用逃逸）
        const child = createScope(scope)
        for (const param of stmt.params) {
          if (param === 'print') child.shadowedBuiltinRoots.add(param)
          child.modules.delete(param)
          child.attrs.delete(param)
          child.knownPrimitiveRoots.delete(param)
          child.mutableObjectIds.delete(param)
          child.knownClassRoots.delete(param)
          if (scope.classBody && param === stmt.params[0]) child.knownClassRoots.add(param)
          else child.unknownRoots.add(param)
        }
        this.walkStmts(stmt.body, child, stmtIndex)
        continue
      }
      if (stmt.kind === 'class_def') {
        if (stmt.name === 'print') scope.shadowedBuiltinRoots.add(stmt.name)
        if ((stmt.decorators.length > 0 || stmt.bases.length > 0) && stmt.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.range, sourceStatus: 'unknown', dynamicAccess: true })
        for (const d of stmt.decorators) this.analyzeExpr(d, scope, decodeBindings, stmtIndex)
        // P0-1 评审修复：基类/关键字参数表达式在 class 创建时真实执行——必须分析
        for (const b of stmt.bases) this.analyzeExpr(b, scope, decodeBindings, stmtIndex)
        scope.knownClassRoots.add(stmt.name)
        if (stmt.name === 'print') scope.shadowedBuiltinRoots.add(stmt.name)
        const child = createScope(scope)
        child.classBody = true
        this.walkStmts(stmt.body, child, stmtIndex)
        continue
      }
      if (stmt.kind === 'return' || stmt.kind === 'assert' || stmt.kind === 'raise') {
        if (stmt.kind === 'assert') {
          if (!isKnownPrimitiveExpr(stmt.test, scope) && stmt.test.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: stmt.test.range, sourceStatus: 'unknown', dynamicAccess: true })
          this.analyzeExpr(stmt.test, scope, decodeBindings, stmtIndex)
        }
        else if (stmt.value) this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
        if (stmt.kind === 'assert' && stmt.message) this.analyzeExpr(stmt.message, scope, decodeBindings, stmtIndex)
        if (stmt.kind === 'raise' && stmt.cause) this.analyzeExpr(stmt.cause, scope, decodeBindings, stmtIndex)
        continue
      }
      if (stmt.kind === 'delete') {
        for (const t of stmt.targets) this.analyzeExpr(t, scope, decodeBindings, stmtIndex)
        continue
      }
      if (stmt.kind === 'global_nonlocal' || stmt.kind === 'break' || stmt.kind === 'continue' || stmt.kind === 'pass') {
        continue
      }
    }
  }

  private checkImplicitAssignmentTargets(targets: string[], range: SourceRange | undefined, scope: Scope): void {
    if (targets.some((target) => implicitAssignmentTarget(target)) && range) {
      this.uncertainties.push({ kind: 'implicit-call-unresolved', range, sourceStatus: 'unknown', dynamicAccess: true })
    }
  }

  private extractImportModuleName(expr: IrExpr): string | null {
    if (expr.kind !== 'call') return null
    const chain = resolveExprChain(expr.callee, createScope())
    const fn = chain.attrs[chain.attrs.length - 1] ?? chain.module
    if (fn === 'import_module' && (chain.module === 'importlib' || chain.fullName?.startsWith('importlib.'))) {
      return foldStringExpr(expr.args[0] ?? { kind: 'none' })
    }
    if (fn === '__import__' || (chain.module === 'builtins' && fn === '__import__')) {
      return foldStringExpr(expr.args[0] ?? { kind: 'none' })
    }
    if (expr.callee.kind === 'name' && expr.callee.id === '__import__') {
      return foldStringExpr(expr.args[0] ?? { kind: 'none' })
    }
    return null
  }

  private analyzeExpr(
    expr: IrExpr,
    scope: Scope,
    decodeBindings: DecodeBinding[] = [],
    stmtIndex = 0
  ): void {
    const previousRange = this.activeRange
    const previousExpr = this.activeExpr
    const previousScope = this.activeScope
    this.activeRange = expr.range ?? previousRange
    this.activeExpr = expr
    this.activeScope = scope
    try {
      this.analyzeExprNode(expr, scope, decodeBindings, stmtIndex)
    } finally {
      this.activeRange = previousRange
      this.activeExpr = previousExpr
      this.activeScope = previousScope
    }
  }

  private analyzeExprNode(
    expr: IrExpr,
    scope: Scope,
    decodeBindings: DecodeBinding[],
    stmtIndex: number
  ): void {
    if (expr.kind === 'call') {
      this.analyzeCall(expr, scope, decodeBindings, stmtIndex)
      const mutableObjectIds = new Set<number>()
      for (const arg of [...expr.args, ...expr.kwargs.map((item) => item.value)]) mutableObjectsReachable(arg, scope, mutableObjectIds)
      if (expr.callee.kind === 'attr') mutableObjectsReachable(expr.callee.base, scope, mutableObjectIds)
      const trustedPrint = expr.callee.kind === 'name' && expr.callee.id === 'print' && !scope.shadowedBuiltinRoots.has('print') && !scope.unknownRoots.has('print') &&
        !scope.modules.has('print') && !scope.attrs.has('print') && !scope.knownClassRoots.has('print') && expr.kwargs.length === 0 &&
        expr.args.every((arg) => isKnownPrimitiveExpr(arg, scope))
      if (mutableObjectIds.size && !trustedPrint) {
        const callHasClassifiedFinding = expr.range && this.hits.some((hit) => hit.range && sameRange(hit.range, expr.range) && FINDING_CLASS_BY_PATTERN[hit.pattern])
        if (expr.range && !callHasClassifiedFinding) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
        for (const id of mutableObjectIds) scope.heap.invalidatedObjects.add(id)
      }
      return
    }
    if (expr.kind === 'binop') {
      if ((!isKnownPrimitiveExpr(expr.left, scope) || !isKnownPrimitiveExpr(expr.right, scope)) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      this.analyzeExpr(expr.left, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.right, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'attr') {
      if (!hasKnownAttributeOrigin(expr, scope) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      this.analyzeExpr(expr.base, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'list' || expr.kind === 'tuple' || expr.kind === 'set') {
      if (expr.kind === 'set' && expr.elts.some((item) => !isKnownPrimitiveExpr(item, scope)) && expr.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      for (const e of expr.elts) this.analyzeExpr(e, scope, decodeBindings, stmtIndex)
      return
    }
    // —— IR 扩展表达式（递归保证调用不逃逸）——
    if (expr.kind === 'f_string') {
      if (expr.interpolations.some((item) => !isKnownPrimitiveExpr(item, scope)) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      for (const interp of expr.interpolations) this.analyzeExpr(interp, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'unaryop') {
      if (!isKnownPrimitiveExpr(expr.operand, scope) && expr.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      this.analyzeExpr(expr.operand, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'compare') {
      if ((!isKnownPrimitiveExpr(expr.left, scope) || !isKnownPrimitiveExpr(expr.right, scope)) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      this.analyzeExpr(expr.left, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.right, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'boolop') {
      if (expr.values.some((item) => !isKnownPrimitiveExpr(item, scope)) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      for (const v of expr.values) this.analyzeExpr(v, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'conditional') {
      if (!isKnownPrimitiveExpr(expr.test, scope) && expr.test.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.test.range, sourceStatus: 'unknown', dynamicAccess: true })
      this.analyzeExpr(expr.test, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.body, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.orelse, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'subscript') {
      if ((!isKnownPrimitiveExpr(expr.value, scope) || !isKnownPrimitiveExpr(expr.index, scope)) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      this.analyzeExpr(expr.value, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.index, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'slice') {
      if (expr.lower) this.analyzeExpr(expr.lower, scope, decodeBindings, stmtIndex)
      if (expr.upper) this.analyzeExpr(expr.upper, scope, decodeBindings, stmtIndex)
      if (expr.step) this.analyzeExpr(expr.step, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'dict') {
      if (expr.keys.some((key) => key !== null && !isKnownPrimitiveExpr(key, scope)) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      for (const k of expr.keys) if (k) this.analyzeExpr(k, scope, decodeBindings, stmtIndex)
      for (const v of expr.values) this.analyzeExpr(v, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'starred' || expr.kind === 'await') {
      const knownAsyncioSleep = expr.kind === 'await' && expr.value.kind === 'call' && (() => {
        const chain = resolveExprChain(expr.value.callee, scope)
        return chain.module === 'asyncio' && chain.attrs.at(-1) === 'sleep'
      })()
      if (!knownAsyncioSleep && !isKnownPrimitiveExpr(expr.value, scope) && expr.range) {
        this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
      }
      this.analyzeExpr(expr.value, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'named_expr') {
      // v4 评审 obs2:walrus 目标与 assign 同语义——decode→exec 链登记 + 危险别名重绑,
      // 使 (x := b64decode(...)); exec(x) 仍升级为 dangerous(而非降级 locked 确认)。
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr.target)) {
        applyAssignmentRebind(expr.target, expr.value, scope)
        if (!isKnownPrimitiveExpr(expr.value, scope) && expr.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.range, sourceStatus: 'unknown', dynamicAccess: true })
        if (isDecodeCall(expr.value)) decodeBindings.push({ name: expr.target, stmtOffset: stmtIndex, decodeFn: decodeFunctionName(expr.value) })
      }
      this.analyzeExpr(expr.value, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'yield') {
      if (expr.value) this.analyzeExpr(expr.value, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'comprehension') {
      const child = createScope(scope)
      for (const generator of expr.generators) {
        const knownIterable = isKnownPrimitiveIterable(generator.iter, child)
        if (!knownIterable && generator.iter.range) {
          this.uncertainties.push({ kind: 'implicit-call-unresolved', range: generator.iter.range, sourceStatus: 'unknown', dynamicAccess: true })
        }
        for (const target of bindingNames(generator.target)) {
          child.mutableObjectIds.delete(target)
          if (knownIterable) {
            child.unknownRoots.delete(target)
            child.knownPrimitiveRoots.add(target)
          } else {
            child.knownPrimitiveRoots.delete(target)
            child.unknownRoots.add(target)
          }
        }
        for (const condition of generator.conditions) {
          if (!isKnownPrimitiveExpr(condition, child) && condition.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: condition.range, sourceStatus: 'unknown', dynamicAccess: true })
          this.analyzeExpr(condition, child, decodeBindings, stmtIndex)
        }
      }
      if (expr.compKind === 'set' && !isKnownPrimitiveExpr(expr.elt, child) && expr.elt.range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.elt.range, sourceStatus: 'unknown', dynamicAccess: true })
      if (expr.compKind === 'dict' && expr.elt.kind === 'tuple' && expr.elt.elts[0] && !isKnownPrimitiveExpr(expr.elt.elts[0], child) && expr.elt.elts[0].range) this.uncertainties.push({ kind: 'implicit-call-unresolved', range: expr.elt.elts[0].range, sourceStatus: 'unknown', dynamicAccess: true })
      this.analyzeExpr(expr.elt, child, decodeBindings, stmtIndex)
      for (const g of expr.generators) {
        this.analyzeExpr(g.iter, scope, decodeBindings, stmtIndex)
      }
      return
    }
    if (expr.kind === 'lambda') {
      // P0-1 评审修复：lambda 默认值在定义时真实执行——必须分析
      for (const dv of expr.defaults) this.analyzeExpr(dv, scope, decodeBindings, stmtIndex)
      const child = createScope(scope)
      for (const param of expr.params) {
        invalidateBinding(param, child)
      }
      this.analyzeExpr(expr.body, child, decodeBindings, stmtIndex)
      return
    }
    // string/number/name/bool/none/ellipsis：叶子，无子表达式
  }

  private analyzeCall(
    call: IrExpr & { kind: 'call' },
    scope: Scope,
    decodeBindings: DecodeBinding[],
    stmtIndex: number
  ): void {
    const callee = call.callee
    this.analyzeExpr(callee, scope, decodeBindings, stmtIndex)
    for (const a of call.args) this.analyzeExpr(a, scope, decodeBindings, stmtIndex)
    for (const kw of call.kwargs) this.analyzeExpr(kw.value, scope, decodeBindings, stmtIndex)

    // 动态成员调用 d[k](...)：静态不可解析的动态分派，保守 ask。
    // 旧实现下该构造因 dict/下标解析失败而 A-fail → ask；本规则是切换后的等价保守投影
    // （复用 B9「动态查找成员」语义，模式 ID 集合不变）。
    if (callee.kind === 'subscript') {
      this.addHit('B9')
      return
    }

    // getattr / hasattr
    const calleeChain = resolveExprChain(callee, scope)
    const calleeName = calleeChain.attrs[calleeChain.attrs.length - 1] ?? calleeChain.module ?? (callee.kind === 'name' ? callee.id : null)

    if (callee.kind === 'call' && call.range && (!calleeName || (!REFLECTION_NAMES.has(calleeName) && !EXEC_IMPORT_NAMES.has(calleeName)))) {
      this.uncertainties.push({ kind: 'call-target-unresolved', range: call.range, sourceStatus: 'unresolved', dynamicAccess: true })
    }

    if (calleeName === 'getattr' || calleeName === 'hasattr') {
      const viaBuiltins =
        calleeChain.module === 'builtins' ||
        (callee.kind === 'attr' && resolveExprChain(callee, scope).module === 'builtins')
      this.checkGetattr(call, scope, calleeName === 'hasattr', viaBuiltins)
      return
    }

    // __import__
    if (callee.kind === 'name' && callee.id === '__import__') {
      const mod = foldStringExpr(call.args[0] ?? { kind: 'none' })
      if (mod && isDangerousModule(mod.split('.')[0]!)) {
        const root = mod.split('.')[0]!
        this.addHit('A4')
        this.addHit('B10')
      }
      this.checkB11(call.args[0], scope, decodeBindings, stmtIndex, true)
      return
    }

    if (calleeChain.module === 'builtins') {
      const attr = calleeChain.attrs[0]
      if (attr === '__import__') {
        const mod = foldStringExpr(call.args[0] ?? { kind: 'none' })
        if (mod && isDangerousModule(mod.split('.')[0]!)) {
          this.addHit('B8')
          this.addHit('A4')
          this.addHit('B10')
        }
      }
      if (attr && EXEC_NAMES.has(attr)) {
        this.addHit('B8')
        this.addHit('A3')
        const arg = call.args[0]
        if (arg) this.checkB11(arg, scope, decodeBindings, stmtIndex, true)
      }
      if (attr === 'getattr') {
        this.checkGetattr(call, scope, false, true)
      }
    }

    // importlib.import_module
    if (calleeChain.fullName === 'importlib.import_module' || (calleeChain.module === 'importlib' && calleeChain.attrs[0] === 'import_module')) {
      const mod = foldStringExpr(call.args[0] ?? { kind: 'none' })
      if (mod && isDangerousModule(mod.split('.')[0]!)) {
        const root = mod.split('.')[0]!
        this.addHit('A4')
        this.addHit('B4')
        this.addHit('B10')
      }
      return
    }

    // eval / exec / compile — always A3 when callee is the builtin (dynamic args included)
    if (callee.kind === 'name' && EXEC_NAMES.has(callee.id)) {
      this.addHit('A3')
      const arg = call.args[0]
      if (arg) this.checkB11(arg, scope, decodeBindings, stmtIndex, true)
      return
    }
    if (callee.kind === 'name') {
      const binding = scope.attrs.get(callee.id)
      if (binding?.attr && EXEC_NAMES.has(binding.attr)) {
        this.addHit(binding.attr === callee.id ? 'B6' : 'B7')
        this.addHit('A3')
        const arg = call.args[0]
        if (arg) this.checkB11(arg, scope, decodeBindings, stmtIndex, true)
        return
      }
    }

    // open()
    if (callee.kind === 'name' && callee.id === 'open') {
      this.checkOpenCall(call)
      return
    }

    // Path.write_text / write_bytes / unlink on constructor result
    if (callee.kind === 'attr') {
      const lastAttr = callee.attr
      if (lastAttr === 'write_text' || lastAttr === 'write_bytes' || lastAttr === 'unlink') {
        const pathFolded = extractPathLiteral(callee.base, scope)
        if (lastAttr === 'unlink') {
          this.addHit('A2')
        } else if (pathFolded) {
          this.checkWritePath(pathFolded)
        } else {
          this.addHit('A7')
        }
      }
    }

    const chain = resolveExprChain(callee, scope)
    const lastAttr = chain.attrs[chain.attrs.length - 1]

    // os.chdir
    if (chain.fullName === 'os.chdir' || (chain.module === 'os' && lastAttr === 'chdir')) {
      this.addHit('A9')
      return
    }

    // ctypes / cffi
    if (chain.module === 'ctypes' || chain.module === 'cffi') {
      if (lastAttr === 'CDLL' || lastAttr === 'WinDLL' || chain.module === 'cffi') {
        this.addHit('A5')
      }
    }

    // Process creation and process pools; ThreadPoolExecutor is intentionally excluded.
    if ((chain.module?.startsWith('multiprocessing') && lastAttr && PROCESS_CREATION_CALLS.has(lastAttr)) ||
        (chain.module?.startsWith('concurrent.') && lastAttr === 'ProcessPoolExecutor')) {
      this.addHit('A1')
      return
    }
    if ((chain.module === 'pickle' || chain.module === 'marshal') && lastAttr && DESERIALIZATION_CALLS.has(lastAttr)) {
      this.addHit('A3', { kind: 'dynamic-exec', entry: `${chain.module}.${lastAttr}` })
      return
    }

    // subprocess.* / pty.* (any attr, including aliased imports)
    if (chain.module === 'subprocess' || chain.module === 'pty') {
      if (chain.root && scope.modules.has(chain.root) && chain.root !== chain.module) {
        this.addHit('B5')
      }
      this.addHit('A1')
      return
    }

    // asyncio.create_subprocess_exec / create_subprocess_shell (and aliases)
    if (chain.module === 'asyncio' && lastAttr && ASYNCIO_PROCESS_ATTRS.has(lastAttr)) {
      if (chain.root && scope.modules.has(chain.root) && chain.root !== 'asyncio') {
        this.addHit('B5')
      }
      this.addHit('A1')
      return
    }

    // shutil / os dangerous
    if (chain.module === 'shutil' && (lastAttr === 'rmtree' || lastAttr === 'move')) {
      this.addHit('A2')
      return
    }
    if (chain.module === 'os') {
      // os.system/popen and os.spawn*/posix_spawn* (process-creation table, WP3 item 2)
      if (lastAttr && (A1_OS_ATTRS.has(lastAttr) || OS_SPAWN_ATTRS.has(lastAttr))) {
        if (chain.root && scope.modules.has(chain.root) && chain.root !== 'os') {
          this.addHit('B5')
        }
        this.addHit('A1')
        return
      }
      if (lastAttr && ['remove', 'unlink', 'rmdir'].includes(lastAttr)) {
        this.addHit('A2')
        return
      }
      if (lastAttr && lastAttr.startsWith('exec')) {
        this.addHit('A3')
        return
      }
    }

    // Network modules
    if (chain.module && isNetworkModule(chain.module)) {
      this.addHit('A6')
      return
    }
    if (chain.module === 'urllib' || chain.fullName?.startsWith('urllib.')) {
      this.addHit('A6')
      return
    }
    if (chain.module === 'http' || chain.fullName?.startsWith('http.client')) {
      this.addHit('A6')
      return
    }

    // Alias-based dangerous calls: o.system, s()
    if (callee.kind === 'name') {
      const binding = scope.attrs.get(callee.id)
      if (binding?.attr && isDangerousAttr(binding.attr)) {
        const viaAlias = callee.id !== binding.attr
        this.addHit(viaAlias ? 'B7' : 'B6')
        if (binding.module.split('.')[0] === 'os' && A1_OS_ATTRS.has(binding.attr)) {
          this.addHit('A1')
        } else if (binding.module.split('.')[0] === 'subprocess') {
          this.addHit('A1')
        } else if (['remove', 'unlink', 'rmdir', 'rmtree'].includes(binding.attr)) {
          this.addHit('A2')
        }
        return
      }
    }

    if (callee.kind === 'attr') {
      const resolved = resolveExprChain(callee, scope)
      const mod = resolved.module
      const attr = resolved.attrs[resolved.attrs.length - 1]
      const viaModuleAlias =
        !!resolved.root &&
        scope.modules.has(resolved.root) &&
        resolved.root !== mod &&
        !!mod &&
        isDangerousModule(mod)
      if (mod === 'os' && attr && (A1_OS_ATTRS.has(attr) || OS_SPAWN_ATTRS.has(attr))) {
        if (viaModuleAlias) this.addHit('B5')
        this.addHit('A1')
        return
      }
      if ((mod === 'subprocess' || mod === 'pty') && attr) {
        if (viaModuleAlias) this.addHit('B5')
        this.addHit('A1')
        return
      }
      if (mod === 'asyncio' && attr && ASYNCIO_PROCESS_ATTRS.has(attr)) {
        if (viaModuleAlias) this.addHit('B5')
        this.addHit('A1')
        return
      }
      if (viaModuleAlias && attr && isDangerousAttr(attr)) {
        this.addHit('B5')
        if (mod === 'os' && ['remove', 'unlink', 'rmdir'].includes(attr)) this.addHit('A2')
      }
      // B4: import_module result chain
      if (resolved.root && scope.modules.has(resolved.root) && attr && isDangerousAttr(attr)) {
        const boundMod = scope.modules.get(resolved.root)
        if (boundMod && isDangerousModule(boundMod)) {
          this.addHit('B4')
          if (A1_OS_ATTRS.has(attr) || OS_SPAWN_ATTRS.has(attr)) this.addHit('A1')
        }
      }
    }

    // B11 in same expression
    if (isExecImportCallee(callee)) {
      const arg = call.args[0]
      if (arg) this.checkB11(arg, scope, decodeBindings, stmtIndex, true)
    }
    if (isDecodeCall(call)) {
      // decode result passed inline to exec?
      for (const parent of call.args) {
        void parent
      }
    }
  }

  private checkGetattr(call: IrExpr & { kind: 'call' }, scope: Scope, isHas: boolean, fromBuiltins = false): void {
    void isHas
    const base = call.args[0]
    const attrExpr = call.args[1]
    const attrFolded = attrExpr ? foldStringExpr(attrExpr) : null

    if (!attrFolded || !isDangerousAttr(attrFolded)) {
      if (fromBuiltins) this.addHit('B8')
      return
    }

    let baseResolved = false
    if (base) {
      if (base.kind === 'call' && base.callee.kind === 'name' && base.callee.id === '__import__') {
        const importMod = foldStringExpr(base.args[0] ?? { kind: 'none' })
        if (importMod && isDangerousModule(importMod.split('.')[0]!)) {
          this.addHit('B2')
          const hasFold = base.args[0]?.kind === 'binop' || attrExpr?.kind === 'binop'
          if (hasFold) this.addHit('B3')
        }
        baseResolved = true
      } else {
        const chain = resolveExprChain(base, scope)
        if (chain.module === 'os' || scope.modules.get(chain.root ?? '') === 'os') {
          this.addHit('B1')
          baseResolved = true
        } else if (chain.module && isDangerousModule(chain.module)) {
          this.addHit('B1')
          baseResolved = true
        }
      }
    }

    if (!baseResolved) {
      this.addHit('B9')
    }

    if (fromBuiltins) this.addHit('B8')
  }

  private checkB11(
    arg: IrExpr | undefined,
    scope: Scope,
    decodeBindings: DecodeBinding[],
    stmtIndex: number,
    sameExpr: boolean
  ): void {
    if (!arg) return
    if (sameExpr && arg.kind === 'call' && isDecodeCall(arg)) {
      const decodeChain = resolveExprChain(arg.callee, scope)
      const decodeFn = decodeChain.attrs.at(-1) ?? decodeChain.module ?? 'unknown'
      this.addHit('B11', { kind: 'decode-exec', decodeFn, boundName: '<inline>', stmtDistance: 0 })
      return
    }
    if (arg.kind === 'name') {
      for (const b of decodeBindings) {
        if (b.name === arg.id && stmtIndex - b.stmtOffset <= 3) {
          this.addHit('B11', {
            kind: 'decode-exec', decodeFn: b.decodeFn, boundName: b.name,
            stmtDistance: stmtIndex - b.stmtOffset
          })
          return
        }
      }
    }
    this.analyzeExpr(arg, scope, decodeBindings, stmtIndex)
  }

  private checkOpenCall(call: IrExpr & { kind: 'call' }): void {
    const pathExpr = call.args[0]
    const modeKw = call.kwargs.find((k) => k.name === 'mode')
    const modeExpr = modeKw?.value ?? call.args[1]
    let mode: string | null = null
    if (modeExpr) mode = foldStringExpr(modeExpr)
    if (!isWriteMode(mode)) return

    const folded = pathExpr ? foldStringExpr(pathExpr) : null
    if (!folded) {
      this.addHit('A7')
      return
    }
    this.checkWritePath(folded)
  }

  private checkWritePath(path: string): void {
    const kind = classifyPath(path)
    if (kind === 'absolute' || kind === 'dotdot') {
      this.addHit('A7')
    } else {
      this.addHit('A8')
    }
  }
}

export function collectPatternHits(ast: IrModule): PatternHit[] {
  return new Analyzer().analyze(ast)
}

/** Facts-stage projection only: this table classifies detected syntax and never chooses an action. */
const FINDING_CLASS_BY_PATTERN: Record<string, ScriptFinding['class'] | undefined> = {
  A1: 'process-creation',
  A2: 'destructive-fs',
  A3: 'dynamic-execution',
  A4: 'dynamic-import',
  A5: 'native-code-load',
  A6: 'network-api',
  A7: 'file-write',
  A8: 'file-write',
  A9: 'cwd-change',
  B1: 'reflection', B2: 'reflection', B3: 'reflection', B8: 'reflection',
  B4: 'dynamic-import',
  B5: 'alias-resolution', B6: 'alias-resolution', B7: 'alias-resolution',
  B9: 'dynamic-dispatch',
  B10: 'network-api',
  B11: 'decode-then-exec'
}

function sourceSnippet(code: string, range: SourceRange): string {
  const lines = code.split('\n')
  const first = range.startLine - 1
  const last = range.endLine - 1
  if (first < 0 || last < first || last >= lines.length) throw new Error('finding source range is outside script')
  if (first === last) return lines[first]!.slice(range.startCol - 1, range.endCol - 1)
  const selected = [lines[first]!.slice(range.startCol - 1)]
  for (let index = first + 1; index < last; index += 1) selected.push(lines[index]!)
  selected.push(lines[last]!.slice(0, range.endCol - 1))
  return selected.join('\n')
}

function buildScriptFindings(code: string, hits: PatternHit[]): ScriptFinding[] | null {
  // A detected class without range or evidence invalidates the whole projection; caller emits
  // failed coverage instead of silently presenting the script as clean. Boundary tests live in
  // scriptContentSecurity.test.ts and the fixture-wide range audit in scriptGolden.test.ts.
  const relevant = hits.filter((hit) => FINDING_CLASS_BY_PATTERN[hit.pattern])
  if (relevant.some((hit) => !hit.range || !hit.evidence)) return null
  return relevant.map((hit) => ({
    pattern: hit.pattern,
    class: hit.pattern === 'B10' && hit.evidence?.kind === 'dynamic-import'
      ? hit.evidence.moduleName && isNetworkModule(hit.evidence.moduleName.split('.')[0]!) ? 'network-api' : 'dynamic-import'
      : hit.pattern === 'B4' && hit.evidence?.kind === 'alias'
        ? 'alias-resolution'
        : FINDING_CLASS_BY_PATTERN[hit.pattern]!,
    range: hit.range!,
    snippet: sourceSnippet(code, hit.range!),
    evidence: hit.pattern === 'B10' && hit.evidence?.kind === 'dynamic-import' && hit.evidence.moduleName
      && isNetworkModule(hit.evidence.moduleName.split('.')[0]!)
      ? { kind: 'network', module: hit.evidence.moduleName.split('.')[0]!, attr: 'dynamic-import' }
      : hit.evidence!
  }))
}

// --- Unmodeled behavior facts ---
function isForcedAskName(name: string | null): boolean {
  return !!name && (REFLECTION_NAMES.has(name) || EXEC_IMPORT_NAMES.has(name))
}

/** Calls whose effect is represented by the shared Analyzer do not need a duplicate uncertainty. */
function hasModeledDangerousCallEffect(
  chain: ResolvedChain,
  callee: IrExpr,
  call: IrExpr & { kind: 'call' },
  scope: Scope
): boolean {
  const lastAttr = chain.attrs[chain.attrs.length - 1]
  if (chain.module === 'asyncio' && lastAttr === 'sleep') return true
  // os.chdir(<static relative literal>) — mirrors A9, but re-validates the path statically
  // since the hit-based A9 rule allows unconditionally.
  if (chain.module === 'os' && lastAttr === 'chdir') {
    const folded = call.args[0] ? foldStringExpr(call.args[0]) : null
    return folded !== null && classifyPath(folded) === 'relative'
  }
  // Constructing a Path(...) object has no side effect by itself; safety is enforced at the
  // write_text/write_bytes call site below (unlink remains an A2 finding).
  if (chain.module === 'pathlib' && lastAttr === 'Path') {
    return true
  }
  if (chain.module === 'pathlib' && (lastAttr === 'write_text' || lastAttr === 'write_bytes') && callee.kind === 'attr') {
    const pathFolded = extractPathLiteral(callee.base, scope)
    return pathFolded !== null && classifyPath(pathFolded) === 'relative'
  }
  return false
}

class ScriptUncertaintyCollector {
  private readonly uncertainties: ScriptUncertainty[] = []
  private locationUnavailable = false

  collect(ast: IrModule): void {
    this.walkStmts(ast.body, createScope())
  }

  getUncertainties(): ScriptUncertainty[] { return this.uncertainties }
  hasUnlocatedFailure(): boolean { return this.locationUnavailable }

  private fail(kind: string, range?: SourceRange, sourceStatus: ScriptUncertainty['sourceStatus'] = 'unknown', dynamicAccess = true): void {
    if (!range) {
      this.locationUnavailable = true
      return
    }
    if (this.uncertainties.some((item) => item.kind === kind && item.range.startLine === range.startLine &&
      item.range.startCol === range.startCol && item.range.endLine === range.endLine && item.range.endCol === range.endCol)) return
    this.uncertainties.push({ kind, range, sourceStatus, dynamicAccess })
  }

  private walkStmts(stmts: IrStmt[], scope: Scope): void {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case 'import':
          applyImportStmt(stmt, scope)
          break
        case 'from_import':
          applyFromImportStmt(stmt, scope)
          break
        case 'assign':
          if (stmt.unpacksValue && !isKnownPrimitiveIterable(stmt.value, scope) && stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          if (stmt.annotation) this.walkExpr(stmt.annotation, scope)
          if (stmt.targets.some((target) => implicitAssignmentTarget(target)) && stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          this.walkExpr(stmt.value, scope)
          for (const target of stmt.targets) applyAssignmentRebind(target, stmt.value, scope)
          break
        case 'annotation':
          this.walkExpr(stmt.annotation, scope)
          break
        case 'aug_assign':
          if (implicitAssignmentTarget(stmt.target) && stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          this.walkExpr(stmt.targetExpr, scope)
          this.walkExpr(stmt.value, scope)
          if (!isKnownPrimitiveExpr(stmt.targetExpr, scope) || !isKnownPrimitiveExpr(stmt.value, scope)) {
            if (stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          }
          break
        case 'expr':
          this.walkExpr(stmt.value, scope)
          break
        case 'if': {
          this.walkExpr(stmt.test, scope)
          const child = createScope(scope)
          this.walkStmts(stmt.body, child)
          this.walkStmts(stmt.orelse, child)
          invalidateBranchWrites([...stmt.body, ...stmt.orelse], scope)
          break
        }
        case 'while': {
          this.walkExpr(stmt.test, scope)
          const child = createScope(scope)
          this.walkStmts(stmt.body, child)
          this.walkStmts(stmt.orelse, child)
          invalidateBranchWrites([...stmt.body, ...stmt.orelse], scope)
          break
        }
        case 'for': {
          this.walkExpr(stmt.iter, scope)
          if (stmt.targetUnpacks && !isKnownPrimitiveIterable(stmt.iter, scope) && stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          const child = createScope(scope)
          child.modules.delete(stmt.target)
          child.attrs.delete(stmt.target)
          child.unknownRoots.add(stmt.target)
          this.walkStmts(stmt.body, child)
          // P0-3 评审修复：漏遍历 else 体会丢失未建模/危险行为事实（remote fail-open）。
          this.walkStmts(stmt.orelse, child)
          invalidateBranchWrites([...stmt.body, ...stmt.orelse], scope)
          break
        }
        case 'with': {
          for (const item of stmt.items) this.walkExpr(item.contextExpr, scope)
          this.walkStmts(stmt.body, createScope(scope))
          invalidateBranchWrites(stmt.body, scope)
          break
        }
        case 'try': {
          this.walkStmts(stmt.body, createScope(scope))
          for (const handler of stmt.handlers) {
            if (handler.typeExpr) this.walkExpr(handler.typeExpr, scope)
            const handlerScope = createScope(scope)
            if (handler.name) invalidateBinding(handler.name, handlerScope)
            this.walkStmts(handler.body, handlerScope)
          }
          this.walkStmts(stmt.orelse, createScope(scope))
          this.walkStmts(stmt.finalbody, createScope(scope))
          const handlerBindings = stmt.handlers.flatMap((handler) => handler.name ? [{ kind: 'delete' as const, targets: [{ kind: 'name' as const, id: handler.name }] }] : [])
          invalidateBranchWrites([...stmt.body, ...stmt.handlers.flatMap((handler) => handler.body), ...handlerBindings, ...stmt.orelse, ...stmt.finalbody], scope)
          for (const handler of stmt.handlers) if (handler.name) invalidateBinding(handler.name, scope)
          break
        }
        case 'function_def': {
          if (stmt.name === 'print') scope.shadowedBuiltinRoots.add(stmt.name)
          if (stmt.decorators.length > 0 && stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          for (const decorator of stmt.decorators) this.walkExpr(decorator, scope)
          for (const value of stmt.defaults) this.walkExpr(value, scope)
          for (const annotation of stmt.annotations ?? []) this.walkExpr(annotation, scope)
          this.walkStmts(stmt.body, createScope(scope))
          break
        }
        case 'class_def': {
          if (stmt.name === 'print') scope.shadowedBuiltinRoots.add(stmt.name)
          if ((stmt.decorators.length > 0 || stmt.bases.length > 0) && stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          for (const decorator of stmt.decorators) this.walkExpr(decorator, scope)
          for (const base of stmt.bases) this.walkExpr(base, scope)
          this.walkStmts(stmt.body, createScope(scope))
          break
        }
        case 'return':
          if (stmt.value) this.walkExpr(stmt.value, scope)
          break
        case 'raise':
          if (stmt.value) this.walkExpr(stmt.value, scope)
          if (stmt.cause) this.walkExpr(stmt.cause, scope)
          break
        case 'assert':
          this.walkExpr(stmt.test, scope)
          if (stmt.message) this.walkExpr(stmt.message, scope)
          break
        case 'delete':
          if (stmt.targets.some((target) => target.kind === 'attr' || target.kind === 'subscript') && stmt.range) this.fail('implicit-call-unresolved', stmt.range)
          for (const target of stmt.targets) this.walkExpr(target, scope)
          break
        case 'global_nonlocal':
        case 'break':
        case 'continue':
        case 'pass':
          break
        default:
          // Unmodeled AST nodes lower coverage and record uncertainty.
          this.fail('unmodeled-statement', (stmt as IrStmt).range)
      }
    }
  }

  private walkExpr(expr: IrExpr, scope: Scope): void {
    switch (expr.kind) {
      case 'string':
      case 'number':
      case 'name':
      case 'bool':
      case 'none':
        return
      case 'attr':
        this.walkExpr(expr.base, scope)
        return
      case 'binop':
        this.walkExpr(expr.left, scope)
        this.walkExpr(expr.right, scope)
        return
      case 'list':
      case 'tuple':
      case 'set':
        if (expr.kind === 'set' && expr.elts.some((item) => !isKnownPrimitiveExpr(item, scope)) && expr.range) this.fail('implicit-call-unresolved', expr.range)
        for (const e of expr.elts) this.walkExpr(e, scope)
        return
      case 'dict':
        for (const key of expr.keys) if (key) this.walkExpr(key, scope)
        for (const value of expr.values) this.walkExpr(value, scope)
        return
      case 'f_string':
        for (const interpolation of expr.interpolations) this.walkExpr(interpolation, scope)
        return
      case 'unaryop':
        this.walkExpr(expr.operand, scope)
        return
      case 'compare':
        this.walkExpr(expr.left, scope)
        this.walkExpr(expr.right, scope)
        return
      case 'boolop':
        for (const value of expr.values) this.walkExpr(value, scope)
        return
      case 'conditional':
        this.walkExpr(expr.test, scope)
        this.walkExpr(expr.body, scope)
        this.walkExpr(expr.orelse, scope)
        return
      case 'subscript':
        this.walkExpr(expr.value, scope)
        this.walkExpr(expr.index, scope)
        return
      case 'slice':
        if (expr.lower) this.walkExpr(expr.lower, scope)
        if (expr.upper) this.walkExpr(expr.upper, scope)
        if (expr.step) this.walkExpr(expr.step, scope)
        return
      case 'lambda':
        for (const value of expr.defaults) this.walkExpr(value, scope)
        this.walkExpr(expr.body, scope)
        return
      case 'await':
      case 'starred':
        this.walkExpr(expr.value, scope)
        return
      case 'yield':
        if (expr.value) this.walkExpr(expr.value, scope)
        return
      case 'comprehension':
        {
        const child = createScope(scope)
        for (const generator of expr.generators) {
          this.walkExpr(generator.iter, scope)
          const knownIterable = isKnownPrimitiveIterable(generator.iter, child)
          for (const target of bindingNames(generator.target)) {
            child.modules.delete(target)
            child.attrs.delete(target)
            child.mutableObjectIds.delete(target)
            if (knownIterable) { child.unknownRoots.delete(target); child.knownPrimitiveRoots.add(target) }
            else { child.knownPrimitiveRoots.delete(target); child.unknownRoots.add(target) }
          }
          for (const condition of generator.conditions) {
            if (!isKnownPrimitiveExpr(condition, child) && condition.range) this.fail('implicit-call-unresolved', condition.range)
            this.walkExpr(condition, child)
          }
        }
        if (expr.compKind === 'set' && !isKnownPrimitiveExpr(expr.elt, child) && expr.elt.range) this.fail('implicit-call-unresolved', expr.elt.range)
        if (expr.compKind === 'dict' && expr.elt.kind === 'tuple' && expr.elt.elts[0] && !isKnownPrimitiveExpr(expr.elt.elts[0], child) && expr.elt.elts[0].range) this.fail('implicit-call-unresolved', expr.elt.elts[0].range)
        this.walkExpr(expr.elt, child)
        return
        }
      case 'named_expr':
        this.walkExpr(expr.value, scope)
        if (!isKnownPrimitiveExpr(expr.value, scope) && expr.range) this.fail('implicit-call-unresolved', expr.range)
        return
      case 'ellipsis':
        return
      case 'call':
        this.walkCall(expr, scope)
        return
      default:
        this.fail('unmodeled-expression', (expr as IrExpr).range)
    }
  }

  private walkCall(call: IrExpr & { kind: 'call' }, scope: Scope): void {
    const callee = call.callee

    if (callee.kind !== 'name' && callee.kind !== 'attr') {
      // Computed call targets have no statically provable source.
      const innerCall = callee.kind === 'call' ? callee : undefined
      const innerName = innerCall?.callee.kind === 'name' ? innerCall.callee.id
        : innerCall?.callee.kind === 'attr' ? innerCall.callee.attr : undefined
      const alreadyObserved = !!innerName && (REFLECTION_NAMES.has(innerName) || EXEC_IMPORT_NAMES.has(innerName))
      if (!alreadyObserved) this.fail('call-target-unresolved', call.range, 'unresolved', true)
      return
    }

    if (callee.kind === 'attr') this.walkExpr(callee.base, scope)
    for (const a of call.args) this.walkExpr(a, scope)
    for (const kw of call.kwargs) this.walkExpr(kw.value, scope)

    const chain = resolveExprChain(callee, scope)
    const lastAttr = chain.attrs[chain.attrs.length - 1] ?? null
    const directName = callee.kind === 'name' ? callee.id : null

    // getattr/hasattr/setattr/delattr/vars/globals/locals/eval/exec/compile/__import__ —
    // always forced ask on remote, regardless of whether args fold to literals.
    if (isForcedAskName(directName) || isForcedAskName(lastAttr)) {
      const isReflection = REFLECTION_NAMES.has(directName ?? '') || REFLECTION_NAMES.has(lastAttr ?? '')
      const targetArg = call.args[isReflection ? 1 : 0]
      const unresolvedTarget = isReflection && targetArg !== undefined && targetArg.kind !== 'string'
      if (unresolvedTarget) this.fail('reflection-target-unresolved', call.range, 'unresolved', true)
      return
    }
    // importlib.import_module(...) — dynamic import, always forced ask.
    if (chain.module === 'importlib' && lastAttr === 'import_module') {
      const moduleArg = call.args[0]
      if (!moduleArg || foldStringExpr(moduleArg) === null) this.fail('dynamic-import-target-unresolved', call.range, 'unresolved', true)
      return
    }
    // Call chain didn't resolve to any statically-known root — unmodeled/variable-borne call.
    if (chain.module === null) {
      this.fail('binding-origin-unknown', call.range, 'unknown', true)
      return
    }
    if (isDangerousModule(chain.module) && !hasModeledDangerousCallEffect(chain, callee, call, scope)) {
      this.fail('unclassified-dangerous-call', call.range, 'resolved', false)
      return
    }
  }
}

export function analyzeScriptContent(
  code: string,
  preParsedIr?: IrModule
): ScriptAnalysisResult {
  try {
    const ast = preParsedIr ?? parsePythonModule(code)
    const analyzer = new Analyzer()
    const hits = analyzer.analyze(ast)
    const findings = buildScriptFindings(code, hits)
    if (!findings) {
      return {
        reason: 'script-analysis-location-unavailable',
        findings: [],
        coverage: 'failed',
        totalCount: 0,
        uncertainties: []
      }
    }

    const uncertaintyCollector = new ScriptUncertaintyCollector()
    uncertaintyCollector.collect(ast)
    if (uncertaintyCollector.hasUnlocatedFailure()) {
      return { reason: 'script-analysis-location-unavailable', findings, coverage: 'failed', totalCount: findings.length, uncertainties: [] }
    }
    const findingAtRange = (uncertainty: ScriptUncertainty, classes?: readonly ScriptFinding['class'][]): boolean => findings.some((finding) =>
      finding.range.startLine === uncertainty.range.startLine && finding.range.startCol === uncertainty.range.startCol &&
      finding.range.endLine === uncertainty.range.endLine && finding.range.endCol === uncertainty.range.endCol &&
      (!classes || classes.includes(finding.class)))
    const collectorUncertainties = uncertaintyCollector.getUncertainties().filter((uncertainty) =>
      uncertainty.kind === 'unclassified-dangerous-call'
        ? !findingAtRange(uncertainty)
        : uncertainty.kind !== 'call-target-unresolved' || !findingAtRange(uncertainty, ['dynamic-dispatch', 'reflection', 'dynamic-execution', 'dynamic-import']))
    const uncertainties = [...analyzer.getUncertainties(), ...collectorUncertainties]
      .filter((uncertainty, index, all) => all.findIndex((candidate) =>
        candidate.kind === uncertainty.kind && candidate.range?.startLine === uncertainty.range?.startLine &&
        candidate.range?.startCol === uncertainty.range?.startCol && candidate.range?.endLine === uncertainty.range?.endLine &&
        candidate.range?.endCol === uncertainty.range?.endCol) === index)
      .filter((uncertainty) => uncertainty.kind !== 'implicit-call-unresolved' || !findings.some((finding) =>
        finding.class === 'dynamic-dispatch' && finding.range.startLine === uncertainty.range.startLine &&
        finding.range.startCol === uncertainty.range.startCol && finding.range.endLine === uncertainty.range.endLine &&
        finding.range.endCol >= uncertainty.range.endCol))
    return { findings, coverage: uncertainties.length ? 'partial' : 'complete', totalCount: findings.length, uncertainties }
  } catch {
    return {
      reason: 'parse_error',
      findings: [],
      coverage: 'failed',
      totalCount: 0,
      uncertainties: []
    }
  }
}
