/**
 * Python `run_script` content security analyzer.
 * Hand-written AST subset + string folding + import alias tracking.
 */

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

// --- AST types ---

export type Expr =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'name'; id: string }
  | { kind: 'attr'; base: Expr; attr: string }
  | { kind: 'call'; callee: Expr; args: Expr[]; kwargs: { name: string; value: Expr }[] }
  | { kind: 'binop'; op: string; left: Expr; right: Expr }
  | { kind: 'list'; elts: Expr[] }
  | { kind: 'tuple'; elts: Expr[] }
  | { kind: 'bool'; value: boolean }
  | { kind: 'none' }

export type Stmt =
  | { kind: 'import'; names: { module: string; alias?: string }[] }
  | { kind: 'from_import'; module: string; names: { name: string; alias?: string }[] }
  | { kind: 'assign'; targets: string[]; value: Expr }
  | { kind: 'expr'; value: Expr }
  | { kind: 'if'; test: Expr; body: Stmt[]; orelse: Stmt[] }
  | { kind: 'for'; target: string; iter: Expr; body: Stmt[]; orelse: Stmt[] }
  | { kind: 'pass' }

export interface ModuleAst {
  body: Stmt[]
}

// --- Tokenizer ---

type TokKind =
  | 'ident'
  | 'string'
  | 'number'
  | 'op'
  | 'newline'
  | 'indent'
  | 'dedent'
  | 'eof'

interface Token {
  kind: TokKind
  value: string
  line: number
}

function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: '"' | "'" | null = null
  let triple = 0

  while (i < source.length) {
    const ch = source[i]!
    if (triple > 0) {
      out += ch
      if (ch === quote) {
        triple--
        if (triple === 0) quote = null
      }
      i++
      continue
    }
    if (quote) {
      out += ch
      if (ch === quote && source[i - 1] !== '\\') quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      if (source.slice(i, i + 3) === ch.repeat(3)) {
        quote = ch
        triple = 2
        out += ch.repeat(3)
        i += 3
        continue
      }
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    out += ch
    i++
  }
  return out
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const lines = stripComments(source).split('\n')
  const indents: number[] = [0]
  let lineNo = 1

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const trimmed = line.trim()
    if (!trimmed) {
      lineNo++
      continue
    }

    const leading = line.match(/^\s*/)?.[0]?.length ?? 0
    const curIndent = indents[indents.length - 1]!
    if (leading > curIndent) {
      indents.push(leading)
      tokens.push({ kind: 'indent', value: '', line: lineNo })
    } else {
      while (leading < indents[indents.length - 1]!) {
        indents.pop()
        tokens.push({ kind: 'dedent', value: '', line: lineNo })
      }
    }

    let i = 0
    const push = (kind: TokKind, value: string) => tokens.push({ kind, value, line: lineNo })

    while (i < line.length) {
      const ch = line[i]!
      if (ch === ' ' || ch === '\t') {
        i++
        continue
      }
      if ((ch === 'b' || ch === 'B') && (line[i + 1] === '"' || line[i + 1] === "'")) {
        const quote = line[i + 1]!
        let j = i + 2
        let val = ''
        while (j < line.length) {
          if (line[j] === quote && line[j - 1] !== '\\') break
          val += line[j]!
          j++
        }
        if (j >= line.length) throw new ParseError('unterminated bytes literal', lineNo)
        push('string', val)
        i = j + 1
        continue
      }
      if (ch === '"' || ch === "'") {
        const quote = ch
        let j = i + 1
        let val = ''
        if (line.slice(i, i + 3) === quote.repeat(3)) {
          j = i + 3
          const end = line.indexOf(quote.repeat(3), j)
          if (end === -1) throw new ParseError('unterminated string', lineNo)
          val = line.slice(j, end)
          i = end + 3
        } else {
          while (j < line.length) {
            if (line[j] === quote && line[j - 1] !== '\\') break
            val += line[j]!
            j++
          }
          if (j >= line.length) throw new ParseError('unterminated string', lineNo)
          i = j + 1
        }
        push('string', val)
        continue
      }
      if (/[0-9]/.test(ch)) {
        let j = i
        while (j < line.length && /[0-9.xXa-fA-F_]/.test(line[j]!)) j++
        push('number', line.slice(i, j))
        i = j
        continue
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j]!)) j++
        push('ident', line.slice(i, j))
        i = j
        continue
      }
      const two = line.slice(i, i + 2)
      if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '+=' || two === '-=' || two === '**' || two === '//' || two === '<<' || two === '>>') {
        push('op', two)
        i += 2
        continue
      }
      if ('()[]{},.:;+-*/%=<>&|@'.includes(ch)) {
        push('op', ch)
        i++
        continue
      }
      throw new ParseError(`unexpected char ${ch}`, lineNo)
    }

    tokens.push({ kind: 'newline', value: '', line: lineNo })
    lineNo++
  }

  while (indents.length > 1) {
    indents.pop()
    tokens.push({ kind: 'dedent', value: '', line: lineNo })
  }
  tokens.push({ kind: 'eof', value: '', line: lineNo })
  return tokens
}

export class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

// --- Parser ---

class Parser {
  private pos = 0

  constructor(private readonly tokens: Token[]) {}

  parseModule(): ModuleAst {
    const body = this.parseStmtList()
    this.expect('eof')
    return { body }
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'eof', value: '', line: 0 }
  }

  private advance(): Token {
    return this.tokens[this.pos++] ?? { kind: 'eof', value: '', line: 0 }
  }

  private expect(kind: TokKind, value?: string): Token {
    const t = this.advance()
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new ParseError(`expected ${kind}${value ? ` ${value}` : ''}`, t.line)
    }
    return t
  }

  private at(kind: TokKind, value?: string): boolean {
    const t = this.peek()
    return t.kind === kind && (value === undefined || t.value === value)
  }

  private skipNewlines(): void {
    while (this.at('newline')) this.advance()
  }

  private parseStmtList(): Stmt[] {
    const stmts: Stmt[] = []
    this.skipNewlines()
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.at('newline')) {
        this.advance()
        continue
      }
      stmts.push(this.parseStmt())
      this.skipNewlines()
    }
    return stmts
  }

  private parseSuite(): Stmt[] {
    if (this.at('newline')) {
      this.advance()
      this.expect('indent')
      const body = this.parseStmtList()
      if (this.at('dedent')) this.advance()
      return body
    }
    return [this.parseSimpleStmt()]
  }

  private parseStmt(): Stmt {
    if (this.at('ident', 'if')) return this.parseIf()
    if (this.at('ident', 'for')) return this.parseFor()
    if (this.at('ident', 'pass')) {
      this.advance()
      return { kind: 'pass' }
    }
    return this.parseSimpleStmt()
  }

  private parseIf(): Stmt {
    this.advance()
    const test = this.parseExpr()
    const body = this.parseSuite()
    let orelse: Stmt[] = []
    this.skipNewlines()
    if (this.at('ident', 'else')) {
      this.advance()
      orelse = this.parseSuite()
    }
    return { kind: 'if', test, body, orelse }
  }

  private parseFor(): Stmt {
    this.advance()
    const target = this.expect('ident').value
    this.expect('ident', 'in')
    const iter = this.parseExpr()
    const body = this.parseSuite()
    return { kind: 'for', target, iter, body, orelse: [] }
  }

  private parseSimpleStmt(): Stmt {
    if (this.at('ident', 'import')) return this.parseImport()
    if (this.at('ident', 'from')) return this.parseFromImport()

    const expr = this.parseExpr()
    if (this.at('op', '=')) {
      this.advance()
      const value = this.parseExpr()
      const targets = this.exprToTargets(expr)
      return { kind: 'assign', targets, value }
    }
    return { kind: 'expr', value: expr }
  }

  private exprToTargets(expr: Expr): string[] {
    if (expr.kind === 'name') return [expr.id]
    if (expr.kind === 'tuple') {
      return expr.elts.filter((e): e is Extract<Expr, { kind: 'name' }> => e.kind === 'name').map((e) => e.id)
    }
    throw new ParseError('invalid assign target', this.peek().line)
  }

  private parseDottedName(): string {
    let name = this.expect('ident').value
    while (this.at('op', '.')) {
      this.advance()
      name += '.' + this.expect('ident').value
    }
    return name
  }

  private parseImport(): Stmt {
    this.advance()
    const names: { module: string; alias?: string }[] = []
    do {
      const module = this.parseDottedName()
      let alias: string | undefined
      if (this.at('ident', 'as')) {
        this.advance()
        alias = this.expect('ident').value
      }
      names.push({ module, alias })
    } while (this.at('op', ',') && (this.advance(), true))
    return { kind: 'import', names }
  }

  private parseFromImport(): Stmt {
    this.advance()
    const module = this.parseDottedName()
    this.expect('ident', 'import')
    const names: { name: string; alias?: string }[] = []
    const first = this.expect('ident').value
    if (first === '*') {
      names.push({ name: '*' })
    } else {
      let name = first
      let alias: string | undefined
      if (this.at('ident', 'as')) {
        this.advance()
        alias = this.expect('ident').value
      }
      names.push({ name, alias })
      while (this.at('op', ',')) {
        this.advance()
        name = this.expect('ident').value
        alias = undefined
        if (this.at('ident', 'as')) {
          this.advance()
          alias = this.expect('ident').value
        }
        names.push({ name, alias })
      }
    }
    return { kind: 'from_import', module, names }
  }

  private parseExpr(): Expr {
    return this.parseCompare()
  }

  private parseCompare(): Expr {
    let left = this.parseBinOp(0)
    while (this.at('op', '<') || this.at('op', '>') || this.at('op', '==') || this.at('op', '!=') || this.at('ident', 'in') || this.at('ident', 'is')) {
      const op = this.advance().value
      const right = this.parseBinOp(0)
      left = { kind: 'call', callee: { kind: 'name', id: '__compare__' }, args: [left, { kind: 'string', value: op }, right], kwargs: [] }
    }
    return left
  }

  private parseBinOp(minPrec: number): Expr {
    let left = this.parseUnary()
    while (true) {
      const t = this.peek()
      if (t.kind !== 'op' || !'+-*/%'.includes(t.value)) break
      const prec = t.value === '+' || t.value === '-' ? 1 : 2
      if (prec < minPrec) break
      const op = this.advance().value
      const right = this.parseBinOp(prec + 1)
      left = { kind: 'binop', op, left, right }
    }
    return left
  }

  private parseUnary(): Expr {
    if (this.at('op', '+') || this.at('op', '-') || this.at('op', '~')) {
      const op = this.advance().value
      const arg = this.parseUnary()
      return { kind: 'call', callee: { kind: 'name', id: '__unary__' }, args: [{ kind: 'string', value: op }, arg], kwargs: [] }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Expr {
    let expr = this.parseAtom()
    while (true) {
      if (this.at('op', '.')) {
        this.advance()
        const attr = this.expect('ident').value
        expr = { kind: 'attr', base: expr, attr }
        continue
      }
      if (this.at('op', '(')) {
        this.advance()
        const args: Expr[] = []
        const kwargs: { name: string; value: Expr }[] = []
        if (!this.at('op', ')')) {
          do {
            if (this.at('ident') && this.tokens[this.pos + 1]?.kind === 'op' && this.tokens[this.pos + 1]?.value === '=') {
              const name = this.advance().value
              this.advance()
              kwargs.push({ name, value: this.parseExpr() })
            } else {
              args.push(this.parseExpr())
            }
          } while (this.at('op', ',') && (this.advance(), true))
        }
        this.expect('op', ')')
        expr = { kind: 'call', callee: expr, args, kwargs }
        continue
      }
      break
    }
    return expr
  }

  private parseAtom(): Expr {
    const t = this.peek()
    if (t.kind === 'string') {
      this.advance()
      return { kind: 'string', value: t.value }
    }
    if (t.kind === 'number') {
      this.advance()
      return { kind: 'number', value: t.value }
    }
    if (t.kind === 'ident') {
      const id = this.advance().value
      if (id === 'True') return { kind: 'bool', value: true }
      if (id === 'False') return { kind: 'bool', value: false }
      if (id === 'None') return { kind: 'none' }
      return { kind: 'name', id }
    }
    if (this.at('op', '(')) {
      this.advance()
      if (this.at('op', ')')) {
        this.advance()
        return { kind: 'tuple', elts: [] }
      }
      const first = this.parseExpr()
      if (this.at('op', ',')) {
        this.advance()
        const elts = [first]
        while (!this.at('op', ')')) {
          elts.push(this.parseExpr())
          if (!this.at('op', ',')) break
          this.advance()
        }
        this.expect('op', ')')
        return { kind: 'tuple', elts }
      }
      this.expect('op', ')')
      return first
    }
    if (this.at('op', '[')) {
      this.advance()
      if (this.at('op', ']')) {
        this.advance()
        return { kind: 'list', elts: [] }
      }
      const first = this.parseExpr()
      if (this.at('ident', 'for')) {
        this.advance()
        const target = this.expect('ident').value
        this.expect('ident', 'in')
        const iter = this.parseExpr()
        this.expect('op', ']')
        return { kind: 'list', elts: [{ kind: 'call', callee: { kind: 'name', id: '__listcomp__' }, args: [first, { kind: 'name', id: target }, iter], kwargs: [] }] }
      }
      const elts: Expr[] = [first]
      while (this.at('op', ',')) {
        this.advance()
        if (this.at('op', ']')) break
        elts.push(this.parseExpr())
      }
      this.expect('op', ']')
      return { kind: 'list', elts }
    }
    throw new ParseError('expected expression', t.line)
  }
}

export function parsePythonModule(source: string): ModuleAst {
  const tokens = tokenize(source)
  return new Parser(tokens).parseModule()
}

// --- String folding ---

export function foldStringExpr(expr: Expr): string | null {
  if (expr.kind === 'string') return expr.value
  if (expr.kind === 'binop' && expr.op === '+') {
    const left = foldStringExpr(expr.left)
    const right = foldStringExpr(expr.right)
    if (left !== null && right !== null) return left + right
  }
  if (expr.kind === 'tuple' && expr.elts.length === 1) return foldStringExpr(expr.elts[0]!)
  return null
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

export function resolveExprChain(expr: Expr, scope: Scope): ResolvedChain {
  const attrs: string[] = []
  let root: string | null = null
  let module: string | null = null
  let cur: Expr = expr

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

function applyImportStmt(stmt: Extract<Stmt, { kind: 'import' }>, scope: Scope): void {
  for (const { module, alias } of stmt.names) {
    const root = module.split('.')[0]!
    const bound = alias ?? root
    scope.modules.set(bound, root)
  }
}

function applyFromImportStmt(stmt: Extract<Stmt, { kind: 'from_import' }>, scope: Scope): void {
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
function applyAssignmentRebind(target: string, value: Expr, scope: Scope): void {
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
function extractPathLiteral(base: Expr, scope: Scope): string | null {
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

function isDecodeCall(expr: Expr): boolean {
  if (expr.kind !== 'call') return false
  const chain = resolveExprChain(expr.callee, createScope())
  const last = chain.attrs[chain.attrs.length - 1] ?? chain.module
  return last !== null && DECODE_FUNCS.has(last)
}

function isExecImportCallee(callee: Expr): boolean {
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

  analyze(ast: ModuleAst): PatternHit[] {
    this.walkStmts(ast.body, createScope(), 0)
    return this.hits
  }

  private walkStmts(stmts: Stmt[], scope: Scope, startIndex: number): void {
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
    }
  }

  private extractImportModuleName(expr: Expr): string | null {
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
    expr: Expr,
    scope: Scope,
    decodeBindings: { name: string; stmtOffset: number }[] = [],
    stmtIndex = 0
  ): void {
    if (expr.kind === 'call') {
      this.analyzeCall(expr, scope, decodeBindings, stmtIndex)
    }
    if (expr.kind === 'binop') {
      this.analyzeExpr(expr.left, scope, decodeBindings, stmtIndex)
      this.analyzeExpr(expr.right, scope, decodeBindings, stmtIndex)
    }
    if (expr.kind === 'attr') {
      this.analyzeExpr(expr.base, scope, decodeBindings, stmtIndex)
    }
    if (expr.kind === 'list' || expr.kind === 'tuple') {
      for (const e of expr.elts) this.analyzeExpr(e, scope, decodeBindings, stmtIndex)
    }
  }

  private analyzeCall(
    call: Expr & { kind: 'call' },
    scope: Scope,
    decodeBindings: { name: string; stmtOffset: number }[],
    stmtIndex: number
  ): void {
    const callee = call.callee
    this.analyzeExpr(callee, scope, decodeBindings, stmtIndex)
    for (const a of call.args) this.analyzeExpr(a, scope, decodeBindings, stmtIndex)
    for (const kw of call.kwargs) this.analyzeExpr(kw.value, scope, decodeBindings, stmtIndex)

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
    arg: Expr,
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

  private checkGetattr(call: Expr & { kind: 'call' }, scope: Scope, isHas: boolean, fromBuiltins = false): void {
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
    arg: Expr | undefined,
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

  private checkOpenCall(call: Expr & { kind: 'call' }): void {
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

export function collectPatternHits(ast: ModuleAst, ctx?: ScriptAnalysisContext): PatternHit[] {
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
  callee: Expr,
  call: Expr & { kind: 'call' },
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

  certify(ast: ModuleAst): boolean {
    this.walkStmts(ast.body, createScope())
    return this.safe
  }

  private fail(): void {
    this.safe = false
  }

  private walkStmts(stmts: Stmt[], scope: Scope): void {
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

  private walkExpr(expr: Expr, scope: Scope): void {
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

  private walkCall(call: Expr & { kind: 'call' }, scope: Scope): void {
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
export function isScriptCertifiedRemoteSafe(ast: ModuleAst): boolean {
  return new RemoteCertifier().certify(ast)
}

export function aggregateVerdict(hits: PatternHit[]): ScriptVerdict {
  let verdict: ScriptVerdict = 'allow'
  for (const h of hits) {
    verdict = mergeVerdict(verdict, h.verdict)
  }
  return verdict
}

export function analyzeScriptContent(code: string, ctx?: ScriptAnalysisContext): ScriptAnalysisResult {
  try {
    const ast = parsePythonModule(code)
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
