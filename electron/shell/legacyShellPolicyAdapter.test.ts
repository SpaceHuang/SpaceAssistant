import { describe, expect, it } from 'vitest'
import { adaptLegacyShellPolicy } from './legacyShellPolicyAdapter'

describe('LegacyShellPolicyAdapter', () => {
  it('只输出 policy input，不提供 skipConfirm/verdict', () => {
    const result = adaptLegacyShellPolicy({
      command: 'git status', segments: ['git status'], profileNamespace: 'bash:posix-bash',
      rules: [{ id: 'deny-git', pattern: 'git status', decision: 'deny', note: '禁止' }]
    })
    expect(result).toMatchObject({ permissionDecision: 'deny', matchedRuleId: 'deny-git', trustedCacheKeys: [] })
    expect(result).not.toHaveProperty('skipConfirm')
    expect(result).not.toHaveProperty('verdict')
  })

  it('只为 simple persistable trusted command 生成 namespace exact cache key', () => {
    const trusted = [{ id: 't1', schemaVersion: 2, executable: 'git', fixedArgvPrefix: ['status'], trailingArgv: 'exact' as const, createdAt: 1, lastUsedAt: 1, expired: false }]
    const result = adaptLegacyShellPolicy({ command: 'git status', segments: ['git status'], trustedCommands: trusted, profileNamespace: 'bash:posix-bash' })
    expect(result.trustedCacheKeys).toEqual([{ kind: 'shell-command', verb: 'bash:posix-bash:git status', level: 'exact' }])
    expect(adaptLegacyShellPolicy({ command: 'git status && echo ok', segments: ['git status', 'echo ok'], trustedCommands: trusted }).trustedCacheKeys).toEqual([])
  })
})
