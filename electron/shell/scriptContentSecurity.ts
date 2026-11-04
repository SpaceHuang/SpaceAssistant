/**
 * Python `run_script` content security analyzer.
 * P1-T3 起：解析前端为 tree-sitter-python（ScriptParserService）+ scriptIr 适配器产出的
 * 事实 IR；本文件保留 Analyzer（A0–A9/B1–B11）/ RemoteCertifier / 模式 ID 体系等全部
 * 判定语义，消费对象自研 AST 换为 IR（§2.2 锚点契约逐条保持）。
 */
import { scriptParserService } from './scriptParserService'
import { adaptPythonModule, foldStringIr } from './scriptIr/pythonAdapter'
import { type IrExpr, type IrModule, type IrStmt, type SourceRange } from './scriptIr/types'
import type { ScriptFinding, ScriptFindingEvidence } from '../../src/shared/confirmation/types'

export interface ScriptAnalysisResult {
  findings: ScriptFinding[]
  coverage: 'complete' | 'partial' | 'failed'
  totalCount: number
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
  'asyncio'
])

export const NETWORK_MODULES = new Set([
  'socket',
  'urllib',
  'http',
  'requests',
  'httpx'
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

/** Reflection builtins that must never be certified remote-safe, regardless of args resolved. */
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

interface Scope {
  modules: Map<string, string>
  attrs: Map<string, Binding>
}

function createScope(parent?: Scope): Scope {
  return {
    modules: new Map(parent?.modules),
    attrs: new Map(parent?.attrs)
  }
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
    if (scope.modules.has(cur.id)) {
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
    return {
      root,
      module: mod,
      attrs,
      fullName: mod ? mod + '.' + attrs.join('.') : null
    }
  }

  if (cur.kind === 'call') {
    return resolveExprChain(cur.callee, scope)
  }

  return { root: null, module: null, attrs: [], fullName: null }
}

function isDangerousModule(name: string | null): boolean {
  return name !== null && DANGEROUS_MODULES.has(name)
}

function isNetworkModule(name: string | null): boolean {
  return name !== null && NETWORK_MODULES.has(name)
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
    scope.modules.set(bound, root)
  }
}

function applyFromImportStmt(stmt: Extract<IrStmt, { kind: 'from_import' }>, scope: Scope): void {
  const mod = stmt.module.split('.')[0]!
  for (const { name, alias } of stmt.names) {
    if (name === '*') {
      scope.modules.set(mod, mod)
      continue
    }
    const bound = alias ?? name
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
  if (value.kind === 'name') {
    if (scope.modules.has(value.id)) {
      scope.modules.set(target, scope.modules.get(value.id)!)
      return
    }
    const attrBinding = scope.attrs.get(value.id)
    if (attrBinding) {
      scope.attrs.set(target, { module: attrBinding.module, attr: attrBinding.attr })
      return
    }
    if (DANGEROUS_BUILTIN_NAMES.has(value.id)) {
      scope.attrs.set(target, { module: 'builtins', attr: value.id })
    }
    return
  }
  if (value.kind === 'attr') {
    const chain = resolveExprChain(value, scope)
    const lastAttr = chain.attrs[chain.attrs.length - 1]
    if (chain.module && lastAttr) {
      scope.attrs.set(target, { module: chain.module, attr: lastAttr })
    }
  }
}

/** Extract a static Path(...) constructor literal path, if resolvable, for write-path checks. */
function extractPathLiteral(base: IrExpr, scope: Scope): string | null {
  if (base.kind === 'call') {
    const ctor = resolveExprChain(base.callee, scope)
    const pathBinding = ctor.root ? scope.attrs.get(ctor.root) : undefined
    const isPath =
      ctor.root === 'Path' ||
      ctor.module === 'pathlib' ||
      pathBinding?.module === 'pathlib' ||
      (base.callee.kind === 'name' && base.callee.id === 'Path')
    if (isPath) {
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
  private activeRange?: SourceRange
  private activeExpr?: IrExpr
  private activeScope?: Scope

  analyze(ast: IrModule): PatternHit[] {
    this.walkStmts(ast.body, createScope(), 0)
    return this.hits
  }

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
      const rawPath = pathExpr ? (foldStringIr(pathExpr) ?? (pathExpr.kind === 'call' ? foldStringIr(pathExpr.args[0] ?? { kind: 'none' }) : null)) : null
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
        const modName = this.extractImportModuleName(stmt.value)
        if (modName && stmt.targets.length === 1) {
          scope.modules.set(stmt.targets[0]!, modName)
          if (isDangerousModule(modName)) {
            const importEvidence: ScriptFindingEvidence = { kind: 'dynamic-import', moduleName: modName, boundName: stmt.targets[0]! }
            this.addHit('B4', importEvidence)
            this.addHit('B10', importEvidence)
          }
        }
        // Same-scope rebind: x = os / y = os.system / z = o (alias) / w = y (callable alias)
        if (stmt.targets.length === 1) {
          applyAssignmentRebind(stmt.targets[0]!, stmt.value, scope)
        }
        if (isDecodeCall(stmt.value) && stmt.targets.length === 1) {
          decodeBindings.push({ name: stmt.targets[0]!, stmtOffset: stmtIndex, decodeFn: decodeFunctionName(stmt.value) })
        }
        this.analyzeExpr(stmt.value, scope)
        continue
      }

      if (stmt.kind === 'expr') {
        this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
        continue
      }

      if (stmt.kind === 'if') {
        // N14:if test 是 walrus 的典型位置——decode 登记必须进主链
        this.analyzeExpr(stmt.test, scope, decodeBindings, stmtIndex)
        const child = createScope(scope)
        this.walkStmts(stmt.body, child, stmtIndex, decodeBindings)
        this.walkStmts(stmt.orelse, child, stmtIndex, decodeBindings)
        continue
      }

      if (stmt.kind === 'for') {
        this.analyzeExpr(stmt.iter, scope, decodeBindings, stmtIndex)
        const child = createScope(scope)
        child.attrs.set(stmt.target, { module: stmt.target, attr: undefined })
        this.walkStmts(stmt.body, child, stmtIndex, decodeBindings)
        // P0-3 评审修复：for...else 的 else 体在循环正常结束时真实执行——必须分析
        this.walkStmts(stmt.orelse, child, stmtIndex, decodeBindings)
        continue
      }

      // —— IR 扩展语句（tree-sitter 全语法；判定语义保守对齐：体/表达式递归，不新增黑名单）——
      if (stmt.kind === 'aug_assign') {
        // i += 1：按赋值重绑同语义处理（value 为 os.system 等 attr 时保持别名追踪）
        applyAssignmentRebind(stmt.target, stmt.value, scope)
        if (isDecodeCall(stmt.value)) decodeBindings.push({ name: stmt.target, stmtOffset: stmtIndex, decodeFn: decodeFunctionName(stmt.value) })
        this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
        continue
      }
      if (stmt.kind === 'while') {
        this.analyzeExpr(stmt.test, scope, decodeBindings, stmtIndex)
        this.walkStmts(stmt.body, createScope(scope), stmtIndex, decodeBindings)
        // P1-1 评审修复（补全）：while...else 的 else 体在循环正常结束时真实执行——必须分析
        this.walkStmts(stmt.orelse, createScope(scope), stmtIndex, decodeBindings)
        continue
      }
      if (stmt.kind === 'with') {
        for (const item of stmt.items) {
          this.analyzeExpr(item.contextExpr, scope, decodeBindings, stmtIndex)
        }
        this.walkStmts(stmt.body, createScope(scope), stmtIndex, decodeBindings)
        continue
      }
      if (stmt.kind === 'try') {
        this.walkStmts(stmt.body, createScope(scope), stmtIndex, decodeBindings)
        for (const handler of stmt.handlers) {
          if (handler.typeExpr) this.analyzeExpr(handler.typeExpr, scope, decodeBindings, stmtIndex)
          this.walkStmts(handler.body, createScope(scope), stmtIndex, decodeBindings)
        }
        this.walkStmts(stmt.orelse, createScope(scope), stmtIndex, decodeBindings)
        this.walkStmts(stmt.finalbody, createScope(scope), stmtIndex, decodeBindings)
        continue
      }
      if (stmt.kind === 'function_def') {
        for (const d of stmt.decorators) this.analyzeExpr(d, scope, decodeBindings, stmtIndex)
        // P0-1 评审修复：默认参数值在 def 定义时真实执行——必须分析
        for (const dv of stmt.defaults) this.analyzeExpr(dv, scope, decodeBindings, stmtIndex)
        // 函数体在定义作用域内静态可见：递归捕获（禁止 def 内危险调用逃逸）
        this.walkStmts(stmt.body, createScope(scope), stmtIndex)
        continue
      }
      if (stmt.kind === 'class_def') {
        for (const d of stmt.decorators) this.analyzeExpr(d, scope, decodeBindings, stmtIndex)
        // P0-1 评审修复：基类/关键字参数表达式在 class 创建时真实执行——必须分析
        for (const b of stmt.bases) this.analyzeExpr(b, scope, decodeBindings, stmtIndex)
        this.walkStmts(stmt.body, createScope(scope), stmtIndex)
        continue
      }
      if (stmt.kind === 'return' || stmt.kind === 'assert' || stmt.kind === 'raise') {
        if (stmt.kind === 'assert') this.analyzeExpr(stmt.test, scope, decodeBindings, stmtIndex)
        else if (stmt.value) this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
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
      return
    }
    if (expr.kind === 'binop') {
      this.analyzeExpr(expr.left, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.right, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'attr') {
      this.analyzeExpr(expr.base, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'list' || expr.kind === 'tuple' || expr.kind === 'set') {
      for (const e of expr.elts) this.analyzeExpr(e, scope, decodeBindings, stmtIndex)
      return
    }
    // —— IR 扩展表达式（递归保证调用不逃逸）——
    if (expr.kind === 'f_string') {
      for (const interp of expr.interpolations) this.analyzeExpr(interp, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'unaryop') {
      this.analyzeExpr(expr.operand, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'compare') {
      this.analyzeExpr(expr.left, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.right, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'boolop') {
      for (const v of expr.values) this.analyzeExpr(v, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'conditional') {
      this.analyzeExpr(expr.test, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.body, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.orelse, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'subscript') {
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
      for (const k of expr.keys) if (k) this.analyzeExpr(k, scope, decodeBindings, stmtIndex)
      for (const v of expr.values) this.analyzeExpr(v, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'starred' || expr.kind === 'await') {
      this.analyzeExpr(expr.value, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'named_expr') {
      // v4 评审 obs2:walrus 目标与 assign 同语义——decode→exec 链登记 + 危险别名重绑,
      // 使 (x := b64decode(...)); exec(x) 仍升级为 dangerous(而非降级 locked 确认)。
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr.target)) {
        applyAssignmentRebind(expr.target, expr.value, scope)
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
      this.analyzeExpr(expr.elt, scope, decodeBindings, stmtIndex)
      for (const g of expr.generators) {
        this.analyzeExpr(g.iter, scope, decodeBindings, stmtIndex)
        // v4:条件子句进入分析(条件内调用不逃逸)
        for (const cond of g.conditions) this.analyzeExpr(cond, scope, decodeBindings, stmtIndex)
      }
      return
    }
    if (expr.kind === 'lambda') {
      // P0-1 评审修复：lambda 默认值在定义时真实执行——必须分析
      for (const dv of expr.defaults) this.analyzeExpr(dv, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.body, scope, decodeBindings, stmtIndex)
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
        if (binding.module === 'os' && A1_OS_ATTRS.has(binding.attr)) {
          this.addHit('A1')
        } else if (binding.module === 'subprocess') {
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

const MAX_SCRIPT_FINDING_SNIPPET_CHARS = 2000

function sourceSnippet(code: string, range: SourceRange): string {
  const lines = code.split('\n')
  const first = range.startLine - 1
  const last = range.endLine - 1
  if (first < 0 || last < first || last >= lines.length) throw new Error('finding source range is outside script')
  const sliceBytes = (line: string, start: number, end: number) =>
    Buffer.from(line, 'utf8').subarray(start, end).toString('utf8')
  if (first === last) return limitSnippet(sliceBytes(lines[first]!, range.startCol - 1, range.endCol - 1))
  const selected = [sliceBytes(lines[first]!, range.startCol - 1, Buffer.byteLength(lines[first]!, 'utf8'))]
  for (let index = first + 1; index < last; index += 1) selected.push(lines[index]!)
  selected.push(sliceBytes(lines[last]!, 0, range.endCol - 1))
  return limitSnippet(selected.join('\n'))
}

function limitSnippet(snippet: string): string {
  return Array.from(snippet).slice(0, MAX_SCRIPT_FINDING_SNIPPET_CHARS).join('')
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
      ? 'dynamic-import'
      : hit.pattern === 'B4' && hit.evidence?.kind === 'alias'
        ? 'alias-resolution'
        : FINDING_CLASS_BY_PATTERN[hit.pattern]!,
    range: hit.range!,
    snippet: sourceSnippet(code, hit.range!),
    evidence: hit.evidence!
  }))
}

// --- Remote positive-allowlist certification (WP3) ---
//
// The hit-based Analyzer above reports recognized syntax facts. Remote certification remains
// a separate positive allowlist check; policy decides how either result affects execution.
//
// RemoteCertifier is a positive allowlist walker: it requires every statement/expression it
// sees to be one of a small set of explicitly-modeled, safe shapes. Any call whose target
// cannot be statically resolved to a name/attribute chain, any reflection or dynamic-import
// or eval/exec call, and any call that resolves into a dangerous module without matching an
// explicit safe-capability entry, marks the whole script as *not* remote-certified. A script
// A script that fails certification remains independently marked uncertified for policy.
function isForcedAskName(name: string | null): boolean {
  return !!name && (REFLECTION_NAMES.has(name) || EXEC_IMPORT_NAMES.has(name))
}

/** Explicit remote safe-capability whitelist for calls that touch a DANGEROUS_MODULES root. */
function isCertifiedSafeDangerousCall(
  chain: ResolvedChain,
  callee: IrExpr,
  call: IrExpr & { kind: 'call' },
  scope: Scope
): boolean {
  const lastAttr = chain.attrs[chain.attrs.length - 1]
  // os.chdir(<static relative literal>) — mirrors A9, but re-validates the path statically
  // since the hit-based A9 rule allows unconditionally.
  if (chain.module === 'os' && lastAttr === 'chdir') {
    const folded = call.args[0] ? foldStringExpr(call.args[0]) : null
    return folded !== null && classifyPath(folded) === 'relative'
  }
  // Constructing a Path(...) object has no side effect by itself; safety is enforced at the
  // write_text/write_bytes call site below (unlink is never certifiable — mirrors A2 ask).
  if (chain.module === 'pathlib' && lastAttr === 'Path') {
    return true
  }
  if (chain.module === 'pathlib' && (lastAttr === 'write_text' || lastAttr === 'write_bytes') && callee.kind === 'attr') {
    const pathFolded = extractPathLiteral(callee.base, scope)
    return pathFolded !== null && classifyPath(pathFolded) === 'relative'
  }
  return false
}

class RemoteCertifier {
  private safe = true

  certify(ast: IrModule): boolean {
    this.walkStmts(ast.body, createScope())
    return this.safe
  }

  private fail(): void {
    this.safe = false
  }

  private walkStmts(stmts: IrStmt[], scope: Scope): void {
    for (const stmt of stmts) {
      if (!this.safe) return
      switch (stmt.kind) {
        case 'import':
          applyImportStmt(stmt, scope)
          break
        case 'from_import':
          applyFromImportStmt(stmt, scope)
          break
        case 'assign':
          this.walkExpr(stmt.value, scope)
          if (stmt.targets.length === 1) applyAssignmentRebind(stmt.targets[0]!, stmt.value, scope)
          break
        case 'expr':
          this.walkExpr(stmt.value, scope)
          break
        case 'if': {
          this.walkExpr(stmt.test, scope)
          const child = createScope(scope)
          this.walkStmts(stmt.body, child)
          this.walkStmts(stmt.orelse, child)
          break
        }
        case 'for': {
          this.walkExpr(stmt.iter, scope)
          const child = createScope(scope)
          child.attrs.set(stmt.target, { module: stmt.target, attr: undefined })
          this.walkStmts(stmt.body, child)
          // P0-3 评审修复：else 体不遍历会让藏在其中的未建模/危险构造逃过认证（remote fail-open）
          this.walkStmts(stmt.orelse, child)
          break
        }
        case 'pass':
          break
        default:
          // Unmodeled AST node — never certify.
          this.fail()
      }
    }
  }

  private walkExpr(expr: IrExpr, scope: Scope): void {
    if (!this.safe) return
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
        for (const e of expr.elts) this.walkExpr(e, scope)
        return
      case 'call':
        this.walkCall(expr, scope)
        return
      default:
        this.fail()
    }
  }

  private walkCall(call: IrExpr & { kind: 'call' }, scope: Scope): void {
    const callee = call.callee

    if (callee.kind !== 'name' && callee.kind !== 'attr') {
      // Call target is itself computed (call-of-call, binop, ...) — variable-borne / unmodeled
      // call object. Never certify.
      this.fail()
      return
    }

    if (callee.kind === 'attr') this.walkExpr(callee.base, scope)
    if (!this.safe) return
    for (const a of call.args) this.walkExpr(a, scope)
    for (const kw of call.kwargs) this.walkExpr(kw.value, scope)
    if (!this.safe) return

    const chain = resolveExprChain(callee, scope)
    const lastAttr = chain.attrs[chain.attrs.length - 1] ?? null
    const directName = callee.kind === 'name' ? callee.id : null

    // getattr/hasattr/setattr/delattr/vars/globals/locals/eval/exec/compile/__import__ —
    // always forced ask on remote, regardless of whether args fold to literals.
    if (isForcedAskName(directName) || isForcedAskName(lastAttr)) {
      this.fail()
      return
    }
    // importlib.import_module(...) — dynamic import, always forced ask.
    if (chain.module === 'importlib' && lastAttr === 'import_module') {
      this.fail()
      return
    }
    // Call chain didn't resolve to any statically-known root — unmodeled/variable-borne call.
    if (chain.module === null) {
      this.fail()
      return
    }
    if (isDangerousModule(chain.module) && !isCertifiedSafeDangerousCall(chain, callee, call, scope)) {
      this.fail()
      return
    }
  }
}

/**
 * Independent positive allowlist certification used to produce the `script-uncertified` fact.
 * The policy layer owns the resulting action; certification itself emits no verdict.
 */
export function isScriptCertifiedRemoteSafe(ast: IrModule): boolean {
  return new RemoteCertifier().certify(ast)
}

export function analyzeScriptContent(
  code: string,
  preParsedIr?: IrModule
): ScriptAnalysisResult {
  try {
    const ast = preParsedIr ?? parsePythonModule(code)
    const hits = collectPatternHits(ast)
    const findings = buildScriptFindings(code, hits)
    if (!findings) {
      return {
        reason: 'script-analysis-location-unavailable',
        findings: [],
        coverage: 'failed',
        totalCount: 0
      }
    }

    return { findings, coverage: 'complete', totalCount: findings.length }
  } catch {
    return {
      reason: 'parse_error',
      findings: [],
      coverage: 'failed',
      totalCount: 0
    }
  }
}
