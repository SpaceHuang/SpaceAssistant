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
        const resolved = rules.map((rule) => {
          const action = imEffectiveActionFor('im', input.pkg, rule)
          if (rule.id === 'remote-shell-disabled') return { ...rule, action, match: { ...rule.match!, excludeSignals: ['im-shell-review-candidate:git-status', 'im-shell-review-candidate:git-log'] } }
          if (rule.id === 'remote-outside-read-deny') return { ...rule, action, match: { ...rule.match!, signals: ['path-target:outside-workdir', 'read-target-scope:subtree'] } }
          if (rule.id === 'remote-outside-write-deny') return { ...rule, action, match: { ...rule.match!, signals: ['write-target-scope:outside-workdir', 'write-target-unsupported'] } }
          if (rule.id === 'remote-wechat-media-outside-deny') return { ...rule, action,
            match: { ...rule.match!, toolName: 'wechat_send', signals: ['wechat-media-target:outside-workdir', 'policy-tier:standard'] } }
          if (rule.id === 'outbound-mode-standard-review') return { ...rule,
            match: { ...rule.match!, excludeSignals: [...(rule.match?.excludeSignals ?? []), 'wechat-media-review-materials:complete'] } }
          return { ...rule, action }
        })
        resolved.push(
          { id: 'im-outside-read-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: ['read_file', 'grep'], actionClass: 'read', signals: ['path-target:outside-workdir', 'read-target-scope:single-target', 'read-target-kind:file'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external single-file read review' },
          { id: 'im-outside-list-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'list_directory', actionClass: 'read', signals: ['path-target:outside-workdir', 'read-target-scope:direct-entries', 'read-target-kind:directory'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external direct listing review' },
          { id: 'im-outside-write-new-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'write_file', actionClass: 'write', signals: ['write-target-scope:outside-workdir', 'write-target-new'], excludeSignals: ['write-target-unsupported', 'path-target:sensitive-file'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external new file review' },
          { id: 'im-outside-write-edit-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'edit_file', actionClass: 'write', signals: ['write-target-scope:outside-workdir', 'write-target-existing'], excludeSignals: ['write-target-unsupported', 'path-target:sensitive-file'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external file edit review' },
          { id: 'im-shell-review', when: 'invocation', match: { lane: ['wechat', 'feishu'], toolName: 'run_shell', actionClass: 'execute', signals: ['im-shell-review-candidate'] }, action: 'ask', answerer: 'agent', reason: 'IM bounded Git query review' },
          { id: 'im-wechat-media-outside-review', when: 'invocation', match: { lane: ['wechat'], toolName: 'wechat_reply', actionClass: 'outbound', signals: ['wechat-media-target:outside-workdir', 'wechat-media-target-kind:file', 'wechat-media-content-assessment:complete', 'wechat-media-review-binding:complete', 'policy-tier:standard'], excludeSignals: ['policy-tier:strict', 'policy-tier:loose', 'policy-tier:custom'] }, action: 'ask', answerer: 'agent', reason: 'IM directory-external WeChat attachment review' },
          { id: 'remote-wechat-media-outside-reply-deny', when: 'invocation', match: { lane: ['wechat'], toolName: 'wechat_reply', signals: ['wechat-media-target:outside-workdir', 'policy-tier:standard'], excludeSignals: ['wechat-media-review-materials:complete'] }, action: 'deny', locked: true, denyClass: 'forbidden', reason: 'Incomplete external attachment reviews remain denied' },
          { id: 'remote-wechat-media-outside-nonstandard-deny', when: 'invocation', match: { lane: ['wechat'], toolName: ['wechat_send', 'wechat_reply'], signals: ['wechat-media-target:outside-workdir'], excludeSignals: ['policy-tier:standard'] }, action: 'deny', locked: true, denyClass: 'forbidden', reason: 'Only complete standard attachment candidates can be reviewed' },
          ...unverifiedTargetDenies
        )
        return resolved
      }
    }
  })
}
