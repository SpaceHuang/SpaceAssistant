import type { PolicyDomain } from './policyDomain'
import type { PolicyAction } from '../confirmation/types'

export type ImPolicyScenario =
  | 'ordinary-read'
  | 'low-risk-create'
  | 'low-risk-edit'
  | 'ordinary-navigation'
  | 'public-search'
  | 'mcp-execution'
  | 'time-query'
  | 'certified-clean-script'
  | 'ordinary-browser-action'
  | 'low-risk-feishu-write'
  | 'overwrite-delete'
  | 'unknown-write-execute'
  | 'outbound'
  | 'hard-deny'
  | 'human-required'

export type ImPolicyAction = PolicyAction
export type ImPolicyPackage = 'strict' | 'standard' | 'loose' | 'custom'

/** Stable audit identifiers for the user-visible behavior changes when opting into the current IM standard. */
export const IM_STANDARD_BEHAVIOR_DIFF_IDS = [
  'mcp-public-read-auto',
  'low-risk-browser-and-feishu-auto',
  'sensitive-write-and-external-outbound-manual'
] as const

export interface ResolveImPolicyActionInput {
  domain: PolicyDomain
  pkg: ImPolicyPackage
  scenario: ImPolicyScenario
  customAction?: ImPolicyAction
}

type AdjustableScenario = Exclude<ImPolicyScenario, 'hard-deny' | 'human-required'>

const IM_ACTION_MATRIX: Record<ImPolicyPackage, Record<AdjustableScenario, ImPolicyAction>> = {
  strict: {
    'ordinary-read': 'allow', 'low-risk-create': 'ask', 'low-risk-edit': 'ask', 'ordinary-navigation': 'ask', 'public-search': 'ask', 'mcp-execution': 'ask', 'time-query': 'ask', 'certified-clean-script': 'ask', 'ordinary-browser-action': 'ask', 'low-risk-feishu-write': 'ask', 'overwrite-delete': 'ask',
    'unknown-write-execute': 'ask', outbound: 'ask'
  },
  standard: {
    'ordinary-read': 'allow', 'low-risk-create': 'auto-evaluator', 'low-risk-edit': 'auto-evaluator', 'ordinary-navigation': 'auto-evaluator', 'public-search': 'auto-evaluator', 'mcp-execution': 'auto-evaluator', 'time-query': 'auto-evaluator', 'certified-clean-script': 'auto-evaluator', 'ordinary-browser-action': 'auto-evaluator', 'low-risk-feishu-write': 'auto-evaluator', 'overwrite-delete': 'ask',
    'unknown-write-execute': 'ask', outbound: 'ask'
  },
  loose: {
    'ordinary-read': 'allow', 'low-risk-create': 'allow', 'low-risk-edit': 'allow', 'ordinary-navigation': 'allow', 'public-search': 'allow', 'mcp-execution': 'ask', 'time-query': 'allow', 'certified-clean-script': 'allow', 'ordinary-browser-action': 'ask', 'low-risk-feishu-write': 'ask', 'overwrite-delete': 'ask',
    'unknown-write-execute': 'ask', outbound: 'ask'
  },
  custom: {
    'ordinary-read': 'allow', 'low-risk-create': 'ask', 'low-risk-edit': 'ask', 'ordinary-navigation': 'ask', 'public-search': 'ask', 'mcp-execution': 'ask', 'time-query': 'ask', 'certified-clean-script': 'ask', 'ordinary-browser-action': 'ask', 'low-risk-feishu-write': 'ask', 'overwrite-delete': 'ask',
    'unknown-write-execute': 'ask', outbound: 'ask'
  }
}

/** Resolve the shared IM action contract; hard deny and human-required floors cannot be relaxed. */
export function resolveImPolicyAction(input: ResolveImPolicyActionInput): ImPolicyAction {
  if (input.domain !== 'im') throw new Error(`Unsupported policy domain: ${input.domain}`)
  if (input.scenario === 'hard-deny') return 'deny'
  if (input.scenario === 'human-required') return 'ask'
  if (input.pkg === 'custom') return input.customAction ?? IM_ACTION_MATRIX.custom[input.scenario]
  return IM_ACTION_MATRIX[input.pkg][input.scenario]
}

const IM_SCENARIO_BY_RULE_ID: Readonly<Record<string, ImPolicyScenario>> = {
  'im-low-risk-create': 'low-risk-create',
  'im-low-risk-edit': 'low-risk-edit',
  'browser-navigate-ask-remote': 'ordinary-navigation',
  'im-mcp-public-read-review': 'public-search',
  'mcp-tool-ask': 'mcp-execution',
  'im-browser-act-review': 'ordinary-browser-action',
  'im-lark-low-write-review': 'low-risk-feishu-write',
  'im-lark-message-self-review': 'low-risk-feishu-write',
  'im-lark-message-direct-review': 'low-risk-feishu-write',
  'im-time-query-review': 'time-query',
  'script-clean-certified-remote': 'certified-clean-script'
}

/** Map a shared IM rule to the package's effective action; locked and custom rules remain explicit. */
export function imEffectiveActionFor(
  domain: PolicyDomain,
  pkg: ImPolicyPackage,
  rule: { id?: string; action: ImPolicyAction | 'confirm-every-time'; locked?: boolean },
  customAction?: ImPolicyAction
): ImPolicyAction {
  if (domain !== 'im') throw new Error(`Unsupported policy domain: ${domain}`)
  if (rule.locked || rule.action === 'deny' || rule.action === 'confirm-every-time' || pkg === 'custom') {
    return pkg === 'custom' && customAction ? customAction : rule.action
  }
  const scenario = rule.id ? IM_SCENARIO_BY_RULE_ID[rule.id] : undefined
  if (!scenario) return rule.action
  return resolveImPolicyAction({ domain, pkg, scenario, customAction })
}
