import { parseShellCommandForTrust, parseShellSegments, tokenizeShellArgv } from '../../shell/shellCommandParser'
import { commandHasShellMetasyntax } from '../../shell/shellCommandParser'
import type { CommandFact, EnvFacts, FactSignal } from '../../../src/shared/confirmation/types'

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

function segmentFacts(segment: string, index: number): CommandFact {
  const argv = tokenizeShellArgv(segment) ?? []
  if (argv.length === 0) {
    return { verb: '', args: [], signature: '' }
  }
  const verb = argv[0]!
  const args = argv.slice(1)
  const signature = normalizeShellSignature(segment)
  return {
    verb,
    args,
    signature,
    // 简化：把 `<segment> && <segment>` 拆开后的相邻关系标注为 pipe 链
    ...(index > 0 ? { pipesInto: `segment-${index - 1}` } : {})
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

  const commands: CommandFact[] = segments.map((s, i) => segmentFacts(s, i))
  const signature = commands
    .map((c) => c.signature)
    .filter(Boolean)
    .join(' && ')
  return {
    signals: [{ kind: 'command-sequence', commands }],
    summary: {
      text: signature ? `命令序列：${signature}` : '命令无法解析，需确认'
    }
  }
}

/** 校验命令是否可用于信任缓存（仅单条简单命令且无元语法才可持久化信任）。 */
export function isPersistableTrustCommand(command: string): boolean {
  const parsed = parseShellCommandForTrust(command, commandHasShellMetasyntax)
  return parsed.persistable
}
