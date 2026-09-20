# -*- coding: utf-8 -*-
# P1-4：bash command_name 位置的命令替换；P1-5：重定向进程替换；P1-6：extract 异常兜底。
import io

p = 'electron/shell/bashCommandFacts.ts'
s = io.open(p, encoding='utf-8').read()

# ---- P1-6：extract 整体 try/catch ----
old = """export function extractBashCommandFacts(source: string): BashCommandFacts {
  const outcome = scriptParserService.parse('bash', source)
  if (!outcome.ok) return emptyFacts(false)
  try {
    const ctx: Ctx = { substitutions: [], comments: [], unresolved: [] }
    const body: Body = { commands: [], pipelines: [], lists: [], connectorFlow: [] }
    collectComments(outcome.tree.rootNode, ctx)
    walkStatements(outcome.tree.rootNode, ctx, body)
    return {"""
new = """export function extractBashCommandFacts(source: string): BashCommandFacts {
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
  {
    const ctx: Ctx = { substitutions: [], comments: [], unresolved: [] }
    const body: Body = { commands: [], pipelines: [], lists: [], connectorFlow: [] }
    collectComments(tree.rootNode, ctx)
    walkStatements(tree.rootNode, ctx, body)
    return {"""
assert old in s, 'extract try'
s = s.replace(old, new)

old = """      unresolved: ctx.unresolved
    }
  } finally {
    outcome.tree.delete()
  }
}"""
new = """      unresolved: ctx.unresolved
    }
  }
}"""
assert old in s, 'extract finally'
s = s.replace(old, new)

# ---- P1-4：command_name 位置的命令替换（command_name 内 command_substitution / plain word） ----
old = """function adaptCommand(node: TsNode, ctx: Ctx, body: Body): void {
  const nameNode = namedChildren(node).find((c) => c.type === 'command_name')
  const name = nameNode?.text ?? ''
  // 先入列再遍历参数：命令替换内部命令的提取顺序在外层命令之后
  body.commands.push(fact)"""
# anchor mismatch risk — use the actual push-order version
old = """function adaptCommand(node: TsNode, ctx: Ctx, body: Body): void {
  const nameNode = namedChildren(node).find((c) => c.type === 'command_name')
  const name = nameNode?.text ?? ''
  const fact: BashCommandFact = { name, args: [], redirects: [], assignments: [] }
  // 先入列再遍历参数：命令替换内部命令的提取顺序在外层命令之后
  body.commands.push(fact)"""
new = """function adaptCommand(node: TsNode, ctx: Ctx, body: Body): void {
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
  body.commands.push(fact)"""
assert old in s, 'name subst'
s = s.replace(old, new)

# ---- P1-5：file_redirect destination 为进程替换 ----
old = """function adaptFileRedirect(node: TsNode): BashRedirectFact | null {
  const op = anonTexts(node).find((t) => ['<', '>', '>>', '>&', '<&', '&>', '&>>'].includes(t))
  const target = namedChildren(node).find((c) => c.type === 'word' || c.type === 'string' || c.type === 'raw_string' || c.type === 'number')
  return { op: op ?? '>', target: target?.text ?? '' }
}"""
new = """function adaptFileRedirect(node: TsNode): BashRedirectFact | null {
  const op = anonTexts(node).find((t) => ['<', '>', '>>', '>&', '<&', '&>', '&>>'].includes(t))
  const target = namedChildren(node).find((c) => c.type === 'word' || c.type === 'string' || c.type === 'raw_string' || c.type === 'number')
  return { op: op ?? '>', target: target?.text ?? '' }
}

/** 重定向 destination 为进程替换（`> >(nc …)` / `< <(curl …)`）：记录替换事实并提取内部命令。 */
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
}"""
assert old in s, 'proc subst helper'
s = s.replace(old, new)

# adaptStatement 的 redirected_statement 分支接上进程替换处理
old = """      const before = body.commands.length
      if (statementBody) adaptStatement(statementBody, ctx, body)
      if (body.commands.length > before && redirects.length > 0) {
        body.commands[body.commands.length - 1]!.redirects.push(...redirects)
      }
      break"""
new = """      const before = body.commands.length
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
      break"""
assert old in s, 'redirect hook'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('bash facts ok')
