import type { ShellAnalysisResult } from '../../shell/shellTypes'

const READ_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'fd', 'sed', 'date', 'pwd', 'whoami', 'which', 'file', 'stat', 'du', 'df', 'echo', 'printf', 'sort', 'uniq', 'comm', 'diff', 'tree', 'get-childitem', 'gci', 'dir'])

/** 保守地把单次 Shell Analyzer 结果映射为命令效果；证据不完整时永不产生 read-only。 */
export function classifyShellCommandEffect(_command: string, analysis: ShellAnalysisResult): 'read-only' | 'mutating' | 'unknown' {
  const facts = analysis.facts
  if (analysis.verdict === 'deny') return 'unknown'
  if (!facts || facts.analysisCompleteness !== 'complete' || facts.operations.length === 0 || facts.unresolved.length > 0) return 'unknown'
  if (facts.connectors.some((connector) => !['&&', '||', ';', '|'].includes(connector))) return 'unknown'
  if ((facts.redirects?.length ?? 0) > 0) return 'unknown'
  let sawMutation = false
  for (const operation of facts.operations) {
    const verb = operation.verb.toLowerCase().split(/[\\/]/).pop() ?? operation.verb.toLowerCase()
    const args = operation.args.map((arg) => arg.replace(/^['"]|['"]$/g, ''))
    if (verb === 'git') {
      const subcommand = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
      if (!subcommand) return 'unknown'
      if (!['log', 'status', 'diff', 'show', 'ls-files'].includes(subcommand)) sawMutation = true
      if (args.some((arg) => arg === '-o' || arg === '--output' || arg.startsWith('--output='))) return 'unknown'
      continue
    }
    if (!READ_COMMANDS.has(verb)) { sawMutation = true; continue }
    if ((verb === 'sed' && args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg === '--in-place' || arg.startsWith('--in-place='))) ||
        (verb === 'sort' && args.some((arg) => arg === '-o' || arg === '--output' || arg.startsWith('--output='))) ||
        (verb === 'find' && args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg)))) return 'unknown'
  }
  return sawMutation ? 'mutating' : 'read-only'
}
