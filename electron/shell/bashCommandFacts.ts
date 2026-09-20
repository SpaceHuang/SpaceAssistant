// P2-T1：tree-sitter-bash 语法树 → 结构化命令事实。
// 全量覆盖精神（§3 不变量 7）：对未建模的结构性构造不静默丢弃——显式进入 unresolved，
// 供上层按既有 fail-closed 语义处理；解析失败/ERROR 节点 → { ok:false }（fail-closed）。
import { scriptParserService } from './scriptParserService'
import type { TsNode } from './scriptIr/types'

export interface BashRedirectFact {
  op: string
  target: string
}

export interface BashCommandFact {
  name: string
  args: string[]
  redirects: BashRedirectFact[]
  assignments: string[]
}

export interface BashPipelineFact {
  segments: BashCommandFact[]
}

export interface BashSubstitutionFact {
  kind: 'command' | 'process' | 'arithmetic' | 'variable'
  inner: string
}

export interface BashCommandFacts {
  ok: boolean
  commands: BashCommandFact[]
  pipelines: BashPipelineFact[]
  lists: string[]
  /** 按原文出现顺序的连接词流（'|'、'&&'、'||'、';'） */
  connectorFlow: string[]
  substitutions: BashSubstitutionFact[]
  comments: string[]
  unresolved: string[]
}

function emptyFacts(ok: boolean, unresolved: string[] = []): BashCommandFacts {
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

export function extractBashCommandFacts(source: string): BashCommandFacts {
  const outcome = scriptParserService.parse('bash', source)
  if (!outcome.ok) return emptyFacts(false)
  try {
    return adaptBashTree(outcome.tree)
  } catch {
    // P1-6 评审修复：TS 侧递归 walker 深嵌套（RangeError 等）→ ok:false（fail-closed），
    // 禁止异常穿透门控打掉整轮工具循环。
    return emptyFacts(false, ['extract:internal-error'])
  } finally {
    outcome.tree.delete()
  }
}

function adaptBashTree(tree: import('./scriptIr/types').TsTree): BashCommandFacts {
  const ctx: Ctx = { substitutions: [], comments: [], unresolved: [] }
  const body = adaptProgram(tree.rootNode, ctx)
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

interface Ctx {
  substitutions: BashSubstitutionFact[]
  comments: string[]
  unresolved: string[]
}

interface Body {
  commands: BashCommandFact[]
  pipelines: BashPipelineFact[]
  lists: string[]
  /** 按原文出现顺序的连接词流（'|'、'&&'、'||'、';'）——facts.connectors 投影源 */
  connectorFlow: string[]
}

function isStatementLike(node: TsNode): boolean {
  return ['pipeline', 'list', 'command', 'redirected_statement', 'variable_assignment', 'subshell', 'function_definition', 'for_clause', 'while_clause', 'until_clause', 'case_clause'].includes(node.type)
}

function adaptProgram(root: TsNode, ctx: Ctx): Body {
  const body: Body = { commands: [], pipelines: [], lists: [], connectorFlow: [] }
  collectComments(root, ctx)
  walkStatements(root, ctx, body)
  return body
}

function collectComments(node: TsNode, ctx: Ctx): void {
  if (node.type === 'comment') {
    ctx.comments.push(node.text)
  }
  for (const child of namedChildren(node)) collectComments(child, ctx)
}

/** 语句序列遍历：pipeline / list / 单命令 / 重定向语句；未识别类型进 unresolved。 */
function walkStatements(node: TsNode, ctx: Ctx, body: Body): void {
  // program/subshell 的多个子语句 = 换行或 ';' 分隔：语句间产出 ';'（对齐旧实现换行归一化）
  const isStatementSequence = node.type === 'program' || node.type === 'subshell'
  let seenStatement = false
  for (const child of namedChildren(node)) {
    if (isStatementSequence && isStatementLike(child)) {
      if (seenStatement) body.connectorFlow.push(';')
      seenStatement = true
    }
    switch (child.type) {
      case 'pipeline':
        adaptPipelineStatement(child, ctx, body)
        break
      case 'list':
        adaptListStatement(child, ctx, body)
        break
      case 'command':
      case 'redirected_statement':
        adaptStatement(child, ctx, body)
        break
      case 'variable_assignment':
        adaptStatement(child, ctx, body)
        break
      case 'comment':
        break
      case 'subshell':
        // 子壳分组：内部语句递归提取；子壳本身记入 unresolved（保守 partial，维持分组边界可见）
        ctx.unresolved.push(`subshell:${child.text.slice(0, 40)}`)
        walkStatements(child, ctx, body)
        break
      default:
        ctx.unresolved.push(`${child.type}:${child.text.slice(0, 60)}`)
    }
  }
}

function adaptStatement(node: TsNode, ctx: Ctx, body: Body): void {
  switch (node.type) {
    case 'redirected_statement': {
      // 结构：语句体 + file_redirect/heredoc_redirect 后缀
      const redirects: BashRedirectFact[] = []
      let statementBody: TsNode | null = null
      for (const child of namedChildren(node)) {
        if (child.type === 'file_redirect') {
          const r = adaptFileRedirect(child)
          if (r) redirects.push(r)
        } else if (child.type === 'heredoc_redirect') {
          // heredoc：操作符 + tag +（可选）内嵌 file_redirect；body 文本不参与命令事实
          const op = anonTexts(child).find((t) => ['<<', '<<-', '<<<'].includes(t))
          const start = namedChildren(child).find((c) => c.type === 'heredoc_start')
          redirects.push({ op: op ?? '<<', target: start?.text ?? '' })
          for (const sub of namedChildren(child)) {
            if (sub.type === 'file_redirect') {
              const r = adaptFileRedirect(sub)
              if (r) redirects.push(r)
            }
          }
        } else {
          statementBody = child
        }
      }
      const before = body.commands.length
      if (statementBody) adaptStatement(statementBody, ctx, body)
      // P1-5 评审修复：destination 为进程替换/命令替换时，替换事实 + 内部命令必须提取
      for (const child of namedChildren(node)) {
        if (child.type === 'file_redirect' || child.type === 'heredoc_redirect') {
          if (adaptRedirectProcessSubstitution(child, ctx, body)) {
            const op = anonTexts(child).find((t) => ['<', '>', '>>', '>&', '<&', '&>', '&>>', '<<', '<<-', '<<<'].includes(t))
            if (body.commands.length > before) {
              body.commands[body.commands.length - 1]!.redirects.push({ op: op ?? '>', target: child.text.slice(0, 60) })
            }
          }
        }
      }
      if (body.commands.length > before && redirects.length > 0) {
        body.commands[body.commands.length - 1]!.redirects.push(...redirects)
      }
      break
    }
    case 'command':
      adaptCommand(node, ctx, body)
      break
    case 'variable_assignment': {
      const fact: BashCommandFact = { name: '', args: [], redirects: [], assignments: [node.text.replace(/\s+/g, '')] }
      body.commands.push(fact)
      const value = namedChildren(node).find((c) => c.type !== 'variable_name')
      if (value) collectSubstitutions(value, ctx, body)
      break
    }
    case 'pipeline':
      adaptPipelineStatement(node, ctx, body)
      break
    case 'list': {
      // list 自身的连接词在 anon 子节点上：adaptStatement 直达时也需收集
      for (const seg of namedChildren(node)) {
        if (seg.type === 'command' || seg.type === 'redirected_statement' || seg.type === 'pipeline' || seg.type === 'list') {
          adaptStatement(seg, ctx, body)
        }
      }
      for (const op of anonTexts(node)) {
        if (op === '&&' || op === '||') body.lists.push(op)
      }
      break
    }

    default:
      ctx.unresolved.push(`${node.type}:${node.text.slice(0, 60)}`)
  }
}

/** list：子节点为 [statement, anon 连接词, statement...] 交错（left-assoc 可嵌套），按树位置顺序产出连接词。 */
function adaptListStatement(node: TsNode, ctx: Ctx, body: Body): void {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i)
    if (!child) continue
    if (!child.isNamed) {
      if (child.type === '&&' || child.type === '||' || child.type === ';') {
        body.lists.push(child.type)
        body.connectorFlow.push(child.type)
      }
      continue
    }
    if (child.type === 'command' || child.type === 'redirected_statement' || child.type === 'pipeline' || child.type === 'list') {
      adaptStatement(child, ctx, body)
    }
  }
}

function adaptPipelineStatement(node: TsNode, ctx: Ctx, body: Body): void {
  const segments: BashCommandFact[] = []
  const wasNegated = anonTexts(node).includes('!')
  for (const seg of namedChildren(node)) {
    if (seg.type === 'command' || seg.type === 'redirected_statement') {
      const before = body.commands.length
      adaptStatement(seg, ctx, body)
      segments.push(...body.commands.slice(before))
    } else {
      ctx.unresolved.push(`${seg.type}:${seg.text.slice(0, 60)}`)
    }
  }
  if (wasNegated) ctx.unresolved.push('pipeline-negation:!')
  if (segments.length > 1) {
    body.pipelines.push({ segments })
    for (let i = 0; i < segments.length - 1; i += 1) body.connectorFlow.push('|')
  }
}

function adaptCommand(node: TsNode, ctx: Ctx, body: Body): void {
  const nameNode = namedChildren(node).find((c) => c.type === 'command_name')
  // P1-4 评审修复：命令名位置也可能是命令替换（`$(curl …) args` 形态）——必须提取事实，
  // 禁止静默丢弃（name 取替换文本原文，内部命令照常进 facts.commands）
  if (nameNode) {
    const nameSubst = namedChildren(nameNode).find(
      (c) => c.type === 'command_substitution' || c.type === 'simple_expansion'
    )
    if (nameSubst) {
      collectSubstitutions(nameSubst, ctx, body)
      if (nameSubst.type === 'command_substitution') {
        for (const inner of namedChildren(nameSubst)) {
          if (inner.type === 'command') adaptCommand(inner, ctx, body)
        }
      }
    }
  }
  const name = nameNode?.text ?? ''
  const fact: BashCommandFact = { name, args: [], redirects: [], assignments: [] }
  // 先入列再遍历参数：命令替换内部命令的提取顺序在外层命令之后
  body.commands.push(fact)
  for (const child of namedChildren(node)) {
    if (child.type === 'command_name') continue
    if (child.type === 'word' || child.type === 'string' || child.type === 'raw_string' || child.type === 'number') {
      fact.args.push(child.text)
      collectSubstitutions(child, ctx, body)
      continue
    }
    if (child.type === 'variable_assignment') {
      fact.assignments.push(child.text.replace(/\s+/g, ''))
      continue
    }
    if (child.type === 'file_redirect') {
      const r = adaptFileRedirect(child)
      if (r) fact.redirects.push(r)
      continue
    }
    if (
      child.type === 'command_substitution' ||
      child.type === 'process_substitution' ||
      child.type === 'arithmetic_expansion' ||
      child.type === 'simple_expansion' ||
      child.type === 'concatenation'
    ) {
      fact.args.push(child.text)
      collectSubstitutions(child, ctx, body)
      continue
    }
    ctx.unresolved.push(`${child.type}:${child.text.slice(0, 60)}`)
  }
}

function adaptFileRedirect(node: TsNode): BashRedirectFact | null {
  const op = anonTexts(node).find((t) => ['<', '>', '>>', '>&', '<&', '&>', '&>>'].includes(t))
  const target = namedChildren(node).find((c) => c.type === 'word' || c.type === 'string' || c.type === 'raw_string' || c.type === 'number')
  return { op: op ?? '>', target: target?.text ?? '' }
}

/** 重定向 destination 为进程/命令替换（`> >(nc …)` / `< <(curl …)`）：记录替换事实并提取内部命令。 */
function adaptRedirectProcessSubstitution(node: TsNode, ctx: Ctx, body: Body): boolean {
  for (const child of namedChildren(node)) {
    if (child.type === 'process_substitution') {
      const inner = child.text.replace(/^\$?[<>]\(/, '').replace(/\)$/, '')
      ctx.substitutions.push({ kind: 'process', inner })
      for (const innerChild of namedChildren(child)) {
        if (innerChild.type === 'command') adaptCommand(innerChild, ctx, body)
        else collectSubstitutions(innerChild, ctx, body)
      }
      return true
    }
    if (child.type === 'command_substitution') {
      ctx.substitutions.push({ kind: 'command', inner: child.text })
      for (const innerChild of namedChildren(child)) {
        if (innerChild.type === 'command') adaptCommand(innerChild, ctx, body)
      }
      return true
    }
  }
  return false
}

function collectSubstitutions(node: TsNode, ctx: Ctx, body: Body): void {
  switch (node.type) {
    case 'command_substitution': {
      const inner = node.text.replace(/^\$\(/, '').replace(/\)$/, '')
      ctx.substitutions.push({ kind: 'command', inner })
      for (const child of namedChildren(node)) {
        if (child.type === 'command') adaptCommand(child, ctx, body)
        else collectSubstitutions(child, ctx, body)
      }
      break
    }
    case 'process_substitution':
      ctx.substitutions.push({ kind: 'process', inner: node.text.replace(/^\$?[<>]\(/, '').replace(/\)$/, '') })
      for (const child of namedChildren(node)) collectSubstitutions(child, ctx, body)
      break
    case 'arithmetic_expansion':
      ctx.substitutions.push({ kind: 'arithmetic', inner: node.text.replace(/^\$\(\(/, '').replace(/\)\)$/, '') })
      for (const child of namedChildren(node)) collectSubstitutions(child, ctx, body)
      break
    case 'simple_expansion':
      ctx.substitutions.push({ kind: 'variable', inner: node.text })
      break
    case 'string':
    case 'concatenation':
      for (const child of namedChildren(node)) collectSubstitutions(child, ctx, body)
      break
    default:
      break
  }
}
