import { parseShellSegments, tokenizeSimpleCommand } from './shellCommandParser'
import type { ShellDialect } from './shellProfiles'

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
  readonly cwdChanges: readonly string[]
  readonly analysisCompleteness: ShellAnalysisCompleteness
  readonly unresolved: readonly string[]
}

/**
 * 只提取 Shell 事实，不进行 allow/deny/confirm 裁决。
 * 策略层必须消费此结果后独立决策，避免 parser 通过 verdict 反向控制授权。
 */
export function analyzeShellFacts(command: string, dialect: ShellDialect): ShellFactAnalysis {
  const unresolved: string[] = []
  const analysisCommand = stripComments(command).replace(/[\r\n]+/g, ';')
  let segments: string[]
  try {
    segments = parseShellSegments(analysisCommand)
  } catch (error) {
    return {
      dialect, operations: [], connectors: [], paths: [], cwdChanges: [],
      analysisCompleteness: 'partial',
      unresolved: [error instanceof Error ? error.message : String(error)]
    }
  }

  const operations: ShellOperation[] = []
  const paths: string[] = []
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
    dialect, operations, connectors, paths, cwdChanges,
    analysisCompleteness: unresolved.length ? 'partial' : 'complete',
    unresolved
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
