export type ImChannelSafetyCapability =
  | 'trustedIdentity'
  | 'verifiedPrivateChat'
  | 'capabilityDeclaration'
  | 'factExtraction'
  | 'controlledReply'
  | 'todoIdentityBinding'

export interface ImChannelContract {
  channelId: string
  trustedIdentity: boolean
  verifiedPrivateChat: boolean
  capabilityDeclaration: boolean
  factExtraction: boolean
  controlledReply: boolean
  todoIdentityBinding: boolean
}

export interface ImIdentityBinding {
  channelId: string
  identityKey: string
  ownerId: string
  originSessionId: string
}

export type ImChannelContractResolution =
  | { enabled: true; channelId: string }
  | { enabled: false; reason: 'invalid-channel-id' | 'required-safety-capability-missing'; missing: ImChannelSafetyCapability[] }

const REQUIRED_CAPABILITIES: readonly ImChannelSafetyCapability[] = [
  'trustedIdentity',
  'verifiedPrivateChat',
  'capabilityDeclaration',
  'factExtraction',
  'controlledReply',
  'todoIdentityBinding'
]

/** Validate adapter evidence before an IM channel may use automatic review. */
export function validateImChannelContract(contract: ImChannelContract): ImChannelContractResolution {
  if (typeof contract.channelId !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(contract.channelId)) {
    return { enabled: false, reason: 'invalid-channel-id', missing: [] }
  }
  const missing = REQUIRED_CAPABILITIES.filter((capability) => contract[capability] !== true)
  if (missing.length > 0) return { enabled: false, reason: 'required-safety-capability-missing', missing: [...missing] }
  return { enabled: true, channelId: contract.channelId }
}

/** Compare approval and todo ownership as an exact tuple; no field may be inferred from another. */
export function matchesImIdentityBinding(expected: ImIdentityBinding, actual: ImIdentityBinding): boolean {
  return [expected.channelId, expected.identityKey, expected.ownerId, expected.originSessionId,
    actual.channelId, actual.identityKey, actual.ownerId, actual.originSessionId].every((value) => typeof value === 'string' && value.length > 0)
    && expected.channelId === actual.channelId
    && expected.identityKey === actual.identityKey
    && expected.ownerId === actual.ownerId
    && expected.originSessionId === actual.originSessionId
}
