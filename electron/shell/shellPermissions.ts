import type { ShellRule } from '../../src/shared/domainTypes'

export interface ShellPermissionResult {
  decision: 'allow' | 'deny' | 'ask'
  matchedRuleId?: string
  reason?: string
  builtin?: boolean
}

const BUILTIN_DENY: Array<{ pattern: string; reason: string }> = [
  { pattern: 'sudo:*', reason: '提权' },
  { pattern: 'doas:*', reason: '提权' },
  { pattern: 'rm -rf:*', reason: '破坏性删除' },
  { pattern: 'rm -r -f:*', reason: '破坏性删除' },
  { pattern: 'lark-cli:*', reason: '请使用 run_lark_cli' }
]

function matchGlob(pattern: string, command: string): boolean {
  const p = pattern.trim()
  if (p.endsWith('*')) {
    return command.startsWith(p.slice(0, -1))
  }
  if (p.startsWith('*') && p.endsWith('*')) {
    return command.includes(p.slice(1, -1))
  }
  if (p.includes('*')) {
    const parts = p.split('*')
    let idx = 0
    for (const part of parts) {
      if (!part) continue
      const found = command.indexOf(part, idx)
      if (found < 0) return false
      idx = found + part.length
    }
    return true
  }
  return command === p || command.startsWith(p + ' ')
}

function matchRule(pattern: string, command: string, segment?: string): boolean {
  const target = pattern.includes(':') && segment ? segment.trim() : command.trim()
  const pat = pattern.includes(':') ? pattern.split(':').slice(1).join(':') : pattern
  if (pat.includes('|') || pat.includes('*')) {
    return matchGlob(pat, target)
  }
  return target === pat || target.startsWith(pat + ' ')
}

export function evaluateShellPermission(
  command: string,
  segments: string[],
  userRules?: ShellRule[]
): ShellPermissionResult {
  const cmd = command.trim()

  for (const builtin of BUILTIN_DENY) {
    const [prefix, ...rest] = builtin.pattern.split(':')
    const pat = rest.join(':') || '*'
    for (const seg of segments.length ? segments : [cmd]) {
      if (prefix === '*' || seg.trim().toLowerCase().startsWith(prefix!.toLowerCase())) {
        if (matchRule(`${prefix}:${pat}`, cmd, seg)) {
          return { decision: 'deny', reason: builtin.reason, builtin: true }
        }
      }
    }
    if (matchGlob(builtin.pattern.replace(':*', '*'), cmd)) {
      return { decision: 'deny', reason: builtin.reason, builtin: true }
    }
  }

  if (/curl.*\|.*\bsh\b/i.test(cmd) || /wget.*\|.*\bsh\b/i.test(cmd)) {
    return { decision: 'deny', reason: '远程脚本管道', builtin: true }
  }

  const rules = userRules ?? []
  const ordered = [...rules].sort((a, b) => {
    const score = (d: string) => (d === 'deny' ? 0 : d === 'ask' ? 1 : 2)
    return score(a.decision) - score(b.decision)
  })

  for (const rule of ordered) {
    for (const seg of segments.length ? segments : [cmd]) {
      if (matchRule(rule.pattern, cmd, seg) || matchGlob(rule.pattern, seg.trim())) {
        return { decision: rule.decision, matchedRuleId: rule.id, reason: rule.note }
      }
    }
    if (matchGlob(rule.pattern, cmd)) {
      return { decision: rule.decision, matchedRuleId: rule.id, reason: rule.note }
    }
  }

  return { decision: 'ask' }
}

export function getBuiltinDenyRulesDisplay(): Array<{ pattern: string; reason: string }> {
  return [...BUILTIN_DENY]
}
