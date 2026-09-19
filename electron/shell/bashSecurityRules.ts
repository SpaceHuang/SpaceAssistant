// P2-T4：Bash 结构性危险模式（树事实驱动，结构匹配而非正则扫描）。
// 约束（P2-T2）：模式命中只可向更严方向合并（ask/deny），永不降级；
// 重定向敏感目标复用 shellSensitivePaths 的敏感前缀表与 isSensitivePath。
import os from 'node:os'
import path from 'node:path'
import type { BashCommandFacts } from './bashCommandFacts'
import { isSensitivePath } from './shellSensitivePaths'
import { normalizeWindowsPath } from './shellPathAnalysis'

/** ~ 前缀展开（isSensitivePath 只接受已展开的绝对路径前缀比较） */
function expandHomeTilde(target: string): string {
  if (target.startsWith('~/') || target === '~') {
    return path.join(os.homedir(), target.slice(1))
  }
  if (target.startsWith('$HOME/')) {
    return path.join(os.homedir(), target.slice('$HOME/'.length))
  }
  return target
}

export interface BashPatternHit {
  id: string
  verdict: 'ask' | 'deny'
  reason: string
}

const PIPE_INTO_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'perl'])
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'nc', 'ncat'])
const DECODE_FLAGS = new Set(['-d', '--decode', '-D'])

function argTexts(facts: BashCommandFacts): string[] {
  return facts.commands.flatMap((c) => c.args)
}

function redirectTargets(facts: BashCommandFacts): string[] {
  return facts.commands.flatMap((c) => c.redirects.map((r) => r.target))
}

/**
 * 遍历全部结构模式，返回命中集合（调用方逐个向更严合并）。
 * facts.ok=false 时不应调用（上游已走解析失败兜底）。
 */
export function matchBashDangerousPatterns(
  facts: BashCommandFacts,
  userDataDir?: string,
  customSensitivePrefixes?: string[]
): BashPatternHit | null {
  const hits = collectHits(facts, userDataDir, customSensitivePrefixes)
  if (hits.length === 0) return null
  // deny 优先；同 verdict 取首个（violationCodes 由 hints 携带 validatorId 呈现主模式）
  return hits.find((h) => h.verdict === 'deny') ?? hits[0]!
}

export function collectBashDangerousPatternHits(
  facts: BashCommandFacts,
  userDataDir?: string,
  customSensitivePrefixes?: string[]
): BashPatternHit[] {
  return collectHits(facts, userDataDir, customSensitivePrefixes)
}

function collectHits(
  facts: BashCommandFacts,
  userDataDir?: string,
  customSensitivePrefixes?: string[]
): BashPatternHit[] {
  const hits: BashPatternHit[] = []

  // 1) pipe-to-shell：管道末端是解释器（结构匹配：pipeline 最后一段的命令名）
  for (const pipe of facts.pipelines) {
    const last = pipe.segments[pipe.segments.length - 1]
    if (last && PIPE_INTO_INTERPRETERS.has(last.name)) {
      hits.push({ id: 'pipe-to-shell', verdict: 'deny', reason: `管道输出直接进入解释器（${last.name}），已拒绝` })
    }
  }

  const hasRedirect = redirectTargets(facts).length > 0

  // 2) subst-exfil：命令替换内出现网络命令，且伴随重定向或参数引用路径
  for (const sub of facts.substitutions) {
    if (sub.kind !== 'command') continue
    const inner = sub.inner.toLowerCase()
    for (const net of NETWORK_COMMANDS) {
      if (new RegExp(`(^|\\s|/)${net}\\b`).test(inner)) {
        if (hasRedirect || sub.inner.includes('/')) {
          hits.push({ id: 'subst-exfil', verdict: 'ask', reason: '命令替换内包含网络下载且伴随重定向/路径，需人工确认' })
        }
        break
      }
    }
  }

  // 3) base64-decode-exec：base64 -d 输出经管道/替换进入解释器或 eval
  for (const pipe of facts.pipelines) {
    for (let i = 0; i < pipe.segments.length - 1; i += 1) {
      const seg = pipe.segments[i]!
      if (seg.name === 'base64' && seg.args.some((a) => DECODE_FLAGS.has(a))) {
        const next = pipe.segments[i + 1]!
        if (PIPE_INTO_INTERPRETERS.has(next.name) || next.name === 'eval') {
          hits.push({ id: 'base64-decode-exec', verdict: 'deny', reason: 'base64 解码输出直接进入解释器/eval，已拒绝' })
        }
      }
    }
  }

  // 4) rm-rf-variant：rm 带 -rf/-fr 且目标为 /、~、$HOME 或通配根
  for (const cmd of facts.commands) {
    if (cmd.name !== 'rm') continue
    const hasRf = cmd.args.some((a) => /^-[a-zA-Z]*[rf]{1}[a-zA-Z]*$/.test(a) && /[rf]/.test(a)) &&
      cmd.args.some((a) => a.includes('r') && a.includes('f') && a.startsWith('-'))
    if (!hasRf) continue
    for (const target of cmd.args) {
      if (target.startsWith('-')) continue
      const norm = normalizeWindowsPath(target)
      if (norm === '/' || norm === '~' || norm === '$HOME' || norm === '/*' || norm === '~/ *'.trim() || norm === '${HOME}') {
        hits.push({ id: 'rm-rf-variant', verdict: 'deny', reason: `rm 递归强删根/家目录目标（${target}），已拒绝` })
        break
      }
    }
  }

  // 5) redirect-sensitive-target：重定向目标落敏感路径（复用敏感前缀表）
  for (const target of redirectTargets(facts)) {
    if (!target) continue
    const expanded = expandHomeTilde(target.startsWith('$') ? '' : target)
    if (!expanded) continue
    if (isSensitivePath(normalizeWindowsPath(expanded), userDataDir, customSensitivePrefixes)) {
      hits.push({ id: 'redirect-sensitive-target', verdict: 'ask', reason: `重定向目标为敏感路径（${target}），需人工确认` })
    }
  }

  return hits
}

void argTexts
