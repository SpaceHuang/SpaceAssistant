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
  substitutions: BashSubstitutionFact[]
  comments: string[]
  unresolved: string[]
}

function emptyFacts(ok: boolean, unresolved: string[] = []): BashCommandFacts {
  return { ok, commands: [], pipelines: [], lists: [], substitutions: [], comments: [], unresolved }
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
    const ctx: Ctx = { substitutions: [], comments: [], unresolved: [] }
    const body = adaptProgram(outcome.tree.rootNode, ctx)
    return {
      ok: true,
      commands: body.commands,
      pipelines: body.pipelines,
      lists: body.lists,
      substitutions: ctx.substitutions,
      comments: ctx.comments,
      unresolved: ctx.unresolved
    }
  } finally {
    outcome.tree.delete()
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
}

function adaptProgram(root: TsNode, ctx: Ctx): Body {
  const body: Body = { commands: [], pipelines: [], lists: [] }
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
  for (const child of namedChildren(node)) {
    switch (child.type) {
      case 'pipeline': {
        const segments: BashCommandFact[] = []
        const wasNegated = anonTexts(child).includes('!')
        for (const seg of namedChildren(child)) {
          if (seg.type === 'command' || seg.type === 'redirected_statement') {
            const before = body.commands.length
            adaptStatement(seg, ctx, body)
            segments.push(...body.commands.slice(before))
          } else {
            ctx.unresolved.push(`${seg.type}:${seg.text.slice(0, 60)}`)
          }
        }
        if (wasNegated) ctx.unresolved.push('pipeline-negation:!')
        if (segments.length > 1) body.pipelines.push({ segments })
        break
      }
      case 'list': {
        // && / || 序列（left-assoc 可嵌套 list）：named 子节点为 statement / 内层 list
        for (const seg of namedChildren(child)) {
          if (seg.type === 'command' || seg.type === 'redirected_statement' || seg.type === 'pipeline' || seg.type === 'list') {
            adaptStatement(seg, ctx, body)
          }
        }
        for (const op of anonTexts(child)) {
          if (op === '&&' || op === '||') body.lists.push(op)
        }
        break
      }
      case 'command':
      case 'redirected_statement':
        adaptStatement(child, ctx, body)
        break
      case 'variable_assignment':
        adaptStatement(child, ctx, body)
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
      walkStatements(node, ctx, body)
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

function adaptCommand(node: TsNode, ctx: Ctx, body: Body): void {
  const nameNode = namedChildren(node).find((c) => c.type === 'command_name')
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
