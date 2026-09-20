// P1-T2：tree-sitter-python 语法树 → 事实 IR 适配器。
//
// 全量覆盖语义（§3 不变量 7）：遍历到的每个 CST 节点种类必须落入
// pythonNodeClassification.ts 的四分类之一：
//   ① IR_MODELED（映射进 IR）/ ② 可忽略叶子 / ③ 结构性穿透（递归子节点）
//   / ④ 其余一律抛 IrCoverageError（→ extraction-failed → 人工，fail-closed）。
// 禁止静默跳过、禁止降级为「无此事实」。
//
// 字符串语义对齐旧实现（§2.2 等价验收）：string.value 为剥离引号后的原始文本
// （转义不解释）；foldStringIr 保留「string / binop'+' / 单元素 tuple」折叠规则并
// 新增 f-string 全静态折叠（有插值 → 不可折叠，插值表达式独立进 IR 供递归分析）。
import { scriptParserService } from '../scriptParserService'
import { IrCoverageError, type IrExpr, type IrKwarg, type IrModule, type IrStmt, type TsNode, type TsTree } from './types'
import {
  IGNORABLE_LEAF_NODES,
  IR_MODELED,
  PASSTHROUGH_NODES
} from './pythonNodeClassification'

export type IrScope = {
  modules: Map<string, string>
  attrs: Map<string, { module: string; attr?: string }>
}

export function adaptPythonModule(tree: TsTree): IrModule {
  const root = tree.rootNode
  if (root.type !== 'module') throw new IrCoverageError(root.type, 'expected module root')
  return { body: adaptBlock(root) }
}

/** 递归收集一段块（module/block/语句序列）内的语句。 */
function adaptBlock(node: TsNode): IrStmt[] {
  const stmts: IrStmt[] = []
  for (const child of namedChildren(node)) {
    const stmt = adaptStmt(child)
    if (stmt) stmts.push(stmt)
  }
  return stmts
}

function namedChildren(node: TsNode): TsNode[] {
  const out: TsNode[] = []
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i)
    if (child?.isNamed) out.push(child)
  }
  return out
}

function fieldNode(node: TsNode, field: string): TsNode | null {
  return node.childForFieldName(field)
}

function fieldNodes(node: TsNode, field: string): TsNode[] {
  return node.childrenForFieldName(field) as unknown as TsNode[]
}

function nodeText(node: TsNode): string {
  return node.text
}

// ---------- 语句 ----------

function adaptStmt(node: TsNode): IrStmt | null {
  const type = node.type
  if (!IR_MODELED.has(type) && !PASSTHROUGH_NODES.has(type)) {
    if (IGNORABLE_LEAF_NODES.has(type)) return null
    throw new IrCoverageError(type, 'statement position')
  }
  switch (type) {
    case 'import_statement': {
      const list: Array<{ module: string; alias?: string }> = []
      for (const child of namedChildren(node)) {
        if (child.type === 'dotted_name' || child.type === 'identifier') {
          list.push({ module: nodeText(child) })
        } else if (child.type === 'aliased_import') {
          const name = fieldNode(child, 'name')
          const alias = fieldNode(child, 'alias')
          list.push({ module: name ? nodeText(name) : '', alias: alias ? nodeText(alias) : undefined })
        } else if (child.type === 'relative_import') {
          list.push({ module: nodeText(child) })
        } else if (child.type === 'wildcard_import') {
          // `import *` 只在 from-import 合法；防御性忽略
        } else {
          throw new IrCoverageError(child.type, 'import_statement child')
        }
      }
      return { kind: 'import', names: list }
    }
    case 'future_import_statement': {
      const list: Array<{ name: string; alias?: string }> = []
      for (const child of namedChildren(node)) {
        if (child.type === 'import_from_statement') {
          const stmt = adaptStmt(child)
          if (stmt?.kind === 'from_import') {
            return { kind: 'from_import', module: `__future__`, names: stmt.names }
          }
        }
      }
      return { kind: 'from_import', module: '__future__', names: list }
    }
    case 'import_from_statement': {
      const moduleNode = fieldNode(node, 'module_name')
      const names: Array<{ name: string; alias?: string }> = []
      for (const child of namedChildren(node)) {
        if (moduleNode && child.id === moduleNode.id) continue
        if (child.type === 'dotted_name' || child.type === 'identifier') {
          names.push({ name: nodeText(child) })
        } else if (child.type === 'aliased_import') {
          const name = fieldNode(child, 'name')
          const alias = fieldNode(child, 'alias')
          names.push({ name: name ? nodeText(name) : '', alias: alias ? nodeText(alias) : undefined })
        } else if (child.type === 'wildcard_import') {
          names.push({ name: '*' })
        } else if (child.type === 'relative_import') {
          // module 位置已在 module_name
        } else {
          throw new IrCoverageError(child.type, 'import_from_statement child')
        }
      }
      const module = moduleNode ? nodeText(moduleNode) : relativeImportText(node)
      return { kind: 'from_import', module, names }
    }
    case 'relative_import': {
      // 独立出现的 relative_import（module 位置缺失时的兜底）：按 from-import 空 names 处理
      return { kind: 'from_import', module: nodeText(node), names: [] }
    }
    case 'expression_statement': {
      const expr = fieldNode(node, 'expression') ?? firstNamed(node)
      if (!expr) return null
      // 赋值/增强赋值在 expression_statement 之外也可能裸出现（文件级）；统一走 assign 判定
      const inner = adaptStmtOfExpression(expr)
      return inner ?? { kind: 'expr', value: adaptExpr(expr) }
    }
    case 'assignment': {
      return adaptAssignment(node)
    }
    case 'augmented_assignment': {
      const left = fieldNode(node, 'left')
      const right = fieldNode(node, 'right')
      if (!left || !right) throw new IrCoverageError(type, 'augmented_assignment missing operands')
      const target = assignTargetName(left)
      return { kind: 'aug_assign', target, value: adaptExpr(right) }
    }
    case 'if_statement': {
      const cond = fieldNode(node, 'condition')
      const then = fieldNode(node, 'consequence')
      // elif/else 链都在 alternative 字段（multiple），按序归并为 orelse 嵌套
      const alts = fieldNodes(node, 'alternative')
      return {
        kind: 'if',
        test: cond ? adaptExpr(cond) : { kind: 'none' },
        body: then ? adaptBlock(then) : [],
        orelse: alts.length > 0 ? adaptAlternatives(alts) : []
      }
    }
    case 'for_statement': {
      const left = fieldNode(node, 'left')
      const right = fieldNode(node, 'right')
      const body = fieldNode(node, 'body')
      const alts = fieldNodes(node, 'alternative')
      const target = left ? assignTargetName(left) : ''
      return {
        kind: 'for',
        target,
        iter: right ? adaptExpr(right) : { kind: 'none' },
        body: body ? adaptBlock(body) : [],
        orelse: alts.length > 0 ? adaptAlternatives(alts) : []
      }
    }
    case 'while_statement': {
      const cond = fieldNode(node, 'condition')
      const body = fieldNode(node, 'body')
      // P1-1 评审修复：while...else 的 else 体必须进 IR（for 已处理 alternative）
      const alts = fieldNodes(node, 'alternative')
      return {
        kind: 'while',
        test: cond ? adaptExpr(cond) : { kind: 'none' },
        body: body ? adaptBlock(body) : [],
        orelse: alts.length > 0 ? adaptAlternatives(alts) : []
      }
    }
    case 'with_statement': {
      const body = fieldNode(node, 'body')
      const items: Array<{ contextExpr: IrExpr; optionalVars: string[] }> = []
      for (const child of namedChildren(node)) {
        if (child.type === 'with_clause') {
          for (const item of namedChildren(child)) {
            if (item.type === 'with_item') {
              const value = fieldNode(item, 'value')
              const alias = fieldNode(item, 'alias')
              // value 形态：裸表达式或 as_pattern（with open(f) as fh）
              let contextExpr: IrExpr
              const optionalVars: string[] = []
              if (value?.type === 'as_pattern') {
                const pattern = firstNamed(value)
                contextExpr = pattern ? adaptExpr(pattern) : { kind: 'none' }
                const target = fieldNode(value, 'alias')
                if (target) optionalVars.push(nodeText(target))
              } else {
                contextExpr = value ? adaptExpr(value) : { kind: 'none' }
              }
              if (alias) optionalVars.push(nodeText(alias))
              items.push({ contextExpr, optionalVars })
            }
          }
        }
      }
      return { kind: 'with', items, body: body ? adaptBlock(body) : [] }
    }
    case 'try_statement': {
      const body = fieldNode(node, 'body')
      const handlers: Array<{ typeExpr: IrExpr | null; name?: string; body: IrStmt[] }> = []
      let orelse: IrStmt[] = []
      let finalbody: IrStmt[] = []
      for (const child of namedChildren(node)) {
        if (child.type === 'except_clause') {
          const value = fieldNode(child, 'value')
          const alias = fieldNode(child, 'alias')
          // value 形态：裸表达式或 as_pattern（except E as e）；body 为无字段名的 block 子节点
          let typeExpr: IrExpr | null = null
          let handlerName: string | undefined
          if (value?.type === 'as_pattern') {
            const pattern = firstNamed(value)
            typeExpr = pattern ? adaptExpr(pattern) : null
            const target = fieldNode(value, 'alias')
            handlerName = target ? nodeText(target) : undefined
          } else if (value) {
            typeExpr = adaptExpr(value)
          }
          const hBody = namedChildren(child).find((c) => c.type === 'block')
          handlers.push({
            typeExpr,
            ...(handlerName ? { name: handlerName } : {}),
            body: hBody ? adaptBlock(hBody) : []
          })
        } else if (child.type === 'finally_clause') {
          const fBody = namedChildren(child).find((c) => c.type === 'block')
          finalbody = fBody ? adaptBlock(fBody) : []
        } else if (child.type === 'else_clause') {
          const eBody = fieldNode(child, 'body')
          orelse = eBody ? adaptBlock(eBody) : []
        }
      }
      return { kind: 'try', body: body ? adaptBlock(body) : [], handlers, orelse, finalbody }
    }
    case 'return_statement': {
      const value = fieldNode(node, 'argument') ?? firstNamed(node)
      return { kind: 'return', value: value ? adaptExpr(value) : null }
    }
    case 'pass_statement':
      return { kind: 'pass' }
    case 'break_statement':
      return { kind: 'break' }
    case 'continue_statement':
      return { kind: 'continue' }
    case 'assert_statement': {
      const test = firstNamed(node)
      return { kind: 'assert', test: test ? adaptExpr(test) : { kind: 'none' } }
    }
    case 'raise_statement': {
      const arg = fieldNode(node, 'argument') ?? firstNamed(node)
      const cause = fieldNode(node, 'cause')
      if (cause) adaptExpr(cause) // from 子句递归（无独立 IR 承载，遍历保证全量覆盖）
      return { kind: 'raise', value: arg ? adaptExpr(arg) : null }
    }
    case 'delete_statement': {
      const arg = fieldNode(node, 'argument')
      const targets = arg ? namedChildren(arg) : namedChildren(node).slice(0)
      return { kind: 'delete', targets: targets.map((t) => adaptExpr(t)) }
    }
    case 'global_statement':
    case 'nonlocal_statement': {
      const names = namedChildren(node).filter((c) => c.type === 'identifier').map((c) => nodeText(c))
      return { kind: 'global_nonlocal', names }
    }
    case 'function_definition': {
      const name = fieldNode(node, 'name')
      const params = fieldNode(node, 'parameters')
      const body = fieldNode(node, 'body')
      const decorators = fieldNodes(node, 'decorator')
      // 返回类型/类型参数遍历（全量覆盖；generic_type 等落 ④ 抛错）
      const returnType = fieldNode(node, 'return_type')
      if (returnType) for (const c of namedChildren(returnType)) adaptExpr(c)
      const typeParams = fieldNode(node, 'type_parameters')
      if (typeParams) for (const c of namedChildren(typeParams)) adaptExpr(c)
      // P0-1 评审修复：默认参数值在定义时求值——递归进 IR（禁止静默丢弃）
      const defaults = params ? collectParamDefaults(params) : []
      // async def：tree-sitter 产出 function_definition，其首个子节点为匿名 'async' token
      const first = node.child(0)
      const isAsync = first?.type === 'async'
      return {
        kind: 'function_def',
        name: name ? nodeText(name) : '',
        params: params ? collectParamNames(params) : [],
        defaults,
        body: body ? adaptBlock(body) : [],
        decorators: decorators.map((d) => adaptDecorator(d)),
        isAsync
      }
    }
    case 'class_definition': {
      const name = fieldNode(node, 'name')
      const body = fieldNode(node, 'body')
      const decorators = fieldNodes(node, 'decorator')
      // P0-1 评审修复：基类/关键字参数表达式在 class 创建时求值——递归进 IR
      const bases: IrExpr[] = []
      const argsNode = fieldNode(node, 'arguments') ?? namedChildren(node).find((c) => c.type === 'argument_list')
      if (argsNode) {
        for (const child of namedChildren(argsNode)) {
          if (child.type === 'keyword_argument') {
            const value = fieldNode(child, 'value')
            if (value) bases.push(adaptExpr(value))
          } else {
            bases.push(adaptExpr(child))
          }
        }
      }
      return {
        kind: 'class_def',
        name: name ? nodeText(name) : '',
        bases,
        body: body ? adaptBlock(body) : [],
        decorators: decorators.map((d) => adaptDecorator(d))
      }
    }
    // —— ③ 壳节点出现在语句位置的兜底（递归其内部语句）——
    case 'block':
      return null // block 由 adaptBlock 显式消费；不应独立出现在语句位
    default:
      if (PASSTHROUGH_NODES.has(type)) {
        // decorated_definition：@ 装饰器壳 + 内层定义；decorators 注入内层 function_def/class_def
        if (type === 'decorated_definition') {
          for (const child of namedChildren(node)) {
            if (child.type === 'decorator') continue
            const inner = adaptStmt(child)
            if (inner && (inner.kind === 'function_def' || inner.kind === 'class_def')) {
              const outerDecorators = namedChildren(node)
                .filter((c) => c.type === 'decorator')
                .map((d) => adaptDecorator(d))
              inner.decorators = [...outerDecorators, ...inner.decorators]
            }
            if (inner) return inner
          }
          return null
        }
        const inner = firstNamed(node)
        return inner ? adaptStmt(inner) : null
      }
      throw new IrCoverageError(type, 'statement dispatch')
  }
}

function adaptAlternatives(alts: TsNode[]): IrStmt[] {
  if (alts.length === 0) return []
  const [head, ...tail] = alts
  if (head!.type === 'elif_clause') {
    const cond = fieldNode(head!, 'condition')
    const body = fieldNode(head!, 'consequence')
    return [
      {
        kind: 'if',
        test: cond ? adaptExpr(cond) : { kind: 'none' },
        body: body ? adaptBlock(body) : [],
        orelse: adaptAlternatives(tail)
      }
    ]
  }
  if (head!.type === 'else_clause') {
    const body = fieldNode(head!, 'body')
    return body ? adaptBlock(body) : []
  }
  return adaptBlock(head!)
}

function adaptDecorator(node: TsNode): IrExpr {
  // decorator 节点为 @ + 表达式（无 fields）；取其命名子节点
  const inner = firstNamed(node)
  return inner ? adaptExpr(inner) : { kind: 'none' }
}

function collectParamNames(paramsNode: TsNode): string[] {
  const names: string[] = []
  for (const child of namedChildren(paramsNode)) {
    names.push(paramName(child))
  }
  return names
}

function paramName(node: TsNode): string {
  switch (node.type) {
    case 'identifier':
      return nodeText(node)
    case 'default_parameter':
    case 'typed_default_parameter': {
      const name = fieldNode(node, 'name')
      // 类型注解遍历（不产 IR 事实，但保证全量覆盖：generic_type 等落 ④ 抛错）
      const typeNode = fieldNode(node, 'type')
      if (typeNode) adaptExpr(typeNode)
      return name ? nodeText(name) : ''
    }
    case 'typed_parameter': {
      const typeNode = fieldNode(node, 'type')
      if (typeNode) adaptExpr(typeNode)
      const inner = firstNamed(node)
      return inner ? paramName(inner) : ''
    }
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern': {
      const inner = firstNamed(node)
      return inner ? nodeText(inner) : '*'
    }
    case 'parameters':
      return collectParamNames(node).join(',')
    default:
      throw new IrCoverageError(node.type, 'parameter name')
  }
}

/** default_parameter / typed_default_parameter 的默认值表达式（定义时求值，P0-1）。 */
function collectParamDefaults(paramsNode: TsNode): IrExpr[] {
  const defaults: IrExpr[] = []
  for (const child of namedChildren(paramsNode)) {
    if (child.type === 'default_parameter' || child.type === 'typed_default_parameter') {
      const value = fieldNode(child, 'value')
      if (value) defaults.push(adaptExpr(value))
    }
  }
  return defaults
}

function assignTargetName(target: TsNode): string {
  switch (target.type) {
    case 'identifier':
      return nodeText(target)
    case 'pattern_list':
    case 'tuple': {
      const parts = namedChildren(target).map((c) => assignTargetName(c))
      return parts.join(',')
    }
    default:
      // 下标/属性赋值（a[0] = x / a.b = x）取整段文本为目标名，保持「目标非简单名」语义
      return nodeText(target)
  }
}

function patternTargetName(node: TsNode): string {
  switch (node.type) {
    case 'identifier':
      return nodeText(node)
    case 'as_pattern': {
      const target = fieldNode(node, 'alias')
      return target ? patternTargetName(target) : nodeText(node)
    }
    case 'pattern_list':
      return namedChildren(node).map((c) => patternTargetName(c)).join(',')
    default:
      return nodeText(node)
  }
}

function adaptAssignment(node: TsNode): IrStmt {
  const left = fieldNode(node, 'left')
  const right = fieldNode(node, 'right')
  if (!left || !right) throw new IrCoverageError(node.type, 'assignment missing operands')
  const targets = splitAssignmentTargets(left)
  return { kind: 'assign', targets, value: adaptExpr(right) }
}

function splitAssignmentTargets(left: TsNode): string[] {
  if (left.type === 'pattern_list' || left.type === 'tuple') {
    return namedChildren(left).map((c) => assignTargetName(c))
  }
  if (left.type === 'assignment') {
    // 链式赋值 a = b = value：左嵌套
    const inner = adaptAssignment(left)
    return inner.kind === 'assign' ? inner.targets : []
  }
  return [assignTargetName(left)]
}

function adaptStmtOfExpression(node: TsNode): IrStmt | null {
  if (node.type === 'assignment') return adaptAssignment(node)
  if (node.type === 'augmented_assignment') {
    return adaptStmt(node)
  }
  return null
}

function relativeImportText(node: TsNode): string {
  const moduleNode = fieldNode(node, 'module_name')
  return moduleNode ? nodeText(moduleNode) : '.'
}

// ---------- 表达式 ----------

function adaptExpr(node: TsNode): IrExpr {
  const type = node.type
  if (!IR_MODELED.has(type) && !PASSTHROUGH_NODES.has(type)) {
    if (IGNORABLE_LEAF_NODES.has(type)) return { kind: 'none' }
    throw new IrCoverageError(type, 'expression position')
  }
  switch (type) {
    case 'identifier':
      return { kind: 'name', id: nodeText(node) }
    case 'string':
      return adaptString(node)
    case 'concatenated_string': {
      // 隐式拼接：各段折叠拼接（对齐旧实现「逐段 string」语义，静态可折段合并）
      const parts = namedChildren(node).map((c) => adaptExpr(c))
      const folded = parts.map((p) => foldStringIr(p))
      if (folded.every((v) => v !== null)) {
        return { kind: 'string', value: folded.join('') }
      }
      // 含插值段：保留为 f_string 形态（staticParts 为可折段，插值逐个保留）
      const staticParts: string[] = []
      const interpolations: IrExpr[] = []
      for (const p of parts) {
        const f = foldStringIr(p)
        if (f !== null) staticParts.push(f)
        else if (p.kind === 'f_string') {
          staticParts.push(...p.staticParts)
          interpolations.push(...p.interpolations)
        } else interpolations.push(p)
      }
      return { kind: 'f_string', staticParts, interpolations }
    }
    case 'integer':
    case 'float':
      return { kind: 'number', value: nodeText(node) }
    case 'true':
      return { kind: 'bool', value: true }
    case 'false':
      return { kind: 'bool', value: false }
    case 'none':
      return { kind: 'none' }
    case 'ellipsis':
      return { kind: 'ellipsis' }
    case 'attribute': {
      const base = fieldNode(node, 'object')
      const attr = fieldNode(node, 'attribute')
      if (!base || !attr) throw new IrCoverageError(type, 'attribute missing fields')
      return { kind: 'attr', base: adaptExpr(base), attr: nodeText(attr) }
    }
    case 'call':
      return adaptCall(node)
    case 'keyword_argument': {
      // 独立出现的 keyword_argument 只能在 call 上下文（adaptCall 已处理）；此处防御性展开
      const value = fieldNode(node, 'value')
      return value ? adaptExpr(value) : { kind: 'none' }
    }
    case 'binary_operator': {
      const left = fieldNode(node, 'left')
      const right = fieldNode(node, 'right')
      const op = fieldNode(node, 'operator') ?? operatorToken(node)
      if (!left || !right) throw new IrCoverageError(type, 'binary missing operands')
      return {
        kind: 'binop',
        op: op ? nodeText(op) : '?',
        left: adaptExpr(left),
        right: adaptExpr(right)
      }
    }
    case 'comparison_operator': {
      // 链式比较 a < b < c 拆为嵌套 compare；operands 无字段名，取非 operators 的 named 子节点
      const opNodes = new Set(fieldNodes(node, 'operators').map((o) => o.id))
      const children = namedChildren(node).filter((c) => !opNodes.has(c.id))
      const ops = fieldNodes(node, 'operators') as TsNode[]
      if (children.length < 2) throw new IrCoverageError(type, 'comparison operands')
      let acc = adaptExpr(children[0]!)
      for (let i = 1; i < children.length; i += 1) {
        acc = {
          kind: 'compare',
          op: ops[i - 1] ? nodeText(ops[i - 1]!) : '?',
          left: acc,
          right: adaptExpr(children[i]!)
        }
      }
      return acc
    }
    case 'boolean_operator': {
      const left = fieldNode(node, 'left')
      const right = fieldNode(node, 'right')
      const op = fieldNode(node, 'operator') ?? operatorToken(node)
      const values: IrExpr[] = []
      if (left) values.push(adaptExpr(left))
      if (right) values.push(adaptExpr(right))
      return { kind: 'boolop', op: op && nodeText(op) === 'or' ? 'or' : 'and', values }
    }
    case 'unary_operator': {
      const operand = fieldNode(node, 'argument')
      const op = fieldNode(node, 'operator') ?? operatorToken(node)
      if (!operand) throw new IrCoverageError(type, 'unary missing operand')
      return { kind: 'unaryop', op: op ? nodeText(op) : '?', operand: adaptExpr(operand) }
    }
    case 'not_operator': {
      const operand = fieldNode(node, 'argument') ?? firstNamed(node)
      return { kind: 'unaryop', op: 'not', operand: operand ? adaptExpr(operand) : { kind: 'none' } }
    }
    case 'conditional_expression': {
      // 无 fields：named children 依次为 [body, test, orelse]
      const parts = namedChildren(node)
      if (parts.length !== 3) throw new IrCoverageError(type, 'conditional parts=' + parts.length)
      return {
        kind: 'conditional',
        body: adaptExpr(parts[0]!),
        test: adaptExpr(parts[1]!),
        orelse: adaptExpr(parts[2]!)
      }
    }
    case 'list':
    case 'tuple':
    case 'set': {
      const elts = namedChildren(node).map((c) => adaptExpr(c))
      if (type === 'list') return { kind: 'list', elts }
      if (type === 'tuple') return { kind: 'tuple', elts }
      return { kind: 'set', elts }
    }
    case 'dictionary': {
      const keys: Array<IrExpr | null> = []
      const values: IrExpr[] = []
      for (const child of namedChildren(node)) {
        if (child.type === 'pair') {
          const key = fieldNode(child, 'key')
          const value = fieldNode(child, 'value')
          keys.push(key ? adaptExpr(key) : null)
          values.push(value ? adaptExpr(value) : { kind: 'none' })
        } else {
          // ** 展开（dictionary_splat）
          keys.push(null)
          values.push(adaptExpr(child))
        }
      }
      return { kind: 'dict', keys, values }
    }
    case 'pair': {
      // 独立 pair 防御性处理
      const value = fieldNode(node, 'value')
      return value ? adaptExpr(value) : { kind: 'none' }
    }
    case 'subscript': {
      const value = fieldNode(node, 'value')
      const sub = fieldNode(node, 'subscript')
      if (!value || !sub) throw new IrCoverageError(type, 'subscript missing fields')
      return { kind: 'subscript', value: adaptExpr(value), index: adaptSubscriptIndex(sub) }
    }
    case 'slice': {
      // 独立 slice 防御
      return adaptSliceNode(node)
    }
    case 'lambda': {
      const params = fieldNode(node, 'parameters')
      const body = fieldNode(node, 'body')
      return {
        kind: 'lambda',
        params: params ? collectParamNames(params) : [],
        defaults: params ? collectParamDefaults(params) : [],
        body: body ? adaptExpr(body) : { kind: 'none' }
      }
    }
    case 'lambda_parameters':
      return { kind: 'none' }
    case 'await': {
      const inner = firstNamed(node)
      return { kind: 'await', value: inner ? adaptExpr(inner) : { kind: 'none' } }
    }
    case 'yield': {
      const inner = firstNamed(node)
      return { kind: 'yield', value: inner ? adaptExpr(inner) : null } as unknown as IrExpr
    }
    case 'list_splat':
    case 'dictionary_splat': {
      const inner = firstNamed(node)
      return { kind: 'starred', value: inner ? adaptExpr(inner) : { kind: 'none' } }
    }
    case 'parenthesized_expression': {
      const inner = firstNamed(node)
      return inner ? adaptExpr(inner) : { kind: 'none' }
    }
    case 'named_expression': {
      // (x := 1) 海象表达式：对安全面保守取值表达式
      const value = fieldNode(node, 'value')
      return value ? adaptExpr(value) : { kind: 'none' }
    }
    case 'list_comprehension':
    case 'set_comprehension':
    case 'generator_expression':
    case 'dictionary_comprehension':
      return adaptComprehension(node)
    case 'for_in_clause': {
      // 推导式的 generator 子句：独立出现时防御性处理
      const right = fieldNode(node, 'right')
      return right ? adaptExpr(right) : { kind: 'none' }
    }
    case 'if_clause': {
      const cond = firstNamed(node)
      return cond ? adaptExpr(cond) : { kind: 'none' }
    }
    case 'interpolation': {
      const expr = fieldNode(node, 'expression')
      return expr ? adaptExpr(expr) : { kind: 'none' }
    }
    case 'as_pattern': {
      const target = fieldNode(node, 'pattern') ?? firstNamed(node)
      return target ? adaptExpr(target) : { kind: 'none' }
    }
    case 'parenthesized_list_splat': {
      const inner = namedChildren(node).find((c) => c.type === 'list_splat')
      return { kind: 'starred', value: inner ? adaptExpr(inner) : { kind: 'none' } }
    }
    case 'format_expression': {
      const expr = fieldNode(node, 'expression')
      return expr ? adaptExpr(expr) : { kind: 'none' }
    }
    case 'print_statement': {
      // Python 2 print：按调用表达式近似
      const arg = fieldNode(node, 'argument')
      const parts = arg ? namedChildren(arg).map((c) => adaptExpr(c)) : []
      return {
        kind: 'call',
        callee: { kind: 'name', id: 'print' },
        args: parts,
        kwargs: []
      }
    }
    case 'exec_statement': {
      const code = fieldNode(node, 'code')
      return {
        kind: 'call',
        callee: { kind: 'name', id: 'exec' },
        args: code ? [adaptExpr(code)] : [],
        kwargs: []
      }
    }
    case 'chevron': {
      const inner = firstNamed(node)
      return inner ? adaptExpr(inner) : { kind: 'none' }
    }
    default:
      if (PASSTHROUGH_NODES.has(type)) {
        // 参数容器等出现在表达式位（防御）：递归首个语义子节点
        const inner = firstNamed(node)
        return inner ? adaptExpr(inner) : { kind: 'none' }
      }
      throw new IrCoverageError(type, 'expression dispatch')
  }
}

function adaptCall(node: TsNode): IrExpr {
  const callee = fieldNode(node, 'function')
  const argsNode = fieldNode(node, 'arguments')
  const args: IrExpr[] = []
  const kwargs: IrKwarg[] = []
  if (argsNode) {
    for (const child of namedChildren(argsNode)) {
      if (child.type === 'keyword_argument') {
        const name = fieldNode(child, 'name')
        const value = fieldNode(child, 'value')
        kwargs.push({ name: name ? nodeText(name) : '', value: value ? adaptExpr(value) : { kind: 'none' } })
      } else {
        args.push(adaptExpr(child))
      }
    }
  }
  return { kind: 'call', callee: callee ? adaptExpr(callee) : { kind: 'none' }, args, kwargs }
}

function adaptComprehension(node: TsNode): IrExpr {
  const compKind =
    node.type === 'list_comprehension' ? 'list' : node.type === 'set_comprehension' ? 'set' : node.type === 'dictionary_comprehension' ? 'dict' : 'generator'
  let elt: IrExpr | null = null
  let dictKey: IrExpr | null = null
  const generators: Array<{ target: string; iter: IrExpr }> = []
  const body = fieldNode(node, 'body')
  const keyNode = fieldNode(node, 'key')
  for (const child of namedChildren(node)) {
    if (child.type === 'for_in_clause') {
      const left = fieldNode(child, 'left')
      const right = fieldNode(child, 'right')
      generators.push({
        target: left ? assignTargetName(left) : '',
        iter: right ? adaptExpr(right) : { kind: 'none' }
      })
    }
  }
  if (compKind === 'dict' && keyNode && body) {
    dictKey = adaptExpr(keyNode)
    elt = adaptExpr(body)
    return {
      kind: 'comprehension',
      elt: { kind: 'tuple', elts: [dictKey, elt] },
      generators,
      compKind
    }
  }
  elt = body ? adaptExpr(body) : { kind: 'none' }
  return { kind: 'comprehension', elt, generators, compKind }
}

function adaptString(node: TsNode): IrExpr {
  const raw = nodeText(node)
  // f-string：剥离前缀 f/F/rf 等，提取静态段与插值
  const isFString = /^[fFrRbBuU]+['"]/i.test(raw) && /^[fFrF]/i.test(raw)
  if (isFString && (raw.startsWith('f') || raw.startsWith('F') || raw.startsWith('rf') || raw.startsWith('Rf') || raw.startsWith('fr') || raw.startsWith('Fr'))) {
    return adaptFString(raw)
  }
  // 普通/原始/字节字符串：剥离前缀与引号，保留原始文本（对齐旧实现）
  return { kind: 'string', value: stripStringQuotes(raw) }
}

function stripStringQuotes(raw: string): string {
  // 前缀含 f/F（f-string）/r/R/b/B/u/U 任意组合；value 为剥离引号后的原始文本
  const match = /^(?:[fFrRbBuU][fFrRbBuU]?|)?('''|"""|'|")([\s\S]*)\1$/.exec(raw)
  if (!match) return raw
  return match[2] ?? raw
}

function adaptFString(raw: string): IrExpr {
  const body = stripStringQuotes(raw)
  const staticParts: string[] = []
  const interpolations: IrExpr[] = []
  let buf = ''
  let depth = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (ch === '{' && body[i + 1] === '{') {
      buf += '{'
      i += 2
      continue
    }
    if (ch === '}' && body[i + 1] === '}') {
      buf += '}'
      i += 2
      continue
    }
    if (ch === '{') {
      if (depth === 0) {
        staticParts.push(buf)
        buf = ''
      }
      depth += 1
      i += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        // buf 为一个插值的源文本：解析为表达式
        interpolations.push(parseInterpolationText(buf))
        buf = ''
      }
      i += 1
      continue
    }
    buf += ch
    i += 1
  }
  staticParts.push(buf)
  return { kind: 'f_string', staticParts, interpolations }
}

function parseInterpolationText(text: string): IrExpr {
  // 插值文本形如 `expr` / `expr!r` / `expr:spec` / `expr!r:spec`。
  // 用 ScriptParserService.parse 解析为表达式（expression_statement），不可解析时保守视为字符串。
  const trimmed = text.split(':')[0]!.split('!')[0]!.trim()
  const outcome = safeParseExpression(trimmed)
  if (outcome) return outcome
  // 含格式说明中的嵌套插值：保守把整段当 string（内容已在命令文本中可见，不产生隐藏调用）
  return { kind: 'string', value: trimmed }
}

function safeParseExpression(text: string): IrExpr | null {
  // scriptParserService 不依赖本模块，无环；插值表达式复用同一 parse 服务
  const outcome = scriptParserService.parse('python', text)
  if (!outcome.ok) return null
  try {
    const ir = adaptPythonModule(outcome.tree)
    const stmt = ir.body[0]
    if (ir.body.length === 1 && stmt?.kind === 'expr') return stmt.value
    return null
  } finally {
    outcome.tree.delete()
  }
}

function adaptSubscriptIndex(node: TsNode): IrExpr {
  if (node.type === 'slice') return adaptSliceNode(node)
  return adaptExpr(node)
}

function adaptSliceNode(node: TsNode): IrExpr {
  // slice 无 fields：named children 按序为 [lower?, upper?, step?]
  const [lower, upper, step] = namedChildren(node)
  return {
    kind: 'slice',
    lower: lower ? adaptExpr(lower) : null,
    upper: upper ? adaptExpr(upper) : null,
    step: step ? adaptExpr(step) : null
  }
}

function operatorToken(node: TsNode): TsNode | null {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i)
    if (child && !child.isNamed && child.type !== '(' && child.type !== ')') {
      const t = child.type
      if (/^[+\-*/%<>=!&|^~]|and$|or$|not$|in$|is$/.test(t)) return child
    }
  }
  return null
}

function firstNamed(node: TsNode): TsNode | null {
  for (const child of namedChildren(node)) return child
  return null
}

// ---------- 旧实现辅助函数的 IR 版本（P1-T3 平移目标） ----------

/** 旧 foldStringExpr 的 IR 平移：string / binop'+' / 单元素 tuple / 全静态 f-string。 */
export function foldStringIr(expr: IrExpr): string | null {
  if (expr.kind === 'string') return expr.value
  if (expr.kind === 'binop' && expr.op === '+') {
    const left = foldStringIr(expr.left)
    const right = foldStringIr(expr.right)
    if (left !== null && right !== null) return left + right
  }
  if (expr.kind === 'tuple' && expr.elts.length === 1) return foldStringIr(expr.elts[0]!)
  if (expr.kind === 'f_string' && expr.interpolations.length === 0) return expr.staticParts.join('')
  return null
}

export interface IrResolvedChain {
  root: string | null
  module: string | null
  attrs: string[]
  fullName: string | null
}

/** 旧 resolveExprChain 的 IR 平移（别名 / from-import 绑定 / 链穿透语义不变）。 */
export function resolveIrChain(expr: IrExpr, scope: IrScope): IrResolvedChain {
  const attrs: string[] = []
  let root: string | null = null
  let module: string | null = null
  let cur: IrExpr = expr

  if (cur.kind === 'name') {
    root = cur.id
    if (scope.modules.has(cur.id)) {
      module = scope.modules.get(cur.id) ?? null
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
    const base = resolveIrChain(cur.base, scope)
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
    return resolveIrChain(cur.callee, scope)
  }

  return { root: null, module: null, attrs: [], fullName: null }
}

