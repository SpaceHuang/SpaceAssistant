import { parsePythonModule } from '../../shell/scriptContentSecurity'
import { extractPowershellCommandFacts } from '../../shell/powershellCommandFacts'
import { foldStringIr, resolveIrChain, type IrScope } from '../../shell/scriptIr/pythonAdapter'
import type { IrExpr, IrModule, IrStmt } from '../../shell/scriptIr/types'
import { scriptParserService } from '../../shell/scriptParserService'
import * as ts from 'typescript'

export type ScriptPathUnknownReason = 'dynamic-execution' | 'unmodeled-call' | null
export type ScriptPathFacts = {
  paths: string[]
  completeness: 'complete' | 'unknown'
  dynamicAccess: boolean
  /** P1-1:unknown 分类(方案 §5);complete 时为 null。dynamicAccess ⇔ unknownReason === 'dynamic-execution'。 */
  unknownReason: ScriptPathUnknownReason
}
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
// P0-3:纯计算模块前缀白名单(§5 P0-3)。只放「与路径/IO 无关的纯计算」;危险动作各有定向检测
// (FILE_CALLS / PROCESS_CALLS / script-network),不依赖「未建模即危险」假设。
// 安全边界:os 只放 os.path.*(os.remove / os.system 不在其中);pathlib 只放 PurePath,Path 的写方法不放行。
const KNOWN_PURE_PREFIXES = [
  'os.path.', 'json.', 're.', 'math.', 'collections.', 'itertools.', 'functools.',
  'datetime.', 'hashlib.', 'base64.', 'string.', 'textwrap.', 'pathlib.PurePath.'
]
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
  return { paths: [], completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution' }
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

// =========================== Python 遍历(P0 重写) ===========================

/**
 * P1-1 双标志:B2 前置条件——原单一 unknown 无法区分「动态执行」与「未建模调用」,
 * 致使 script-dynamic-access 无区分度。dynamicExecution 供 locked 强处置消费;
 * unmodeledCall 仅作覆盖不足提示(松绑为 ask,可被档位/信任覆盖)。
 */
interface WalkState {
  dynamicExecution: boolean
  unmodeledCall: boolean
}

/**
 * P0-2:遍历环境。consts 只记录「单次赋值、静态可折」的名字;任何重绑定/参数化写入
 * (aug_assign / for 与 comprehension 目标 / del / with-as / 分支与循环体内赋值)即失效。
 * pure 是绑定为纯计算值的名字(其实例方法调用不视为未知面);handles 是文件句柄名
 * (with/assign 绑定 open(...) 的结果,其方法调用针对已登记路径);defs 是本模块定义的
 * 函数/类名(调用点不视为未知面——函数体已递归扫描)。常量不跨函数/类作用域传播。
 */
interface WalkEnv {
  scope: IrScope
  consts: Map<string, string>
  pure: Set<string>
  handles: Set<string>
  defs: Set<string>
}

/** `import os.path` 把 'os' 绑定到 'os.path',链解析会得到 os.path.path.* —— 归一回 os.path.*。 */
function normalizeChain(fullName: string | null): string | null {
  if (!fullName) return null
  return fullName.startsWith('os.path.path.') ? 'os.path.' + fullName.slice('os.path.path.'.length) : fullName
}

function isPureCallChain(chain: string | null): boolean {
  if (!chain) return false
  if (KNOWN_NON_IO_CALLS.has(chain)) return true
  return KNOWN_PURE_PREFIXES.some((prefix) => chain.startsWith(prefix))
}

function isSimpleName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** §10-6 拍板:统一以 '/' 折叠(纯静态求值不知目标平台);平台变体交 probeWritePathFact 归一。 */
function joinPathPosix(parts: string[]): string {
  let result = parts[0] ?? ''
  for (const part of parts.slice(1)) {
    if (part.startsWith('/')) result = part
    else if (part.length === 0) result += '/'
    else result = result + '/' + part
  }
  return result
}

function posixDirname(value: string): string {
  const idx = value.lastIndexOf('/')
  if (idx < 0) return ''
  return idx === 0 ? '/' : value.slice(0, idx)
}

function posixBasename(value: string): string {
  const idx = value.lastIndexOf('/')
  return idx < 0 ? value : value.slice(idx + 1)
}

/**
 * P0-1:在 foldStringIr(string / binop'+' / 单元素 tuple / 全静态 f-string)之上扩展路径
 * 构造器折叠:os.path.join / dirname / basename / splitext[01]、Path·PurePath 构造器与其
 * `/` 运算、以及 P0-2 常量环境中的名字。仅做纯字符串演算,不引入任何 IO 语义。
 */
function foldPathIr(expr: IrExpr, env: WalkEnv): string | null {
  switch (expr.kind) {
    case 'name':
      return env.consts.get(expr.id) ?? null
    case 'binop': {
      if (expr.op !== '+' && expr.op !== '/') return null
      const left = foldPathIr(expr.left, env)
      const right = foldPathIr(expr.right, env)
      if (left === null || right === null) return null
      return expr.op === '+' ? left + right : joinPathPosix([left, right])
    }
    case 'subscript': {
      // os.path.splitext(p)[0 | 1] —— 取段后才是一个完整静态路径
      if (expr.value.kind === 'call') {
        const chain = normalizeChain(resolveIrChain(expr.value.callee, env.scope).fullName)
        if (chain === 'os.path.splitext' && expr.value.args.length === 1 && expr.value.kwargs.length === 0 && expr.index.kind === 'number') {
          const base = foldPathIr(expr.value.args[0]!, env)
          if (base !== null) {
            const dot = base.lastIndexOf('.')
            const index = Number(expr.index.value)
            if (index === 0) return dot > 0 ? base.slice(0, dot) : base
            if (index === 1) return dot > 0 ? base.slice(dot) : ''
          }
        }
      }
      return null
    }
    case 'call': {
      const chain = normalizeChain(resolveIrChain(expr.callee, env.scope).fullName)
      const single = expr.args.length === 1 && expr.kwargs.length === 0
      if ((chain === 'pathlib.Path' || chain === 'pathlib.PurePath' || chain === 'Path' || chain === 'PurePath') && single) {
        return foldPathIr(expr.args[0]!, env)
      }
      if (chain === 'os.path.join' && expr.args.length >= 1 && expr.kwargs.length === 0) {
        const parts: string[] = []
        for (const arg of expr.args) {
          const value = foldPathIr(arg, env)
          if (value === null) return null
          parts.push(value)
        }
        return joinPathPosix(parts)
      }
      if (single && (chain === 'os.path.dirname' || chain === 'os.path.basename')) {
        const value = foldPathIr(expr.args[0]!, env)
        if (value === null) return null
        return chain === 'os.path.dirname' ? posixDirname(value) : posixBasename(value)
      }
      return null
    }
    default:
      return foldStringIr(expr)
  }
}

function staticString(expr: IrExpr | undefined, env: WalkEnv): string | null {
  if (!expr) return null
  return foldPathIr(expr, env)
}

/** P0-2 失效点:任何(再)绑定/删除都先从常量环境移除;非简单名(下标/属性/元组拼接文本)是容器变异,不动基名。 */
function invalidateName(name: string, env: WalkEnv): void {
  if (!isSimpleName(name)) return
  env.consts.delete(name)
  env.pure.delete(name)
  env.handles.delete(name)
}

function isPureValueExpr(expr: IrExpr, env: WalkEnv): boolean {
  if (expr.kind !== 'call') return false
  const chain = normalizeChain(resolveIrChain(expr.callee, env.scope).fullName)
  if (isPureCallChain(chain)) return true
  return chain !== null && env.defs.has(chain.split('.')[0]!)
}

function isHandleValueExpr(expr: IrExpr, env: WalkEnv): boolean {
  if (expr.kind !== 'call') return false
  const chain = normalizeChain(resolveIrChain(expr.callee, env.scope).fullName)
  return chain !== null && FILE_CALLS.has(chain)
}

function isPathCtorChain(chain: string | null | undefined): boolean {
  return chain === 'Path' || chain === 'PurePath' || chain === 'pathlib.PurePath' || Boolean(chain?.endsWith('.Path'))
}

function walkExpr(expr: IrExpr, env: WalkEnv, paths: Set<string>, state: WalkState): void {
  if (expr.kind === 'call') {
    const chain = normalizeChain(resolveIrChain(expr.callee, env.scope).fullName)
    if (chain && PROCESS_CALLS.has(chain)) state.dynamicExecution = true
    const pathMethod = expr.callee.kind === 'attr' ? expr.callee.attr : ''
    const receiver = expr.callee.kind === 'attr' ? expr.callee.base : undefined
    const receiverConstructor = receiver?.kind === 'call' ? normalizeChain(resolveIrChain(receiver.callee, env.scope).fullName) : undefined
    // 形态1:Path(x).read_text();扩展:Path 实例经常量环境中转(p = Path("x") / "b" 后 p.read_text())
    const receiverConst = receiver?.kind === 'name' ? env.consts.get(receiver.id) ?? null : null
    const isPathMethod = Boolean(
      (receiverConstructor && isPathCtorChain(receiverConstructor)) || receiverConst !== null
    ) && ['open', 'read_text', 'read_bytes', 'write_text', 'write_bytes'].includes(pathMethod)
    if (isPathMethod) {
      const value = receiver?.kind === 'call'
        ? (receiver.args.length === 1 ? staticString(receiver.args[0], env) : null)
        : receiverConst
      if (value === null) state.dynamicExecution = true
      else paths.add(value)
    } else if (chain && FILE_CALLS.has(chain)) {
      const count = chain === 'os.rename' || chain === 'os.replace' || chain === 'shutil.copy' || chain === 'shutil.copy2' || chain === 'shutil.move' ? 2 : 1
      if (expr.args.length < count || expr.args.slice(0, count).some((arg) => staticString(arg, env) === null)) {
        state.dynamicExecution = true
      }
      for (const arg of expr.args.slice(0, count)) {
        const value = staticString(arg, env)
        if (value !== null) paths.add(value)
      }
      // Keyword paths are accepted only when their value is a static string.
      for (const kw of expr.kwargs) {
        if (['file', 'path', 'src', 'dst', 'source', 'destination'].includes(kw.name)) {
          const value = staticString(kw.value, env)
          if (value === null) state.dynamicExecution = true
          else paths.add(value)
        }
      }
    }
    const receiverName = receiver?.kind === 'name' ? receiver.id : undefined
    const receiverTyped = receiverName !== undefined && (env.pure.has(receiverName) || env.handles.has(receiverName))
    const isPathConstructor = isPathCtorChain(chain)
    const localDefRoot = chain ? chain.split('.')[0]! : null
    const isLocalDefCall = localDefRoot !== null && env.defs.has(localDefRoot)
    // ★ catch-all:未建模调用仅在「不与任何已知面相关」时落 unknown(P0 收窄:
    // 纯计算链 / 本地定义调用 / 纯值·句柄接收者不再触发;危险面仍由定向名单覆盖)。
    if (
      !(chain && (FILE_CALLS.has(chain) || PROCESS_CALLS.has(chain) || isPureCallChain(chain))) &&
      !isPathMethod && !isPathConstructor && !receiverTyped && !isLocalDefCall
    ) state.unmodeledCall = true
    walkExpr(expr.callee, env, paths, state)
    expr.args.forEach((arg) => walkExpr(arg, env, paths, state))
    expr.kwargs.forEach((kw) => walkExpr(kw.value, env, paths, state))
    return
  }
  switch (expr.kind) {
    case 'attr': walkExpr(expr.base, env, paths, state); break
    case 'binop': walkExpr(expr.left, env, paths, state); walkExpr(expr.right, env, paths, state); break
    case 'unaryop': walkExpr(expr.operand, env, paths, state); break
    case 'compare': walkExpr(expr.left, env, paths, state); walkExpr(expr.right, env, paths, state); break
    case 'boolop': expr.values.forEach((v) => walkExpr(v, env, paths, state)); break
    case 'conditional': walkExpr(expr.test, env, paths, state); walkExpr(expr.body, env, paths, state); walkExpr(expr.orelse, env, paths, state); break
    case 'list': case 'tuple': case 'set': expr.elts.forEach((v) => walkExpr(v, env, paths, state)); break
    case 'dict': [...expr.keys, ...expr.values].forEach((v) => { if (v) walkExpr(v, env, paths, state) }); break
    case 'subscript': walkExpr(expr.value, env, paths, state); walkExpr(expr.index, env, paths, state); break
    case 'slice': [expr.lower, expr.upper, expr.step].forEach((v) => { if (v) walkExpr(v, env, paths, state) }); break
    case 'lambda': expr.defaults.forEach((v) => walkExpr(v, env, paths, state)); walkExpr(expr.body, env, paths, state); break
    case 'await': case 'starred': walkExpr(expr.value, env, paths, state); break
    case 'yield': if (expr.value) walkExpr(expr.value, env, paths, state); break
    case 'comprehension':
      // N7:comprehension 目标失效属无害的过度保守——先失效再走 elt,防止把迭代变量当常量
      for (const gen of expr.generators) invalidateName(gen.target, env)
      walkExpr(expr.elt, env, paths, state)
      expr.generators.forEach((g) => walkExpr(g.iter, env, paths, state))
      break
    case 'f_string': if (expr.interpolations.length) state.unmodeledCall = true; expr.interpolations.forEach((v) => walkExpr(v, env, paths, state)); break
  }
}

function walkStatements(stmts: IrStmt[], env: WalkEnv, paths: Set<string>, state: WalkState, bindable: boolean): void {
  const scope = { modules: new Map(env.scope.modules), attrs: new Map(env.scope.attrs) }
  const blockEnv: WalkEnv = { ...env, scope }
  for (const stmt of stmts) {
    if (stmt.kind === 'import' || stmt.kind === 'from_import') { bindImport(scope, stmt); continue }
    switch (stmt.kind) {
      case 'assign': {
        // 折叠先于遍历:RHS 按旧环境求值(允许 p = p + "/x" 自引用旧值),IO 检测仍靠 walkExpr
        const folded = foldPathIr(stmt.value, blockEnv)
        walkExpr(stmt.value, blockEnv, paths, state)
        for (const name of stmt.targets) {
          if (scope.modules.has(name) || scope.attrs.has(name)) state.dynamicExecution = true
          invalidateName(name, blockEnv)
          // P0-2:仅顶层单次赋值绑定常量;分支/循环/try/with/函数体内(bindable=false)不绑定,
          // 只失效——分支可能不执行,绑定值不确定(§10-2 拍板:保守优先)。
          if (!bindable || !isSimpleName(name)) continue
          if (folded !== null) blockEnv.consts.set(name, folded)
          else if (isPureValueExpr(stmt.value, blockEnv)) blockEnv.pure.add(name)
          else if (isHandleValueExpr(stmt.value, blockEnv)) blockEnv.handles.add(name)
        }
        break
      }
      case 'aug_assign':
        // P0-4:aug_assign 不再无条件 unknown(f14);但 IR 丢失运算符,无法证明「+= 后仍静态」——
        // 一律失效(N3:p += os.environ["X"] 不得误判可静态确定)。仅 import 名重绑定保持 unknown。
        if (scope.modules.has(stmt.target) || scope.attrs.has(stmt.target)) state.dynamicExecution = true
        walkExpr(stmt.value, blockEnv, paths, state)
        invalidateName(stmt.target, blockEnv)
        break
      case 'expr': walkExpr(stmt.value, blockEnv, paths, state); break
      case 'if':
        walkExpr(stmt.test, blockEnv, paths, state)
        walkStatements(stmt.body, blockEnv, paths, state, false)
        walkStatements(stmt.orelse, blockEnv, paths, state, false)
        break
      case 'for': {
        walkExpr(stmt.iter, blockEnv, paths, state)
        invalidateName(stmt.target, blockEnv)
        // 循环体两遍扫描:第一遍收集首轮的静态路径;第二遍在体内写入已失效的环境上重扫,
        // 让 loop-carried 重绑定(p 在体内被改写)在次轮起落 unknown
        walkStatements(stmt.body, blockEnv, paths, state, false)
        walkStatements(stmt.body, blockEnv, paths, state, false)
        walkStatements(stmt.orelse, blockEnv, paths, state, false)
        break
      }
      case 'while':
        walkExpr(stmt.test, blockEnv, paths, state)
        walkStatements(stmt.body, blockEnv, paths, state, false)
        walkStatements(stmt.body, blockEnv, paths, state, false)
        walkStatements(stmt.orelse, blockEnv, paths, state, false)
        break
      case 'with': {
        for (const item of stmt.items) {
          walkExpr(item.contextExpr, blockEnv, paths, state)
          for (const name of item.optionalVars) {
            invalidateName(name, blockEnv)
            if (isSimpleName(name) && isHandleValueExpr(item.contextExpr, blockEnv)) blockEnv.handles.add(name)
          }
        }
        walkStatements(stmt.body, blockEnv, paths, state, false)
        break
      }
      case 'try':
        walkStatements(stmt.body, blockEnv, paths, state, false)
        stmt.handlers.forEach((h) => { if (h.typeExpr) walkExpr(h.typeExpr, blockEnv, paths, state); walkStatements(h.body, blockEnv, paths, state, false) })
        walkStatements(stmt.orelse, blockEnv, paths, state, false)
        walkStatements(stmt.finalbody, blockEnv, paths, state, false)
        break
      case 'function_def': {
        stmt.defaults.forEach((v) => walkExpr(v, blockEnv, paths, state))
        stmt.decorators.forEach((v) => walkExpr(v, blockEnv, paths, state))
        blockEnv.defs.add(stmt.name)
        // P0-4:函数定义本身不设 unknown(函数体本就递归扫描);常量/纯值/句柄不跨作用域传播,
        // imports 与已知定义(含自身,支持递归)对函数体可见
        const fnEnv: WalkEnv = { scope, consts: new Map(), pure: new Set(), handles: new Set(), defs: new Set(blockEnv.defs) }
        walkStatements(stmt.body, fnEnv, paths, state, false)
        break
      }
      case 'class_def': {
        stmt.bases.forEach((v) => walkExpr(v, blockEnv, paths, state))
        stmt.decorators.forEach((v) => walkExpr(v, blockEnv, paths, state))
        blockEnv.defs.add(stmt.name)
        const classEnv: WalkEnv = { scope, consts: new Map(), pure: new Set(), handles: new Set(), defs: new Set(blockEnv.defs) }
        walkStatements(stmt.body, classEnv, paths, state, false)
        break
      }
      case 'return': if (stmt.value) walkExpr(stmt.value, blockEnv, paths, state); break
      case 'assert': walkExpr(stmt.test, blockEnv, paths, state); break
      case 'raise': if (stmt.value) walkExpr(stmt.value, blockEnv, paths, state); break
      case 'delete':
        // P0-2:del 精确失效目标名;del import 名视同重绑定(保持 unknown);非 name 形态(下标/属性)忽略
        for (const target of stmt.targets) {
          if (target.kind === 'name') {
            if (scope.modules.has(target.id) || scope.attrs.has(target.id)) state.dynamicExecution = true
            invalidateName(target.id, blockEnv)
          }
          walkExpr(target, blockEnv, paths, state)
        }
        break
      case 'global_nonlocal': state.unmodeledCall = true; break
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
  // JS/TS 未拆双标志:unknown 保守归 dynamic-execution(维持现有强处置,行为不变)
  return {
    paths: [...paths],
    completeness: state.unknown ? 'unknown' : 'complete',
    dynamicAccess: state.unknown,
    unknownReason: state.unknown ? 'dynamic-execution' : null
  }
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
  // PowerShell 同 JS/TS:unknown 保守归 dynamic-execution
  return {
    paths: [...paths],
    completeness: unknown ? 'unknown' : 'complete',
    dynamicAccess: unknown,
    unknownReason: unknown ? 'dynamic-execution' : null
  }
}

/**
 * 基于与脚本安全分析相同 Python 语法树 IR 提取文件路径;未知或间接效果一律 fail-closed。
 *
 * P0(方案 §5)起 unknown 判定收窄:未建模调用仅在触达 IO/动态执行面时触发——
 * 纯计算链(P0-3)、路径构造器折叠(P0-1)与局部常量传播(P0-2)可静态确定的部分
 * 不再产生假阳性;危险动作(FILE_CALLS / PROCESS_CALLS / 网络)仍由定向检测覆盖。
 */
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
  const state: WalkState = { dynamicExecution: false, unmodeledCall: false }
  const env: WalkEnv = { scope: newScope(), consts: new Map(), pure: new Set(), handles: new Set(), defs: new Set() }
  try { walkStatements(ir.body, env, paths, state, true) } catch { return emptyUnknown() }
  const unknown = state.dynamicExecution || state.unmodeledCall
  return {
    paths: [...paths],
    completeness: unknown ? 'unknown' : 'complete',
    dynamicAccess: state.dynamicExecution,
    // 双类并存时按强语义归 dynamic-execution
    unknownReason: !unknown ? null : state.dynamicExecution ? 'dynamic-execution' : 'unmodeled-call'
  }
}
