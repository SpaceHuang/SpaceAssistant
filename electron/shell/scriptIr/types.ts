// P1-T1：脚本安全分析跨语言事实 IR（类型定义）。
//
// IR 是 tree-sitter 语法树（经 scriptIr 适配器）与既有 Analyzer / RemoteCertifier 规则层之间的
// 中间表示。设计约束：
//  1. 覆盖 scriptContentSecurity.ts 中 Analyzer（A0–A9/B1–B11）与 RemoteCertifier 消费的事实全集；
//  2. 每个节点种类在适配器遍历时必须落入四分类之一（已建模 / 可忽略叶子 / 结构性穿透 / 抛
//     IrCoverageError），禁止静默丢弃（§3 不变量 7）；
//  3. 「语法能解析」≠「已建模」——未建模构造由适配器抛错落人工（fail-closed）。
//
// ——— 与旧自研 AST（ModuleAst/Expr/Stmt）的字段级映射表（P1-T1 等价性证明，§2.2 锚点）———
// 旧 Expr.string{value}            → IrExpr string{value}（f-string/隐式拼接由适配器折叠）
// 旧 Expr.number{value}            → IrExpr number{value}
// 旧 Expr.name{id}                 → IrExpr name{id}
// 旧 Expr.attr{base,attr}          → IrExpr attr{base,attr}
// 旧 Expr.call{callee,args,kwargs} → IrExpr call{callee,args,kwargs}（kwargs:{name,value} 不变）
// 旧 Expr.binop{op,left,right}     → IrExpr binop{op,left,right}（+ 为 foldStringExpr 折叠键）
// 旧 Expr.list/tuple{elts}         → IrExpr list/tuple{elts}
// 旧 Expr.bool{value}/none         → IrExpr bool{value}/none
// 旧 Stmt.import{names:{module,alias}}       → IrStmt import（不变）
// 旧 Stmt.from_import{module,names:{name,alias}} → IrStmt from_import（不变；'*' 语义保留）
// 旧 Stmt.assign{targets,value}    → IrStmt assign{targets,value}（重绑跟踪同源）
// 旧 Stmt.expr{value}              → IrStmt expr{value}
// 旧 Stmt.if{test,body,orelse}     → IrStmt if{test,body,orelse}（elif/else 由适配器归并）
// 旧 Stmt.for{target,iter,body,orelse} → IrStmt for（不变）
// 旧 Stmt.pass                     → IrStmt pass
// 旧 ResolvedChain{root,module,attrs,fullName} → 平移复用（resolveExprChain 消费 IrExpr + Scope）
// 旧 foldStringExpr（string / binop'+' / 单元素 tuple）→ 同规则平移 + f_string 全静态折叠
// 新增承载（tree-sitter 全语法导致的扩展，Analyzer 显式处理或保守忽略）：
//   aug_assign / while / with / try / function_def / class_def / return / assert / raise /
//   delete / global_nonlocal / subscript / slice / unaryop / compare / boolop / conditional /
//   dict / set / lambda / await / starred / *_comp / f_string / ellipsis
import type { Node, Tree } from 'web-tree-sitter'

/** 适配器遇到「已解析但未建模」的合法语法构造时抛出（§3 不变量 1(c)，落人工确认）。 */
export class IrCoverageError extends Error {
  constructor(public readonly nodeType: string, detail?: string) {
    super(`IR adapter uncovered node type: ${nodeType}${detail ? ` (${detail})` : ''}`)
    this.name = 'IrCoverageError'
  }
}

export interface IrKwarg {
  name: string
  value: IrExpr
}

export type IrExpr =
  | { kind: 'string'; value: string }
  | { kind: 'f_string'; staticParts: string[]; interpolations: IrExpr[] }
  | { kind: 'number'; value: string }
  | { kind: 'name'; id: string }
  | { kind: 'attr'; base: IrExpr; attr: string }
  | { kind: 'call'; callee: IrExpr; args: IrExpr[]; kwargs: IrKwarg[] }
  | { kind: 'binop'; op: string; left: IrExpr; right: IrExpr }
  | { kind: 'unaryop'; op: string; operand: IrExpr }
  | { kind: 'compare'; op: string; left: IrExpr; right: IrExpr }
  | { kind: 'boolop'; op: 'and' | 'or'; values: IrExpr[] }
  | { kind: 'conditional'; test: IrExpr; body: IrExpr; orelse: IrExpr }
  | { kind: 'list'; elts: IrExpr[] }
  | { kind: 'tuple'; elts: IrExpr[] }
  | { kind: 'dict'; keys: Array<IrExpr | null>; values: IrExpr[] }
  | { kind: 'set'; elts: IrExpr[] }
  | { kind: 'subscript'; value: IrExpr; index: IrExpr }
  | { kind: 'slice'; lower: IrExpr | null; upper: IrExpr | null; step: IrExpr | null }
  | { kind: 'lambda'; params: string[]; body: IrExpr }
  | { kind: 'await'; value: IrExpr }
  | { kind: 'starred'; value: IrExpr }
  | { kind: 'yield'; value: IrExpr | null }
  | { kind: 'comprehension'; elt: IrExpr; generators: Array<{ target: string; iter: IrExpr }> ; compKind: 'list' | 'set' | 'dict' | 'generator' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'none' }
  | { kind: 'ellipsis' }

export interface IrImportName {
  module: string
  alias?: string
}

export type IrStmt =
  | { kind: 'import'; names: IrImportName[] }
  | { kind: 'from_import'; module: string; names: Array<{ name: string; alias?: string }> }
  | { kind: 'assign'; targets: string[]; value: IrExpr }
  | { kind: 'aug_assign'; target: string; value: IrExpr }
  | { kind: 'expr'; value: IrExpr }
  | { kind: 'if'; test: IrExpr; body: IrStmt[]; orelse: IrStmt[] }
  | { kind: 'for'; target: string; iter: IrExpr; body: IrStmt[]; orelse: IrStmt[] }
  | { kind: 'while'; test: IrExpr; body: IrStmt[] }
  | { kind: 'with'; items: Array<{ contextExpr: IrExpr; optionalVars: string[] }>; body: IrStmt[] }
  | {
      kind: 'try'
      body: IrStmt[]
      handlers: Array<{ typeExpr: IrExpr | null; name?: string; body: IrStmt[] }>
      orelse: IrStmt[]
      finalbody: IrStmt[]
    }
  | { kind: 'function_def'; name: string; params: string[]; body: IrStmt[]; decorators: IrExpr[]; isAsync: boolean }
  | { kind: 'class_def'; name: string; body: IrStmt[]; decorators: IrExpr[] }
  | { kind: 'return'; value: IrExpr | null }
  | { kind: 'pass' }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'assert'; test: IrExpr }
  | { kind: 'raise'; value: IrExpr | null }
  | { kind: 'delete'; targets: IrExpr[] }
  | { kind: 'global_nonlocal'; names: string[] }

export interface IrModule {
  body: IrStmt[]
}

/** P1-T3：`parsePythonModule` 的返回类型从 ModuleAst 变更为 IR 根（IrModule）。 */
export type ScriptIrRoot = IrModule

/** 供测试与结构快照使用的归一化 JSON 形状（剥离 undefined 字段）。 */
export function irToJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v === undefined ? null : v)))
}

// tree-sitter CST 类型别名（适配器消费）
export type TsNode = Node
export type TsTree = Tree
