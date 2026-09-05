import path from 'path'
import { parseShellCommandForTrust, parseShellSegments, tokenizeShellArgv } from '../../shell/shellCommandParser'
import { commandHasShellMetasyntax } from '../../shell/shellCommandParser'
import type { CommandFact, EnvFacts, FactSignal } from '../../../src/shared/confirmation/types'
import { CONFIRMATION_LABELS } from '../../../src/shared/confirmation/labels'

/**
 * 命令序列提取器（run_shell）。
 *
 * 把 shell 命令拆解为子命令序列，逐子命令产出规范化签名（与缓存键同源）。
 * 判定（信任/拒绝）由策略层查规则得出；本提取器只产出事实。
 * 变体绕过防护：签名取子命令规范化 token 序列，`FOO=1 cmd`、`cd x && cmd`、引号/空白变体
 * 不会命中同一组子命令的 exact 档缓存。
 */

function normalizeToken(tok: string): string {
  return tok.replace(/^["']|["']$/g, '').trim()
}

/** 规范化 shell 命令签名（与缓存键同源）：归一化引号/空白/大小写，供对账与变体绕过防护。 */
export function normalizeShellSignature(command: string): string {
  const tokens = tokenizeShellArgv(command) ?? []
  return tokens.map(normalizeToken).filter(Boolean).join(' ')
}

function extractConnectors(command: string): string[] {
  const connectors: string[] = []
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      connectors.push(two)
      i++
    } else if (ch === '|' || ch === ';') {
      connectors.push(ch)
    }
  }
  return connectors
}

function segmentFacts(segment: string, index: number, connectors: string[], effectiveCwd: string): CommandFact {
  const argv = tokenizeShellArgv(segment) ?? []
  if (argv.length === 0) {
    return { verb: '', args: [], signature: '', effectiveCwd }
  }
  const verb = argv[0]!
  const args = argv.slice(1)
  const signature = normalizeShellSignature(segment)
  return {
    verb,
    args,
    signature,
    effectiveCwd,
    // 简化：把 `<segment> && <segment>` 拆开后的相邻关系标注为 pipe 链
    ...(index > 0
      ? {
          pipesInto: `segment-${index - 1}`,
          ...(connectors[index - 1] ? { connector: connectors[index - 1] } : {})
        }
      : {})
  }
}

export function extractCommandSignals(command: string, _env: EnvFacts): {
  signals: FactSignal[]
  summary: { text: string }
} {
  const segments = parseShellSegments(command)
  if (segments.length === 0) {
    return {
      signals: [{ kind: 'extraction-failed', reason: 'empty-command' }],
      summary: { text: '无法解析的空命令' }
    }
  }

  const connectors = extractConnectors(command)
  let effectiveCwd = _env.workDir
  const commands: CommandFact[] = segments.map((s, i) => {
    const fact = segmentFacts(s, i, connectors, effectiveCwd)
    const verb = fact.verb.toLowerCase()
    const next = fact.args[0]
    if ((verb === 'cd' || verb === 'set-location' || verb === 'sl') && next) {
      effectiveCwd = _env.os === 'win32'
        ? path.win32.resolve(effectiveCwd, next)
        : path.posix.resolve(effectiveCwd, next)
    }
    return fact
  })
  // 仅单分段 + 无元语法的简单命令才允许派生信任缓存键（等价于现 parseShellCommandForTrust 的 persistable 判定）；
  // 复合命令（`a && b`、管道等）不得因任一分段被信任而放行整条命令（B1 / §5.2 变体绕过）。
  const persistable = segments.length === 1 && isPersistableTrustCommand(command)
  const signature = commands
    .map((c) => c.signature)
    .filter(Boolean)
    .join(' && ')
  return {
    signals: [{ kind: 'command-sequence', commands, ...(persistable ? { persistable } : {}) }],
    summary: {
      text: signature ? `${CONFIRMATION_LABELS.summaryCommandSequencePrefix}${signature}` : CONFIRMATION_LABELS.summaryEmptyCommand
    }
  }
}

/** 校验命令是否可用于信任缓存（仅单条简单命令且无元语法才可持久化信任）。 */
export function isPersistableTrustCommand(command: string): boolean {
  const parsed = parseShellCommandForTrust(command, commandHasShellMetasyntax)
  return parsed.persistable
}
