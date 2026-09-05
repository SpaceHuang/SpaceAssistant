import type { CacheKey } from '../../src/shared/confirmation/types'
import type { ShellConfig, ShellRule, TrustedShellCommand } from '../../src/shared/domainTypes'
import { evaluateShellPermission } from './shellPermissions'
import { matchesTrustedCommand, parseSimpleShellCommand } from './shellCommandTrust'

export interface LegacyShellPolicyInput {
  readonly permissionDecision: 'allow' | 'deny' | 'ask'
  readonly matchedRuleId?: string
  readonly trustedCacheKeys: readonly CacheKey[]
}

/**
 * Legacy ShellRule/trustedCommands 的唯一迁移适配器。
 * 只生成 decide() 可消费的输入，不返回 skipConfirm、verdict 或最终授权结论。
 */
export function adaptLegacyShellPolicy(args: {
  command: string
  segments: readonly string[]
  rules?: readonly ShellRule[]
  trustedCommands?: readonly TrustedShellCommand[]
  profileNamespace?: string
}): LegacyShellPolicyInput {
  const permission = evaluateShellPermission(args.command, [...args.segments], args.rules ? [...args.rules] : undefined)
  const trustedCacheKeys: CacheKey[] = []
  if (args.trustedCommands?.length && matchesTrustedCommand(args.command, [...args.trustedCommands])) {
    const parsed = parseSimpleShellCommand(args.command)
    if (parsed.persistable && !parsed.hasMetasyntax) {
      const signature = args.profileNamespace ? `${args.profileNamespace}:${parsed.normalized}` : parsed.normalized
      trustedCacheKeys.push({ kind: 'shell-command', verb: signature, level: 'exact' })
    }
  }
  return {
    permissionDecision: permission.decision,
    ...(permission.matchedRuleId ? { matchedRuleId: permission.matchedRuleId } : {}),
    trustedCacheKeys
  }
}

/** Compile only the legacy user rules; deny remains policy input and never becomes skip-confirm. */
export function adaptLegacyShellConfig(
  command: string,
  segments: readonly string[],
  config?: ShellConfig | null,
  profileNamespace?: string
): LegacyShellPolicyInput {
  return adaptLegacyShellPolicy({
    command,
    segments,
    rules: config?.rules,
    trustedCommands: config?.trustedCommands,
    ...(profileNamespace ? { profileNamespace } : {})
  })
}
