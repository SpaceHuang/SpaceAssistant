import { describe, expect, it } from 'vitest'
import { encodeChatBodyV1, projectCanonicalChatBodyV1, PROJECTION_SPECS, projectScopeV1 } from './projectionSpec'
import type { Message } from '../../../src/shared/domainTypes'
import type { ProjectionMessageFact } from './projectionSource'

describe('ProjectionSpec.chatBodyV1', () => {
  it('binds canonical History bodies to same-snapshot message facts and enforces body authority', () => {
    const facts: ProjectionMessageFact[] = [
      { id: 'legacy', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'legacy body' },
      { id: 'dual', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'canonical-backed-dual-write', writeMode: 'canonical', storedContent: 'dual body' },
      { id: 'canonical', role: 'user', timestamp: 3, sequence: 2, queueScope: 'desktop', contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' },
    ]
    const canonical = [
      { id: 'legacy', role: 'user' as const, content: 'legacy body', timestamp: 1 },
      { id: 'dual', role: 'assistant' as const, content: 'dual body', timestamp: 2 },
      { id: 'canonical', role: 'user' as const, content: 'canonical body', timestamp: 3 },
    ]
    expect(projectCanonicalChatBodyV1(canonical, facts)).toEqual([
      { id: 'legacy', role: 'user', content: 'legacy body', timestamp: 1 },
      { id: 'dual', role: 'assistant', content: 'dual body', timestamp: 2 },
      { id: 'canonical', role: 'user', content: 'canonical body', timestamp: 3 },
    ])
    expect(() => projectCanonicalChatBodyV1([{ ...canonical[1]!, content: 'stale dual copy' }], facts)).toThrow('CHAT_BODY_AUTHORITY_MISMATCH')
    expect(() => projectCanonicalChatBodyV1([{ ...canonical[1]!, id: 'unknown' }], facts)).toThrow('CHAT_BODY_SOURCE_FACT_MISSING')
    expect(() => projectCanonicalChatBodyV1([{ ...canonical[1]!, timestamp: 99 }], facts)).toThrow('CHAT_BODY_IDENTITY_MISMATCH')
    expect(() => projectCanonicalChatBodyV1([{ ...canonical[1]!, role: 'user' as const }], facts)).toThrow('CHAT_BODY_IDENTITY_MISMATCH')
  })

  it('uses the same-snapshot message timestamp when canonical History omits it', () => {
    const fact: ProjectionMessageFact = { id: 'history-message', role: 'user', timestamp: 11, sequence: 0, queueScope: 'desktop',
      contentStorageState: 'legacy', writeMode: null, storedContent: 'body' }
    expect(projectCanonicalChatBodyV1([{ id: fact.id, role: fact.role, content: 'body' }], [fact]))
      .toEqual([{ id: fact.id, role: fact.role, content: 'body', timestamp: fact.timestamp }])
  })

  it('projects canonical model content blocks using the chat display text rules', () => {
    const facts: ProjectionMessageFact[] = [
      { id: 'blocks', role: 'assistant', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'hello' },
      { id: 'legacy-blocks', role: 'assistant', timestamp: 2, sequence: 1, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'hello' },
    ]
    expect(projectCanonicalChatBodyV1([
      { id: 'blocks', role: 'assistant', timestamp: 1, content: [
        { type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'private' },
      ] },
      { id: 'legacy-blocks', role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'hello' }] },
    ], facts)).toEqual([
      { id: 'blocks', role: 'assistant', content: 'hello', timestamp: 1 },
      { id: 'legacy-blocks', role: 'assistant', content: 'hello', timestamp: 2 },
    ])
  })

  it('rejects malformed image and tool blocks instead of silently dropping unknown content', () => {
    const facts: ProjectionMessageFact[] = [
      { id: 'assistant', role: 'assistant', timestamp: 1, sequence: 0, queueScope: 'desktop', contentStorageState: 'legacy', writeMode: null, storedContent: 'hello' },
    ]
    for (const content of [
      [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'url', url: 'https://example.test/image' } }],
      [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tool-1', name: 'lookup' }],
    ]) {
      expect(() => projectCanonicalChatBodyV1([{ id: 'assistant', role: 'assistant', timestamp: 1, content }], facts))
        .toThrow('CHAT_BODY_IDENTITY_MISMATCH')
    }
  })

  it('registers output, selection dependencies, and invalidation dependencies for every contract scope', () => {
    expect(PROJECTION_SPECS).toEqual({
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
    })
  })

  it('projects DTO and sequence scopes without dropping fields or conflating selection metadata', () => {
    const message: Message = { id: 'm1', sessionId: 's1', role: 'user', content: 'body', timestamp: 1, status: 'queued', schemaVersion: 1 }
    expect(projectScopeV1('chatMessageV1', message, 9)).toEqual({ message, sequence: 9 })
    expect(projectScopeV1('chatBodyV1', message, 9)).toEqual({ id: 'm1', role: 'user', content: 'body', timestamp: 1 })
    expect(projectScopeV1('exportMessageV1', message, 9)).toEqual({ message, sequence: 9 })
    expect(() => projectScopeV1('acceptedContextV1', message, 9)).toThrow('PROJECTION_SCOPE_REQUIRES_DOMAIN_SOURCE:acceptedContextV1')
  })

  it('excludes non-body Message fields from the stable digest', () => {
    const base = [{ id: 'm1', sessionId: 's1', role: 'assistant' as const, content: 'body', timestamp: 1, status: 'completed' as const, schemaVersion: 1 }]
    expect(encodeChatBodyV1([{ ...base[0]!, status: 'failed' }])).toBe(encodeChatBodyV1(base))
    expect(encodeChatBodyV1([{ ...base[0]!, content: 'edited' }])).not.toBe(encodeChatBodyV1(base))
  })

  it('keeps chat-body digest stable for every non-body DTO field while preserving identity/body dependencies', () => {
    const base: Message = { id: 'm1', sessionId: 's1', role: 'assistant', content: 'body', timestamp: 1, status: 'completed', schemaVersion: 1 }
    const nonBodyMutations: Array<[string, Partial<Message>]> = [
      ['sessionId', { sessionId: 's2' }], ['status', { status: 'failed' }], ['schemaVersion', { schemaVersion: 2 }],
      ['attachments', { attachments: [{ id: 'a', fileName: 'f.png', mimeType: 'image/png', byteLength: 1, stagingKey: 'a' }] }],
      ['imagesDeliveredToApi', { imagesDeliveredToApi: true }],
      ['toolUse', { toolUse: { id: 'u', toolName: 'read_file', toolType: 'builtin', parameters: {}, status: 'completed', timestamp: 1 } }],
      ['toolCalls', { toolCalls: [{ id: 'c', toolName: 'read_file', input: {}, status: 'completed' }] }],
      ['thinking', { thinking: { content: 'thought', isVisible: true } }],
      ['contentSegments', { contentSegments: [{ type: 'text', text: 'segment' }] }],
      ['skillHints', { skillHints: [{ id: 'h', text: 'hint', shownAt: 1 }] }],
      ['activity', { activity: [] }]
    ]
    for (const [field, mutation] of nonBodyMutations) {
      expect(encodeChatBodyV1([{ ...base, ...mutation }]), field).toBe(encodeChatBodyV1([base]))
    }
    for (const mutation of [{ id: 'm2' }, { role: 'user' as const }, { content: 'edited' }, { timestamp: 2 }]) {
      expect(encodeChatBodyV1([{ ...base, ...mutation }])).not.toBe(encodeChatBodyV1([base]))
    }
  })
})
