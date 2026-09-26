import { parseShellSegments, tokenizeSimpleCommand } from './shellCommandParser'
import type { ShellDialect } from './shellProfiles'
import { extractBashCommandFacts, type BashCommandFacts } from './bashCommandFacts'
import { extractPowershellCommandFacts, type PsCommandFacts } from './powershellCommandFacts'

export type ShellAnalysisCompleteness = 'complete' | 'partial'

export interface ShellOperation {
  readonly verb: string
  readonly args: readonly string[]
  readonly segmentIndex: number
}

export interface ShellFactAnalysis {
  readonly dialect: ShellDialect
  readonly operations: readonly ShellOperation[]
  readonly connectors: readonly string[]
  readonly paths: readonly string[]
  readonly redirects: readonly string[]
  readonly cwdChanges: readonly string[]
  readonly analysisCompleteness: ShellAnalysisCompleteness
  readonly unresolved: readonly string[]
}

/**
 * 只提取 Shell 事实，不进行 allow/deny/confirm 裁决。
 * 策略层必须消费此结果后独立决策，避免 parser 通过 verdict 反向控制授权。
 */
export function analyzeShellFacts(
  command: string,
  dialect: ShellDialect,
  preParsedTreeFacts?: BashCommandFacts | PsCommandFacts
): ShellFactAnalysis {
  // P2-T2（发现 B/E/H）+ P3-T5：dialect 入口分叉——语法级树事实产出 ShellFactAnalysis。
  // preParsedTreeFacts 供 analyzeShellCommand 单次解析共享（恰好 1 次解析）。
  if (dialect === 'posix-bash') {
    const treeFacts = preParsedTreeFacts ?? extractBashCommandFacts(command)
    return treeFactsToAnalysis(dialect, treeFacts)
  }
  if (dialect === 'windows-powershell') {
    const treeFacts = preParsedTreeFacts ?? extractPowershellCommandFacts(command)
    return treeFactsToAnalysis(dialect, treeFacts)
  }
  const unresolved: string[] = []
  const analysisCommand = stripComments(command).replace(/[\r\n]+/g, ';')
  let segments: string[]
  try {
    segments = parseShellSegments(analysisCommand)
  } catch (error) {
    return {
      dialect, operations: [], connectors: [], paths: [], redirects: [], cwdChanges: [],
      analysisCompleteness: 'partial',
      unresolved: [error instanceof Error ? error.message : String(error)]
    }
  }

  const operations: ShellOperation[] = []
  const paths: string[] = []
  const redirects: string[] = []
  const cwdChanges: string[] = []
  for (const [segmentIndex, segment] of segments.entries()) {
    const tokens = tokenizeSimpleCommand(segment)
    if (!tokens?.[0]) {
      unresolved.push(`segment:${segmentIndex}:unparseable`)
      continue
    }
    const verb = tokens[0]
    const args = tokens.slice(1)
    operations.push({ verb, args, segmentIndex })
    for (const arg of args) {
      if (/[\\/]|^[A-Za-z]:/.test(arg)) paths.push(arg)
    }
    if (verb.toLowerCase() === 'cd' && args[0]) cwdChanges.push(args[0])
    if (/[`$][({]/.test(segment) || /[<>]/.test(segment) || /[()]/.test(segment)) {
      unresolved.push(`segment:${segmentIndex}:shell-control-flow`)
    }
  }

  const connectors = extractConnectors(analysisCommand)
  return {
    dialect, operations, connectors, paths, redirects, cwdChanges,
    analysisCompleteness: unresolved.length ? 'partial' : 'complete',
    unresolved
  }
}

/** bash/PS 树事实 → ShellFactAnalysis 统一投影（commands 结构同构；cwd 动词按 dialect 匹配）。 */
function treeFactsToAnalysis(dialect: ShellDialect, f: BashCommandFacts | PsCommandFacts): ShellFactAnalysis {
  if (!f.ok) {
    return {
      dialect, operations: [], connectors: [], paths: [], redirects: [], cwdChanges: [],
      analysisCompleteness: 'partial',
      unresolved: ['parse:tree-error']
    }
  }
  const operations: ShellOperation[] = []
  const paths: string[] = []
  const redirects: string[] = []
  const cwdChanges: string[] = []
  const stripQuotes = (t: string) => t.replace(/^["']+|["']+$/g, '')
  const cwdVerbs = dialect === 'windows-powershell' ? ['cd', 'set-location', 'sl'] : ['cd']
  for (const [index, cmd] of f.commands.entries()) {
    if (!cmd.name) continue
    operations.push({ verb: cmd.name, args: cmd.args, segmentIndex: index })
    for (const arg of cmd.args) {
      const bare = stripQuotes(arg)
      if (/[\/]|^[A-Za-z]:/.test(bare)) paths.push(bare)
    }
    for (const r of cmd.redirects) {
      const target = stripQuotes(r.target)
      if (target) redirects.push(target)
    }
    if (cwdVerbs.includes(cmd.name.toLowerCase()) && cmd.args[0]) cwdChanges.push(stripQuotes(cmd.args[0]))
  }
  return {
    dialect,
    operations,
    connectors: f.connectorFlow,
    paths,
    redirects,
    cwdChanges,
    analysisCompleteness: f.unresolved.length === 0 ? 'complete' : 'partial',
    unresolved: f.unresolved
  }
}

function stripComments(command: string): string {
  let output = ''
  let quote: '\'' | '"' | null = null
  let escaped = false
  let comment = false
  for (const ch of command) {
    if (comment) {
      if (ch === '\n' || ch === '\r') {
        comment = false
        output += ch
      }
      continue
    }
    if (escaped) {
      escaped = false
      output += ch
      continue
    }
    if (ch === '\\' && quote !== '\'') {
      escaped = true
      output += ch
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      output += ch
      continue
    }
    if (ch === '\'' || ch === '"') {
      quote = ch
      output += ch
    } else if (ch === '#') {
      comment = true
      output += ' '
    } else {
      output += ch
    }
  }
  return output
}

function extractConnectors(command: string): string[] {
  const connectors: string[] = []
  let quote: '\'' | '"' | null = null
  let escaped = false
  let comment = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (comment) {
      if (ch === '\n' || ch === '\r') comment = false
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== '\'') {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\'' || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '#') {
      comment = true
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      connectors.push(pair)
      i++
    } else if (ch === '|' || ch === ';') {
      connectors.push(ch)
    }
  }
  return connectors
}
