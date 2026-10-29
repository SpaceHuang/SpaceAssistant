import type { PolicyRule } from '../confirmation/types'
import type { ImPolicyPackage } from './imPolicyBehavior'
import { imEffectiveActionFor } from './imPolicyBehavior'
import { resolvePolicyBehavior } from './policyBehaviorVersion'

export interface ResolveImPolicyRulesForVersionInput {
  policyBehaviorVersion: unknown
  pkg: ImPolicyPackage
  rules: PolicyRule[]
}

/**
 * Resolve IM rules using only the explicitly pinned behavior version.
 * Legacy inputs are already frozen effective rules; v2 applies the current explicit candidate map.
 */
export function resolveImPolicyRulesForVersion(input: ResolveImPolicyRulesForVersionInput): PolicyRule[] {
  return resolvePolicyBehavior({
    policyBehaviorVersion: input.policyBehaviorVersion,
    rules: input.rules,
    resolvers: {
      'im-v1.6': ({ rules }) => structuredClone(rules),
      'im-standard-v2': ({ rules }) => rules.map((rule) => ({
        ...rule,
        action: imEffectiveActionFor('im', input.pkg, rule)
      })),
      // Candidate resolver is available to isolated tests only. Production snapshot loaders
      // intentionally keep v3 out of their supported-version allowlists until release gates pass.
      'im-standard-v3': ({ rules }) => {
        const unverifiedTargetDenies: PolicyRule[] = (['missing', 'symlink', 'special', 'unknown'] as const).map((targetKind) => ({
          id: `remote-outside-read-${targetKind}-deny`, when: 'invocation',
          match: { lane: ['wechat', 'feishu'], toolName: ['read_file', 'grep', 'list_directory'], actionClass: 'read',
            signals: ['path-target:outside-workdir', `read-target-kind:${targetKind}`] },
          action: 'deny', locked: true, denyClass: 'forbidden', reason: 'Unverified external read targets remain denied'
        }))
        const resolved = rules.map((rule) => rule.id === 'remote-shell-disabled'
          ? { ...rule, match: { ...rule.match!, excludeSignals: ['im-shell-review-candidate:git-status', 'im-shell-review-candidate:git-log'] } }
          : rule.id === 'remote-outside-read-deny'
          ? { ...rule, match: { ...rule.match!, signals: ['path-target:outside-workdir', 'read-target-scope:subtree'] } }
          : rule.id === 'remote-outside-write-deny'
            ? { ...rule, match: { ...rule.match!, signals: ['write-target-scope:outside-workdir', 'write-target-unsupported'] } }
          : { ...rule })
        resolved.push(
          { id: 'im-outside-read-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: ['read_file', 'grep'], actionClass: 'read', signals: ['path-target:outside-workdir', 'read-target-scope:single-target', 'read-target-kind:file'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external single-file read review' },
          { id: 'im-outside-list-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'list_directory', actionClass: 'read', signals: ['path-target:outside-workdir', 'read-target-scope:direct-entries', 'read-target-kind:directory'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external direct listing review' },
          { id: 'im-outside-write-new-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'write_file', actionClass: 'write', signals: ['write-target-scope:outside-workdir', 'write-target-new'], excludeSignals: ['write-target-unsupported', 'path-target:sensitive-file'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external new file review' },
          { id: 'im-outside-write-edit-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'edit_file', actionClass: 'write', signals: ['write-target-scope:outside-workdir', 'write-target-existing'], excludeSignals: ['write-target-unsupported', 'path-target:sensitive-file'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external file edit review' },
          { id: 'im-shell-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'run_shell', actionClass: 'execute', signals: ['im-shell-review-candidate'] }, action: 'ask', answerer: 'agent', reason: 'IM bounded Git query review' },
          ...unverifiedTargetDenies
        )
        return resolved
      }
    }
  })
}
