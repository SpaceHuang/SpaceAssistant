import type { Message } from '../../../src/shared/domainTypes'

export type ChatBodyV1 = Readonly<Pick<Message, 'id' | 'role' | 'content' | 'timestamp'>>

export const PROJECTION_SPECS = {
  chatBodyV1: { outputFields: ['id', 'role', 'content', 'timestamp'], selectionDependencies: ['sessionGeneration', 'historyWatermark', 'messageOrder', 'bodyAuthority', 'storageStatus'], invalidationDependencies: ['id', 'role', 'content', 'timestamp', 'messageOrder', 'historyWatermark', 'bodyAuthority'] },
  transcriptParityV1: { outputFields: ['parityDigest', 'canonicalFingerprint', 'eventCount', 'messageCount'], selectionDependencies: ['sessionGeneration', 'historyWatermark', 'messageRevision', 'legacyParity'], invalidationDependencies: ['historyEvent', 'messageIdentity', 'messageBody', 'sessionGeneration'] },
  chatMessageV1: { outputFields: ['message'], selectionDependencies: ['queueScope', 'sequence', 'beforeSequence', 'limit'], invalidationDependencies: ['message', 'queueScope', 'sequence', 'membership'] },
  exportMessageV1: { outputFields: ['message', 'sequence'], selectionDependencies: ['queueScope', 'sequence', 'cursor', 'pageSize'], invalidationDependencies: ['message', 'queueScope', 'sequence', 'membership'] },
  searchCorpusV1: { outputFields: ['message', 'sequence'], selectionDependencies: ['sequence', 'queuedUserExclusion'], invalidationDependencies: ['message', 'status', 'role', 'sequence', 'membership'] },
  globalMessageSearchV1: { outputFields: ['messageId', 'sessionId', 'authoritativeContent', 'sessionName'], selectionDependencies: ['profileOwnership', 'timestamp', 'literalLike', 'limit'], invalidationDependencies: ['messageIdentity', 'contentAuthority', 'timestamp', 'sessionName', 'profileOwnership', 'membership'] },
  apiBaselineV1: { outputFields: ['message', 'sequence'], selectionDependencies: ['sequence', 'limit'], invalidationDependencies: ['message', 'sequence', 'membership'] },
  acceptedContextV1: { outputFields: ['providerMessages'], selectionDependencies: ['role', 'status', 'turnAssociation', 'requiredUser', 'sequence', 'boundary', 'exclude', 'attachmentResolution', 'window', 'continuation', 'track'], invalidationDependencies: ['eligibility', 'order', 'providerFields', 'attachmentReferences', 'attachmentContent', 'sourceCheckpoint'] },
  routeV1: { outputFields: ['recentRoleContent', 'userInput', 'hasVision'], selectionDependencies: ['status', 'sequence', 'turnAssociation', 'terminalState', 'boundary', 'exclude', 'limit', 'attachments'], invalidationDependencies: ['content', 'role', 'status', 'sequence', 'turnAssociation', 'attachments'] },
  hostedCheckpointV1: { outputFields: ['canonicalModelMessages', 'version', 'turn', 'outcome', 'receipt', 'hash', 'spillSource'], selectionDependencies: ['claim', 'checkpointStatus', 'currentReference', 'trackScoped'], invalidationDependencies: ['newCheckpointCommit'] }
} as const

export type ProjectionScopeV1 = keyof typeof PROJECTION_SPECS
export type MessageProjectionScopeV1 = 'chatMessageV1' | 'exportMessageV1' | 'searchCorpusV1' | 'apiBaselineV1'
export type ScopeProjectionV1 = ChatBodyV1 | Readonly<{ message: Message; sequence?: number }>

export function isAnonymousToolResultMessage(message: Readonly<{ id?: string; role: string; content?: unknown }>): boolean {
  return !message.id?.trim() && message.role === 'user' && Array.isArray(message.content) && message.content.length > 0 &&
    message.content.every((block) => !!block && typeof block === 'object' && !Array.isArray(block) &&
      (block as { type?: unknown }).type === 'tool_result')
}

const CHAT_BODY_OUTPUT_FIELDS = PROJECTION_SPECS.chatBodyV1.outputFields satisfies readonly (keyof Message)[]

function pickMessageFields<K extends keyof Message>(message: Message, fields: readonly K[]): Pick<Message, K> {
  const picked = {} as Pick<Message, K>
  for (const field of fields) picked[field] = message[field]
  return picked
}

/** Preserve the full stored DTO for message scopes; sequence remains explicit selection metadata. */
export function projectScopeV1(scope: 'chatBodyV1', message: Message, sequence?: number): ChatBodyV1
export function projectScopeV1(scope: MessageProjectionScopeV1, message: Message, sequence?: number): Readonly<{ message: Message; sequence?: number }>
export function projectScopeV1(scope: 'globalMessageSearchV1' | 'acceptedContextV1' | 'routeV1' | 'hostedCheckpointV1', message: Message, sequence?: number): never
export function projectScopeV1(scope: ProjectionScopeV1, message: Message, sequence?: number): ScopeProjectionV1 {
  if (scope === 'chatBodyV1') return projectChatBodyV1([message])[0]!
  if (scope === 'chatMessageV1' || scope === 'exportMessageV1' || scope === 'searchCorpusV1' || scope === 'apiBaselineV1') {
    return { message, ...(sequence === undefined ? {} : { sequence }) }
  }
  throw new Error(`PROJECTION_SCOPE_REQUIRES_DOMAIN_SOURCE:${scope}`)
}

/** Apply a message DTO scope to reader entries while preserving each row's selected sequence. */
export function projectMessageEntriesV1<T extends { message: Message; sequence: number }>(
  scope: MessageProjectionScopeV1,
  entries: readonly T[]
): T[] {
  return entries.map((entry) => ({ ...entry, ...projectScopeV1(scope, entry.message, entry.sequence) }))
}

/** ProjectionSpec.chatBodyV1: stable ordered chat body, excluding display and execution metadata. */
export function projectChatBodyV1(messages: readonly Message[]): ChatBodyV1[] {
  return messages.map((message) => pickMessageFields(message, CHAT_BODY_OUTPUT_FIELDS))
}

/** Join canonical History bodies to same-snapshot message identity and storage-authority facts. */
export function projectCanonicalChatBodyV1(
  canonicalMessages: readonly Readonly<{ id?: string; role: string; content?: unknown; timestamp?: number }>[],
  messageFacts: readonly Readonly<{ id: string; role: string; timestamp: number; sequence: number; queueScope: string;
    contentStorageState: 'legacy' | 'canonical-backed-dual-write' | 'canonical-backed-only'; writeMode: string | null; storedContent: string;
    storedContentLength?: number; storedContentDigest?: string }>[],
  afterSequence = -1,
  options: Readonly<{ allowLegacyBodyMismatch?: boolean }> = {},
): ChatBodyV1[] {
  const factsById = new Map(messageFacts.map((fact) => [fact.id, fact]))
  if (factsById.size !== messageFacts.length) throw new Error('CHAT_BODY_SOURCE_FACT_DUPLICATE')
  const seenIds = new Set<string>()
  const result: ChatBodyV1[] = []
  let previousSequence = afterSequence
  for (const canonical of canonicalMessages) {
    if (!canonical.id?.trim()) {
      if (isAnonymousToolResultMessage(canonical)) continue
      throw new Error('CHAT_BODY_MESSAGE_ID_MISSING')
    }
    const fact = factsById.get(canonical.id)
    if (!fact) throw new Error('CHAT_BODY_SOURCE_FACT_MISSING')
    if (fact.queueScope !== 'desktop') continue
    if (seenIds.has(fact.id) || !Number.isSafeInteger(fact.sequence) || fact.sequence <= previousSequence ||
      canonical.role !== fact.role || (canonical.timestamp !== undefined && canonical.timestamp !== fact.timestamp) || !Number.isSafeInteger(fact.timestamp) ||
      (canonical.role !== 'user' && canonical.role !== 'assistant')) {
      throw new Error('CHAT_BODY_IDENTITY_MISMATCH')
    }
    const projectedContent = canonicalMessageBodyText(canonical.content)
    if (fact.contentStorageState === 'canonical-backed-only' && (fact.writeMode !== 'canonical' || fact.storedContent !== '')) {
      throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
    }
    if (fact.contentStorageState === 'canonical-backed-dual-write' &&
      (fact.writeMode !== 'canonical' || projectedContent !== fact.storedContent)) {
      throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
    }
    if (fact.contentStorageState === 'legacy' && projectedContent !== fact.storedContent && !options.allowLegacyBodyMismatch) {
      throw new Error('CHAT_BODY_AUTHORITY_MISMATCH')
    }
    result.push({ id: fact.id, role: fact.role as Message['role'],
      content: fact.contentStorageState === 'legacy' ? fact.storedContent : projectedContent,
      timestamp: fact.timestamp })
    seenIds.add(fact.id)
    previousSequence = fact.sequence
  }
  return result
}

/** Match canonical model content to the legacy chat body mirror without exposing non-text execution blocks. */
export function canonicalMessageBodyText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new Error('CHAT_BODY_IDENTITY_MISMATCH')
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('CHAT_BODY_IDENTITY_MISMATCH')
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') text += record.text
    else if (record.type === 'thinking' && typeof record.thinking === 'string') continue
    else if (record.type === 'image' && isClaudeBase64ImageSource(record.source)) continue
    else if (record.type === 'tool_use' && isClaudeToolUseBlock(record)) continue
    else throw new Error('CHAT_BODY_IDENTITY_MISMATCH')
  }
  return text
}

function isClaudeBase64ImageSource(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return source.type === 'base64' && typeof source.data === 'string' &&
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(source.media_type))
}

function isClaudeToolUseBlock(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string' && !!value.id.trim() && typeof value.name === 'string' && !!value.name.trim() &&
    !!value.input && typeof value.input === 'object' && !Array.isArray(value.input) &&
    (value.thought_signature === undefined || typeof value.thought_signature === 'string')
}

export function encodeChatBodyV1(messages: readonly Message[]): string {
  return JSON.stringify(projectChatBodyV1(messages))
}

export function areChatBodiesV1Equal(left: readonly Message[], right: readonly Message[]): boolean {
  return encodeChatBodyV1(left) === encodeChatBodyV1(right)
}
