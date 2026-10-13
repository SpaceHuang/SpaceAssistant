export type ImAdapterChannel = 'wechat' | 'feishu'

export interface ImAdapterCapability {
  id: string
  labelKey: string
  toolNames: readonly string[]
  supportedChannels: readonly ImAdapterChannel[]
  policyRuleId: string
}

export type ImAdapterCapabilityResolution =
  | { available: true; capability: ImAdapterCapability }
  | { available: false; disposition: 'capability-unavailable'; reason: 'unknown-channel' | 'unknown-capability' | 'unsupported-channel' }

/** Shared IM capability support contract consumed by settings and later adapter parity checks. */
export const IM_ADAPTER_CAPABILITIES: readonly ImAdapterCapability[] = [
  {
    id: 'workspace.file.write',
    labelKey: 'toolsSecurity.policy.capabilityWorkspaceFileWrite',
    toolNames: ['write_file', 'edit_file'],
    supportedChannels: ['wechat', 'feishu'],
    policyRuleId: 'im-low-risk-create'
  },
  {
    id: 'feishu.resource.write',
    labelKey: 'toolsSecurity.policy.capabilityFeishuResourceWrite',
    toolNames: ['run_lark_cli'],
    supportedChannels: ['feishu'],
    policyRuleId: 'im-lark-low-write-review'
  }
]

/** Resolve adapter support independently of whether the shared policy permits the action. */
export function resolveImAdapterCapability(channel: unknown, capabilityId: unknown): ImAdapterCapabilityResolution {
  if (channel !== 'wechat' && channel !== 'feishu') {
    return { available: false, disposition: 'capability-unavailable', reason: 'unknown-channel' }
  }
  if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
    return { available: false, disposition: 'capability-unavailable', reason: 'unknown-capability' }
  }
  const capability = IM_ADAPTER_CAPABILITIES.find((candidate) => candidate.id === capabilityId)
  if (!capability) return { available: false, disposition: 'capability-unavailable', reason: 'unknown-capability' }
  if (!capability.supportedChannels.includes(channel)) {
    return { available: false, disposition: 'capability-unavailable', reason: 'unsupported-channel' }
  }
  return { available: true, capability }
}
