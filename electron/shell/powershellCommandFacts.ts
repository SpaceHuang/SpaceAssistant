// P3-T2：tree-sitter-powershell 语法树 → 结构化命令事实（对位 bashCommandFacts）。
// 全量覆盖精神（§3 不变量 7）：未识别结构显式进入 unresolved（不静默丢弃）；
// 解析失败 / ERROR 节点 → { ok:false }（fail-closed，上层 ask 兜底）。
import { scriptParserService } from './scriptParserService'
import type { TsNode } from './scriptIr/types'

export interface PsRedirectFact {
  op: string
  target: string
}

export interface PsCommandFact {
  name: string
  args: string[]
  redirects: PsRedirectFact[]
  assignments: string[]
}

export interface PsPipelineFact {
  segments: PsCommandFact[]
}

export interface PsSubstitutionFact {
  kind: 'sub-expression' | 'variable' | 'script-block'
  inner: string
}

export interface PsCommandFacts {
  ok: boolean
  commands: PsCommandFact[]
  pipelines: PsPipelineFact[]
  lists: string[]
  /** 按原文出现顺序的连接词流（'|'、'&&'、'||'、';'） */
  connectorFlow: string[]
  substitutions: PsSubstitutionFact[]
  comments: string[]
  unresolved: string[]
}

function emptyFacts(ok: boolean, unresolved: string[] = []): PsCommandFacts {
  return { ok, commands: [], pipelines: [], lists: [], connectorFlow: [], substitutions: [], comments: [], unresolved }
}

function namedChildren(node: TsNode): TsNode[] {
  const out: TsNode[] = []
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i)
    if (child?.isNamed) out.push(child)
  }
  return out
}

function anonTexts(node: TsNode): string[] {
  const out: string[] = []
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i)
    if (child && !child.isNamed) out.push(child.type)
  }
  return out
}

interface Ctx {
  substitutions: PsSubstitutionFact[]
  comments: string[]
  unresolved: string[]
}

interface Body {
  commands: PsCommandFact[]
  pipelines: PsPipelineFact[]
  lists: string[]
  connectorFlow: string[]
}

export function extractPowershellCommandFacts(source: string): PsCommandFacts {
  const outcome = scriptParserService.parse('powershell', source)
  if (!outcome.ok) return emptyFacts(false)
  try {
    return adaptPowershellTree(outcome.tree)
  } catch {
    // P1-6 评审修复：TS 侧递归 walker 深嵌套（RangeError 等）→ ok:false（fail-closed），
    // 禁止异常穿透门控打掉整轮工具循环。
    return emptyFacts(false, ['extract:internal-error'])
  } finally {
    outcome.tree.delete()
  }
}

function adaptPowershellTree(tree: import('./scriptIr/types').TsTree): PsCommandFacts {
  {
    const ctx: Ctx = { substitutions: [], comments: [], unresolved: [] }
    const body: Body = { commands: [], pipelines: [], lists: [], connectorFlow: [] }
    collectComments(tree.rootNode, ctx)
    walkStatementList(tree.rootNode, ctx, body)
    return {
      ok: true,
      commands: body.commands,
      pipelines: body.pipelines,
      lists: body.lists,
      connectorFlow: body.connectorFlow,
      substitutions: ctx.substitutions,
      comments: ctx.comments,
      unresolved: ctx.unresolved
    }
  }
}

function collectComments(node: TsNode, ctx: Ctx): void {
  if (node.type === 'comment') ctx.comments.push(node.text)
  for (const child of namedChildren(node)) collectComments(child, ctx)
}

function walkStatementList(node: TsNode, ctx: Ctx, body: Body): void {
  // 换行分隔的语句间产出 ';'（对齐旧实现换行归一化语义）
  let seenStatement = false
  for (const child of namedChildren(node)) {
    const isStatement = child.type === 'pipeline' || child.type === 'statement_list'
    if (isStatement) {
      if (seenStatement) body.connectorFlow.push(';')
      seenStatement = true
    }
    switch (child.type) {
      case 'statement_list':
        walkStatementList(child, ctx, body)
        break
      case 'pipeline':
        adaptPipeline(child, ctx, body)
        break
      case 'empty_statement':
        body.connectorFlow.push(';')
        body.lists.push(';')
        break
      case 'comment':
        break
      default:
        // 赋值/语句级构造：提取其中的命令与替换，语句本体保守入 unresolved
        ctx.unresolved.push(`${child.type}:${child.text.slice(0, 40)}`)
        collectSubstitutions(child, ctx, body)
        collectCommandNames(child, ctx, body)
    }
  }
}

function adaptPipeline(node: TsNode, ctx: Ctx, body: Body): void {
  const segments: PsCommandFact[] = []
  // 按树位置顺序：pipeline_chain 内的 '|' 匿名子节点 + pipeline_chain_tail 的 '&&'/'||'
  for (const child of namedChildren(node)) {
    if (child.type === 'pipeline_chain') {
      const before = body.commands.length
      for (let i = 0; i < child.childCount; i += 1) {
        const seg = child.child(i)
        if (!seg) continue
        if (seg.isNamed && seg.type === 'command') {
          adaptCommand(seg, ctx, body)
          segments.push(...body.commands.slice(before))
        } else if (!seg.isNamed && seg.type === '|') {
          body.connectorFlow.push('|')
        } else if (seg.isNamed) {
          // 非命令语句（赋值/语句级构造）：显式 unresolved（不静默丢弃）
          ctx.unresolved.push(`${seg.type}:${seg.text.slice(0, 40)}`)
          collectSubstitutions(seg, ctx, body)
        }
      }
    } else if (child.type === 'pipeline_chain_tail') {
      for (const op of anonTexts(child)) {
        if (op === '&&' || op === '||') {
          body.lists.push(op)
          body.connectorFlow.push(op)
        }
      }
    } else if (child.type !== 'pipeline_chain') {
      // 非管道链语句（赋值/语句级构造）：显式 unresolved（不静默丢弃）；
      // P1-3 评审修复：RHS 内的真实命令仍提取进 facts.commands
      ctx.unresolved.push(`${child.type}:${child.text.slice(0, 40)}`)
      collectCommandNames(child, ctx, body)
      collectSubstitutions(child, ctx, body)
    }
  }
  if (segments.length > 1) body.pipelines.push({ segments })
}

function adaptCommand(node: TsNode, ctx: Ctx, body: Body): void {
  const nameNode = namedChildren(node).find((c) => c.type === 'command_name')
  let name = nameNode?.text ?? ''
  // P1-2 评审修复：& "exe" / . .\pwn.ps1 的命令名是 command 顶层节点 command_name_expr
  //（调用操作符 & / 点源 . 之后无 command_name 包裹）——提取其文本作为命令事实；
  // 含 script_block 时（& { ... }）内部语句递归提取；无法确定 name 时整条进 unresolved。
  if (!name) {
    const nameExpr = namedChildren(node).find((c) => c.type === 'command_name_expr')
    if (nameExpr) {
      const inner = namedChildren(nameExpr)[0]
      if (inner?.type === 'script_block_expression') {
        walkStatementList(inner, ctx, body)
      }
      name = nameExpr.text.trim()
      if (!name) {
        ctx.unresolved.push(`command_name_expr:${node.text.slice(0, 40)}`)
        return
      }
    }
  }
  const fact: PsCommandFact = { name, args: [], redirects: [], assignments: [] }
  body.commands.push(fact)
  const elements = namedChildren(node).find((c) => c.type === 'command_elements')
  if (!elements) return
  for (const el of namedChildren(elements)) {
    switch (el.type) {
      case 'command_argument_sep':
        break
      case 'command_parameter':
        fact.args.push(el.text)
        break
      case 'generic_token':
      case 'string':
      case 'number':
        fact.args.push(el.text)
        collectSubstitutions(el, ctx, body)
        break
      case 'redirection': {
        const r = adaptRedirection(el)
        if (r) fact.redirects.push(r)
        break
      }
      case 'array_literal_expression':
      case 'member_access':
      case 'unary_expression':
        fact.args.push(el.text)
        collectSubstitutions(el, ctx, body)
        break
      default:
        fact.args.push(el.text)
        ctx.unresolved.push(`${el.type}:${el.text.slice(0, 40)}`)
    }
  }
}

function adaptRedirection(node: TsNode): PsRedirectFact | null {
  const opNode = namedChildren(node).find((c) => c.type === 'file_redirection_operator')
  const op = opNode ? anonTexts(opNode).join('') || opNode.text : '>'
  const targetNode = namedChildren(node).find((c) => c.type === 'redirected_file_name')
  const target = targetNode ? targetNode.text.trim() : ''
  return { op, target }
}

function collectSubstitutions(node: TsNode, ctx: Ctx, body: Body): void {
  switch (node.type) {
    case 'sub_expression':
    case 'parenthesized_expression': {
      if (node.type === 'sub_expression' || node.text.startsWith('$(')) {
        ctx.substitutions.push({ kind: 'sub-expression', inner: node.text })
      }
      // P1-3 评审修复：子表达式内部的真实命令必须进 facts.commands（matchPsDangerousPatterns 只遍历 commands）
      for (const child of namedChildren(node)) {
        if (child.type === 'statement_list' || child.type === 'pipeline') {
          walkStatementList(child, ctx, body)
        } else {
          collectSubstitutions(child, ctx, body)
        }
      }
      break
    }
    case 'variable':
      ctx.substitutions.push({ kind: 'variable', inner: node.text })
      break
    case 'script_block_expression':
      ctx.substitutions.push({ kind: 'script-block', inner: node.text })
      // 脚本块内部命令（& { ... } / { Remove-Item ... }）同样进 facts
      for (const child of namedChildren(node)) {
        if (child.type === 'statement_list' || child.type === 'pipeline') {
          walkStatementList(child.type === 'statement_list' ? child : child, ctx, body)
        } else collectSubstitutions(child, ctx, body)
      }
      break
    default:
      for (const child of namedChildren(node)) collectSubstitutions(child, ctx, body)
  }
}

/** 语句级构造（赋值等）中的命令名提取（如 $a = Get-Date 中的 Get-Date）。 */
function collectCommandNames(node: TsNode, ctx: Ctx, body: Body): void {
  for (const child of namedChildren(node)) {
    if (child.type === 'command') {
      adaptCommand(child, ctx, body)
    } else {
      collectCommandNames(child, ctx, body)
    }
  }
}
