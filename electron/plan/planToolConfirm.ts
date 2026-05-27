import type { PlanConfig } from '../../src/shared/domainTypes'
import type { PlanMeta, PlanToolConfirmPolicy } from '../../src/shared/planTypes'
import type { PlanToolPhase } from '../../src/shared/planToolsFilter'
import type { RunScriptProvenanceContext } from './runScriptProvenance'
import { isAgentGeneratedRunScript } from './runScriptProvenance'

export function shouldSkipToolConfirm(args: {
  planToolPhase: PlanToolPhase | null
  planMeta: PlanMeta | null
  policy: PlanToolConfirmPolicy
  toolName: string
  toolInput: Record<string, unknown>
  provenance: RunScriptProvenanceContext | null
  planConfig: PlanConfig
}): boolean {
  if (args.planToolPhase !== 'implementation') return false
  if (!args.planMeta || !['executing', 'approved'].includes(args.planMeta.status)) return false

  switch (args.policy) {
    case 'always_confirm':
      return false
    case 'trust_plan_all':
      return true
    case 'trust_plan':
    case 'confirm_high_risk':
      if (args.toolName === 'run_lark_cli') return false
      if (args.toolName === 'run_script') {
        return (
          args.planConfig.autoApproveAgentGeneratedScripts &&
          args.provenance !== null &&
          isAgentGeneratedRunScript(args.toolInput.code, args.provenance)
        )
      }
      return args.toolName !== 'run_script' && args.toolName !== 'run_lark_cli'
  }
}

export type ToolConfirmSkipReason = 'plan_execution_trust' | 'plan_agent_generated_script'

export function toolConfirmSkipReason(args: {
  toolName: string
  toolInput: Record<string, unknown>
  provenance: RunScriptProvenanceContext | null
  planConfig: PlanConfig
}): ToolConfirmSkipReason {
  if (
    args.toolName === 'run_script' &&
    args.provenance &&
    isAgentGeneratedRunScript(args.toolInput.code, args.provenance)
  ) {
    return 'plan_agent_generated_script'
  }
  return 'plan_execution_trust'
}
