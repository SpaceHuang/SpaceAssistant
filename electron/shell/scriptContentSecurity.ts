/**
 * Python `run_script` content security analyzer.
 * P1-T3 起：解析前端为 tree-sitter-python（ScriptParserService）+ scriptIr 适配器产出的
 * 事实 IR；本文件保留 Analyzer（A0–A9/B1–B11）/ RemoteCertifier / 模式 ID 体系等全部
 * 判定语义，消费对象自研 AST 换为 IR（§2.2 锚点契约逐条保持）。
 */
import { scriptParserService } from './scriptParserService'
import { adaptPythonModule, foldStringIr } from './scriptIr/pythonAdapter'
import { IrCoverageError, type IrExpr, type IrModule, type IrStmt } from './scriptIr/types'

export type ScriptVerdict = 'allow' | 'ask' | 'deny'

export interface ScriptAnalysisContext {
  remote?: boolean
}

export interface ScriptAnalysisResult {
  verdict: ScriptVerdict
  patterns: string[]
  reason?: string
}

export interface PatternHit {
  pattern: string
  verdict: ScriptVerdict
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

/** 网络命中相关的模式 ID（供脚本提取器识别 `script-network` 信号）。 */
export const NETWORK_PATTERN_IDS = new Set(['A6', 'B10'])

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

const VERDICT_RANK: Record<ScriptVerdict, number> = {
  allow: 0,
  ask: 1,
  deny: 2
}

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

function mergeVerdict(a: ScriptVerdict, b: ScriptVerdict): ScriptVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b
}

function networkVerdict(ctx?: ScriptAnalysisContext): ScriptVerdict {
  return ctx?.remote ? 'deny' : 'ask'
}

function addHit(hits: PatternHit[], pattern: string, verdict: ScriptVerdict): void {
  const existing = hits.find((h) => h.pattern === pattern)
  if (existing) {
    existing.verdict = mergeVerdict(existing.verdict, verdict)
  } else {
    hits.push({ pattern, verdict })
  }
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
  private readonly ctx?: ScriptAnalysisContext

  constructor(ctx?: ScriptAnalysisContext) {
    this.ctx = ctx
  }

  analyze(ast: IrModule): PatternHit[] {
    this.walkStmts(ast.body, createScope(), 0)
    return this.hits
  }

  private walkStmts(stmts: IrStmt[], scope: Scope, startIndex: number): void {
    const decodeBindings: { name: string; stmtOffset: number }[] = []

    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i]!
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
              addHit(this.hits, alias ? 'B7' : 'B6', 'ask')
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
            const v = isNetworkModule(modName) ? networkVerdict(this.ctx) : 'ask'
            addHit(this.hits, 'B4', v)
            addHit(this.hits, 'B10', v)
          }
        }
        // Same-scope rebind: x = os / y = os.system / z = o (alias) / w = y (callable alias)
        if (stmt.targets.length === 1) {
          applyAssignmentRebind(stmt.targets[0]!, stmt.value, scope)
        }
        if (isDecodeCall(stmt.value) && stmt.targets.length === 1) {
          decodeBindings.push({ name: stmt.targets[0]!, stmtOffset: stmtIndex })
        }
        this.analyzeExpr(stmt.value, scope)
        continue
      }

      if (stmt.kind === 'expr') {
        this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
        continue
      }

      if (stmt.kind === 'if') {
        this.analyzeExpr(stmt.test, scope)
        const child = createScope(scope)
        this.walkStmts(stmt.body, child, stmtIndex)
        this.walkStmts(stmt.orelse, child, stmtIndex)
        continue
      }

      if (stmt.kind === 'for') {
        this.analyzeExpr(stmt.iter, scope)
        const child = createScope(scope)
        child.attrs.set(stmt.target, { module: stmt.target, attr: undefined })
        this.walkStmts(stmt.body, child, stmtIndex)
        continue
      }

      // —— IR 扩展语句（tree-sitter 全语法；判定语义保守对齐：体/表达式递归，不新增黑名单）——
      if (stmt.kind === 'aug_assign') {
        // i += 1：按赋值重绑同语义处理（value 为 os.system 等 attr 时保持别名追踪）
        applyAssignmentRebind(stmt.target, stmt.value, scope)
        if (isDecodeCall(stmt.value)) decodeBindings.push({ name: stmt.target, stmtOffset: stmtIndex })
        this.analyzeExpr(stmt.value, scope, decodeBindings, stmtIndex)
        continue
      }
      if (stmt.kind === 'while') {
        this.analyzeExpr(stmt.test, scope, decodeBindings, stmtIndex)
        this.walkStmts(stmt.body, createScope(scope), stmtIndex)
        continue
      }
      if (stmt.kind === 'with') {
        for (const item of stmt.items) {
          this.analyzeExpr(item.contextExpr, scope, decodeBindings, stmtIndex)
        }
        this.walkStmts(stmt.body, createScope(scope), stmtIndex)
        continue
      }
      if (stmt.kind === 'try') {
        this.walkStmts(stmt.body, createScope(scope), stmtIndex)
        for (const handler of stmt.handlers) {
          if (handler.typeExpr) this.analyzeExpr(handler.typeExpr, scope, decodeBindings, stmtIndex)
          this.walkStmts(handler.body, createScope(scope), stmtIndex)
        }
        this.walkStmts(stmt.orelse, createScope(scope), stmtIndex)
        this.walkStmts(stmt.finalbody, createScope(scope), stmtIndex)
        continue
      }
      if (stmt.kind === 'function_def') {
        for (const d of stmt.decorators) this.analyzeExpr(d, scope, decodeBindings, stmtIndex)
        // 函数体在定义作用域内静态可见：递归捕获（禁止 def 内危险调用逃逸）
        this.walkStmts(stmt.body, createScope(scope), stmtIndex)
        continue
      }
      if (stmt.kind === 'class_def') {
        for (const d of stmt.decorators) this.analyzeExpr(d, scope, decodeBindings, stmtIndex)
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
    decodeBindings: { name: string; stmtOffset: number }[] = [],
    stmtIndex = 0
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
    if (expr.kind === 'yield') {
      if (expr.value) this.analyzeExpr(expr.value, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'comprehension') {
      this.analyzeExpr(expr.elt, scope, decodeBindings, stmtIndex)
      for (const g of expr.generators) this.analyzeExpr(g.iter, scope, decodeBindings, stmtIndex)
      return
    }
    if (expr.kind === 'lambda') {
      this.analyzeExpr(expr.body, scope, decodeBindings, stmtIndex)
      return
    }
    // string/number/name/bool/none/ellipsis：叶子，无子表达式
  }

  private analyzeCall(
    call: IrExpr & { kind: 'call' },
    scope: Scope,
    decodeBindings: { name: string; stmtOffset: number }[],
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
      addHit(this.hits, 'B9', 'ask')
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
        const v = isNetworkModule(root) ? networkVerdict(this.ctx) : 'ask'
        addHit(this.hits, 'A4', 'ask')
        addHit(this.hits, 'B10', v)
      }
      this.checkB11(call.args[0], scope, decodeBindings, stmtIndex, true)
      return
    }

    if (calleeChain.module === 'builtins') {
      const attr = calleeChain.attrs[0]
      if (attr === '__import__') {
        const mod = foldStringExpr(call.args[0] ?? { kind: 'none' })
        if (mod && isDangerousModule(mod.split('.')[0]!)) {
          addHit(this.hits, 'B8', 'ask')
          addHit(this.hits, 'A4', 'ask')
          addHit(this.hits, 'B10', 'ask')
        }
      }
      if (attr && EXEC_NAMES.has(attr)) {
        addHit(this.hits, 'B8', 'ask')
        addHit(this.hits, 'A3', 'ask')
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
        const v = isNetworkModule(root) ? networkVerdict(this.ctx) : 'ask'
        addHit(this.hits, 'A4', 'ask')
        addHit(this.hits, 'B4', 'ask')
        addHit(this.hits, 'B10', v)
      }
      return
    }

    // eval / exec / compile — always A3 when callee is the builtin (dynamic args included)
    if (callee.kind === 'name' && EXEC_NAMES.has(callee.id)) {
      addHit(this.hits, 'A3', 'ask')
      const arg = call.args[0]
      if (arg) this.checkB11(arg, scope, decodeBindings, stmtIndex, true)
      return
    }
    if (callee.kind === 'name') {
      const binding = scope.attrs.get(callee.id)
      if (binding?.attr && EXEC_NAMES.has(binding.attr)) {
        addHit(this.hits, binding.attr === callee.id ? 'B6' : 'B7', 'ask')
        addHit(this.hits, 'A3', 'ask')
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
          addHit(this.hits, 'A2', 'ask')
        } else if (pathFolded) {
          this.checkWritePath(pathFolded)
        } else {
          addHit(this.hits, 'A7', 'deny')
        }
      }
    }

    const chain = resolveExprChain(callee, scope)
    const lastAttr = chain.attrs[chain.attrs.length - 1]

    // os.chdir
    if (chain.fullName === 'os.chdir' || (chain.module === 'os' && lastAttr === 'chdir')) {
      addHit(this.hits, 'A9', 'allow')
      return
    }

    // ctypes / cffi
    if (chain.module === 'ctypes' || chain.module === 'cffi') {
      if (lastAttr === 'CDLL' || lastAttr === 'WinDLL' || chain.module === 'cffi') {
        addHit(this.hits, 'A5', 'deny')
      }
    }

    // subprocess.* / pty.* (any attr, including aliased imports)
    if (chain.module === 'subprocess' || chain.module === 'pty') {
      if (chain.root && scope.modules.has(chain.root) && chain.root !== chain.module) {
        addHit(this.hits, 'B5', 'ask')
      }
      addHit(this.hits, 'A1', 'ask')
      return
    }

    // asyncio.create_subprocess_exec / create_subprocess_shell (and aliases)
    if (chain.module === 'asyncio' && lastAttr && ASYNCIO_PROCESS_ATTRS.has(lastAttr)) {
      if (chain.root && scope.modules.has(chain.root) && chain.root !== 'asyncio') {
        addHit(this.hits, 'B5', 'ask')
      }
      addHit(this.hits, 'A1', 'ask')
      return
    }

    // shutil / os dangerous
    if (chain.module === 'shutil' && (lastAttr === 'rmtree' || lastAttr === 'move')) {
      addHit(this.hits, 'A2', 'ask')
      return
    }
    if (chain.module === 'os') {
      // os.system/popen and os.spawn*/posix_spawn* (process-creation table, WP3 item 2)
      if (lastAttr && (A1_OS_ATTRS.has(lastAttr) || OS_SPAWN_ATTRS.has(lastAttr))) {
        if (chain.root && scope.modules.has(chain.root) && chain.root !== 'os') {
          addHit(this.hits, 'B5', 'ask')
        }
        addHit(this.hits, 'A1', 'ask')
        return
      }
      if (lastAttr && ['remove', 'unlink', 'rmdir'].includes(lastAttr)) {
        addHit(this.hits, 'A2', 'ask')
        return
      }
      if (lastAttr && lastAttr.startsWith('exec')) {
        addHit(this.hits, 'A3', 'ask')
        return
      }
    }

    // Network modules
    if (chain.module && isNetworkModule(chain.module)) {
      addHit(this.hits, 'A6', networkVerdict(this.ctx))
      return
    }
    if (chain.module === 'urllib' || chain.fullName?.startsWith('urllib.')) {
      addHit(this.hits, 'A6', networkVerdict(this.ctx))
      return
    }
    if (chain.module === 'http' || chain.fullName?.startsWith('http.client')) {
      addHit(this.hits, 'A6', networkVerdict(this.ctx))
      return
    }

    // Alias-based dangerous calls: o.system, s()
    if (callee.kind === 'name') {
      const binding = scope.attrs.get(callee.id)
      if (binding?.attr && isDangerousAttr(binding.attr)) {
        const viaAlias = callee.id !== binding.attr
        addHit(this.hits, viaAlias ? 'B7' : 'B6', 'ask')
        if (binding.module === 'os' && A1_OS_ATTRS.has(binding.attr)) {
          addHit(this.hits, 'A1', 'ask')
        } else if (binding.module === 'subprocess') {
          addHit(this.hits, 'A1', 'ask')
        } else if (['remove', 'unlink', 'rmdir', 'rmtree'].includes(binding.attr)) {
          addHit(this.hits, 'A2', 'ask')
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
        if (viaModuleAlias) addHit(this.hits, 'B5', 'ask')
        addHit(this.hits, 'A1', 'ask')
        return
      }
      if ((mod === 'subprocess' || mod === 'pty') && attr) {
        if (viaModuleAlias) addHit(this.hits, 'B5', 'ask')
        addHit(this.hits, 'A1', 'ask')
        return
      }
      if (mod === 'asyncio' && attr && ASYNCIO_PROCESS_ATTRS.has(attr)) {
        if (viaModuleAlias) addHit(this.hits, 'B5', 'ask')
        addHit(this.hits, 'A1', 'ask')
        return
      }
      if (viaModuleAlias && attr && isDangerousAttr(attr)) {
        addHit(this.hits, 'B5', 'ask')
        if (mod === 'os' && ['remove', 'unlink', 'rmdir'].includes(attr)) addHit(this.hits, 'A2', 'ask')
      }
      // B4: import_module result chain
      if (resolved.root && scope.modules.has(resolved.root) && attr && isDangerousAttr(attr)) {
        const boundMod = scope.modules.get(resolved.root)
        if (boundMod && isDangerousModule(boundMod)) {
          addHit(this.hits, 'B4', 'ask')
          if (A1_OS_ATTRS.has(attr) || OS_SPAWN_ATTRS.has(attr)) addHit(this.hits, 'A1', 'ask')
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

  private wouldB11(
    arg: IrExpr,
    scope: Scope,
    decodeBindings: { name: string; stmtOffset: number }[],
    stmtIndex: number,
    sameExpr: boolean
  ): boolean {
    if (sameExpr && isDecodeCall(arg)) return true
    if (arg.kind === 'name') {
      for (const b of decodeBindings) {
        if (b.name === arg.id && stmtIndex - b.stmtOffset <= 3) return true
      }
    }
    return false
  }

  private checkGetattr(call: IrExpr & { kind: 'call' }, scope: Scope, isHas: boolean, fromBuiltins = false): void {
    void isHas
    const base = call.args[0]
    const attrExpr = call.args[1]
    const attrFolded = attrExpr ? foldStringExpr(attrExpr) : null

    if (!attrFolded || !isDangerousAttr(attrFolded)) {
      if (fromBuiltins) addHit(this.hits, 'B8', 'ask')
      return
    }

    let baseResolved = false
    if (base) {
      if (base.kind === 'call' && base.callee.kind === 'name' && base.callee.id === '__import__') {
        const importMod = foldStringExpr(base.args[0] ?? { kind: 'none' })
        if (importMod && isDangerousModule(importMod.split('.')[0]!)) {
          addHit(this.hits, 'B2', 'ask')
          const hasFold = base.args[0]?.kind === 'binop' || attrExpr?.kind === 'binop'
          if (hasFold) addHit(this.hits, 'B3', 'ask')
        }
        baseResolved = true
      } else {
        const chain = resolveExprChain(base, scope)
        if (chain.module === 'os' || scope.modules.get(chain.root ?? '') === 'os') {
          addHit(this.hits, 'B1', 'ask')
          baseResolved = true
        } else if (chain.module && isDangerousModule(chain.module)) {
          addHit(this.hits, 'B1', 'ask')
          baseResolved = true
        }
      }
    }

    if (!baseResolved) {
      addHit(this.hits, 'B9', 'ask')
    }

    if (fromBuiltins) addHit(this.hits, 'B8', 'ask')
  }

  private checkB11(
    arg: IrExpr | undefined,
    scope: Scope,
    decodeBindings: { name: string; stmtOffset: number }[],
    stmtIndex: number,
    sameExpr: boolean
  ): void {
    if (!arg) return
    if (sameExpr && isDecodeCall(arg)) {
      addHit(this.hits, 'B11', 'ask')
      return
    }
    if (arg.kind === 'name') {
      for (const b of decodeBindings) {
        if (b.name === arg.id && stmtIndex - b.stmtOffset <= 3) {
          addHit(this.hits, 'B11', 'ask')
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
      addHit(this.hits, 'A7', 'deny')
      return
    }
    this.checkWritePath(folded)
  }

  private checkWritePath(path: string): void {
    const kind = classifyPath(path)
    if (kind === 'absolute' || kind === 'dotdot') {
      addHit(this.hits, 'A7', 'deny')
    } else {
      addHit(this.hits, 'A8', 'allow')
    }
  }
}

export function collectPatternHits(ast: IrModule, ctx?: ScriptAnalysisContext): PatternHit[] {
  return new Analyzer(ctx).analyze(ast)
}

// --- Remote positive-allowlist certification (WP3) ---
//
// The hit-based Analyzer above is a blacklist: it stays silent (no hit → `allow`) for any
// construct it doesn't explicitly recognize as dangerous. That is acceptable for desktop
// (where the user is always in the confirm loop for anything flagged) but not for remote
// auto-allow, where an unrecognized construct must never slip through as `allow`.
//
// RemoteCertifier is a positive allowlist walker: it requires every statement/expression it
// sees to be one of a small set of explicitly-modeled, safe shapes. Any call whose target
// cannot be statically resolved to a name/attribute chain, any reflection or dynamic-import
// or eval/exec call, and any call that resolves into a dangerous module without matching an
// explicit safe-capability entry, marks the whole script as *not* remote-certified. A script
// that fails certification can still get `ask`/`deny` from the hit-based verdict above; it
// simply can never be upgraded to remote `allow`.
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
 * Positive allowlist certification for remote `allow`. Returns true only when every call in
 * the script is statically resolvable and either untouched by DANGEROUS_MODULES or explicitly
 * whitelisted (os.chdir / Path write with static relative path). Used only to *downgrade* an
 * otherwise-`allow` verdict to `ask` on remote; never used to escalate to `deny`.
 */
export function isScriptCertifiedRemoteSafe(ast: IrModule): boolean {
  return new RemoteCertifier().certify(ast)
}

export function aggregateVerdict(hits: PatternHit[]): ScriptVerdict {
  let verdict: ScriptVerdict = 'allow'
  for (const h of hits) {
    verdict = mergeVerdict(verdict, h.verdict)
  }
  return verdict
}

export function analyzeScriptContent(
  code: string,
  ctx?: ScriptAnalysisContext,
  preParsedIr?: IrModule
): ScriptAnalysisResult {
  try {
    const ast = preParsedIr ?? parsePythonModule(code)
    const hits = collectPatternHits(ast, ctx)
    const patterns = hits.map((h) => h.pattern)
    const dedupedPatterns = patterns.length === 0 ? ['A0'] : [...new Set(patterns)]
    const hitVerdict = patterns.length === 0 ? 'allow' : aggregateVerdict(hits)

    // Desktop keeps the existing blacklist-style verdict unchanged. Remote additionally
    // requires positive certification before an `allow` verdict may be returned: any
    // unresolvable/dynamic/reflective construct downgrades `allow` to `ask` (never `deny` —
    // existing deny rules above are untouched and still dominate via aggregateVerdict).
    if (ctx?.remote && hitVerdict === 'allow' && !isScriptCertifiedRemoteSafe(ast)) {
      return {
        verdict: 'ask',
        patterns: dedupedPatterns,
        reason: 'remote_not_certified'
      }
    }

    return { verdict: hitVerdict, patterns: dedupedPatterns }
  } catch {
    return {
      verdict: 'ask',
      patterns: ['A-fail'],
      reason: 'parse_error'
    }
  }
}
