/**
 * 检测 run_shell 中不适合 in-app 管道 + 只读 xterm 的交互式 / 全屏 TUI 命令。
 * 与 shell-output-terminal-enhancement-requirement §9.1 一致：引导用户在外部终端执行。
 */

const TUI_PROGRAMS = new Set(['less', 'more', 'top', 'htop', 'vim', 'vi', 'nano', 'emacs'])
import type { ShellTuiMatch, ShellTuiUndetectableReason } from './shellTuiContract'
export type ShellTuiVerdict = { kind: 'match'; program: string; rule: ShellTuiMatch['rule'] } | { kind: 'clear' } | { kind: 'undetectable'; reason: ShellTuiUndetectableReason }

function shellWords(source: string): string[] | null {
  const words: string[] = []
  let word = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  for (const ch of source.trim()) {
    if (escaped) { word += ch; escaped = false; continue }
    if (ch === '\\' && quote !== 'single') { escaped = true; continue }
    if (quote === 'single') { if (ch === "'") quote = null; else word += ch; continue }
    if (quote === 'double') { if (ch === '"') quote = null; else word += ch; continue }
    if (ch === "'") { quote = 'single'; continue }
    if (ch === '"') { quote = 'double'; continue }
    if (/\s/.test(ch)) { if (word) { words.push(word); word = '' }; continue }
    word += ch
  }
  if (escaped || quote) return null
  if (word) words.push(word)
  return words
}

function unwrapWrapper(words: string[]): { words: string[] | null; wrapped: boolean } {
  if (words.length === 0) return { words, wrapped: false }
  const name = words[0].toLowerCase()
  if (name === 'command') return { words: words.slice(1), wrapped: true }
  if (name === 'env') {
    let i = 1
    while (i < words.length) {
      const arg = words[i]
      if (arg === '--') { i += 1; break }
      if (arg === '-i' || arg === '--ignore-environment' || /^-[^-].*/.test(arg)) { i += 1; continue }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { i += 1; continue }
      break
    }
    return { words: words.slice(i), wrapped: true }
  }
  if (name === 'sudo') {
    let i = 1
    const takesArg = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-C', '--chdir', '-D'])
    while (i < words.length) {
      const arg = words[i]
      if (arg === '--') { i += 1; break }
      if (takesArg.has(arg)) { i += 2; continue }
      if (arg.startsWith('--') && arg.includes('=')) { i += 1; continue }
      if (arg.startsWith('-')) { i += 1; continue }
      break
    }
    return { words: words.slice(i), wrapped: true }
  }
  return { words, wrapped: false }
}

function splitShellCommand(source: string): { segments: string[]; hasControl: boolean } | null {
  const segments: string[] = []
  let segment = ''
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let hasControl = false
  const flush = () => { if (segment.trim()) segments.push(segment.trim()); segment = '' }
  for (const ch of source) {
    if (escaped) { segment += ch; escaped = false; continue }
    if (ch === '\\' && quote !== 'single') { segment += ch; escaped = true; continue }
    if (quote === 'single') { segment += ch; if (ch === "'") quote = null; continue }
    if (quote === 'double') { segment += ch; if (ch === '"') quote = null; continue }
    if (ch === "'") { segment += ch; quote = 'single'; continue }
    if (ch === '"') { segment += ch; quote = 'double'; continue }
    if (ch === '(' && segment.endsWith('$')) { segment += ch; continue }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '(' || ch === ')') {
      hasControl = true
      flush()
      continue
    }
    segment += ch
  }
  if (escaped || quote) return null
  flush()
  return { segments, hasControl }
}

export function analyzeShellTuiCommand(command: string): ShellTuiVerdict {
  let t = command.trim()
  if (!t) return { kind: 'clear' }
  const split = splitShellCommand(t)
  if (!split) return { kind: 'undetectable', reason: 'parse-incomplete' }
  if (split.hasControl) {
    for (const segment of split.segments) {
      const verdict = analyzeShellTuiCommand(segment)
      if (verdict.kind !== 'clear') return verdict
    }
    return { kind: 'clear' }
  }
  for (let depth = 0; depth < 4; depth += 1) {
    const parsed = shellWords(t)
    if (!parsed) return { kind: 'undetectable', reason: 'parse-incomplete' }
    const unwrapped = unwrapWrapper(parsed)
    if (!unwrapped.wrapped) break
    if (!unwrapped.words || unwrapped.words.length === 0) return { kind: 'undetectable', reason: 'unsupported-wrapper' }
    t = unwrapped.words.join(' ')
  }
  if (/^(?:bash|sh|zsh|fish)\s+-c\s+/i.test(t) || /^eval\s+/i.test(t)) {
    return /\b(?:less|more|top|htop|vim|vi|nano|emacs)\b/i.test(t)
      ? { kind: 'undetectable', reason: 'unsupported-wrapper' }
      : { kind: 'clear' }
  }
  if (/^(?:env|command|sudo)\s+/i.test(t)) return { kind: 'undetectable', reason: 'unsupported-wrapper' }
  if (/[`$]/.test(t) && /\b(?:less|more|top|htop|vim|vi|nano|emacs)\b/i.test(t)) return { kind: 'undetectable', reason: 'parse-incomplete' }
  const argv = t.split(/\s+/).filter(Boolean)
  const program = argv[0]?.replace(/^.*[\\/]/, '').toLowerCase()
  if (program && TUI_PROGRAMS.has(program)) return { kind: 'match', program, rule: 'direct-program' }
  if (program === 'npm' && argv[1] === 'init' && !argv.includes('-y') && !argv.includes('--yes')) return { kind: 'match', program, rule: 'npm-init' }
  if (program === 'git' && argv.includes('rebase') && argv.includes('-i')) return { kind: 'match', program, rule: 'git-rebase-interactive' }
  return { kind: 'clear' }
}

export function isInteractiveShellTuiCommand(command: string): boolean {
  return analyzeShellTuiCommand(command).kind === 'match'
}

export function shellTuiHintLines(match: ShellTuiMatch): string[] {
  return [
    `SpaceAssistant 内的 run_shell 为非交互执行，无法承载 ${match.program} 这类全屏或需键盘输入的程序。`,
    '这属于执行环境/能力限制，不是安全策略拒绝；不要改用其他工具或换写法重复尝试同一交互程序。',
    '请改写为非交互命令；若必须交互执行，请把命令与用途告知用户，由用户在系统终端运行。'
  ]
}

export function shellTuiUndetectableHintLines(v: { reason: string; programs?: readonly string[] }): string[] {
  const why = v.reason === 'nested-command-unresolvable' ? '嵌套命令含变量/命令替换，无法静态确认'
    : v.reason === 'recursion-depth-exceeded' ? '命令嵌套层数超出宿主分析上限'
    : v.reason === 'unbalanced-quote' ? '引号不平衡'
    : '命令分析结果不完整'
  const programs = v.programs && v.programs.length > 0 ? v.programs.join('、') : '交互式程序'
  return [
    `宿主无法可信判断该命令的命令位（${why}），且文本中出现 ${programs}。`,
    '这属于执行环境/能力限制，不是安全策略拒绝；不要改用其他工具或换写法重复尝试同一交互程序。',
    '请把命令拆分为单条简单命令后重试；若必须交互执行，请把命令与用途告知用户，由用户在系统终端运行。'
  ]
}
