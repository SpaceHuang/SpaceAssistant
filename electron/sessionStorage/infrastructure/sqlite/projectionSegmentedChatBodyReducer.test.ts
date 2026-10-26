import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import type { ProjectionHistoryChunkEvent, ProjectionMessageFact } from '../../domain/projectionSource'
import { createProjectionScopeHistoryReducer } from './projectionScopeHistoryReducer'
import { reduceSegmentedChatBodyContext } from './projectionSegmentedChatBodyReducer'

describe('segmented chat body reducer', () => {
  it('projects streamed batches in order and persists the final canonical cursor', async () => {
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const body = 'a large dual-write body'
    const facts: ProjectionMessageFact[] = [
      { id: 'stream-user', role: 'user', timestamp: 1, sequence: 4, queueScope: 'desktop',
        contentStorageState: 'canonical-backed-dual-write', writeMode: 'canonical', storedContent: '',
        storedContentLength: body.length, storedContentDigest: createHash('sha256').update(body, 'utf8').digest('hex') },
      { id: 'stream-assistant', role: 'assistant', timestamp: 2, sequence: 5, queueScope: 'desktop',
        contentStorageState: 'canonical-backed-only', writeMode: 'canonical', storedContent: '' },
    ]
    const event: ProjectionHistoryChunkEvent = { invocationId: 'stream-inv', sequence: 7, eventId: 'stream-context',
      idempotencyKey: 'stream-context', turnId: 'stream-turn', schemaVersion: 1, kind: 'invocation-context-committed',
      sessionSequence: 11, commitOrder: 1, createdAt: 1, payloadJson: '' }
    async function* messages() {
      yield { role: 'user', id: 'stream-user', content: body, timestamp: 1 }
      yield { role: 'assistant', id: 'stream-assistant', content: [{ type: 'text', text: 'reply' }], timestamp: 2 }
    }
    const output: unknown[] = []
    const folded = await reduceSegmentedChatBodyContext({ stateJson: createProjectionScopeHistoryReducer().createState(scopeKey),
      event, messages: messages(), messageCount: 2, facts, scopeKey, onProjectedMessage: async (message) => output.push(message) })

    expect(output).toEqual([
      { id: 'stream-user', role: 'user', content: body, timestamp: 1 },
      { id: 'stream-assistant', role: 'assistant', content: 'reply', timestamp: 2 },
    ])
    expect(JSON.parse(folded.stateJson)).toMatchObject({ lastSequence: 5,
      canonicalStateJson: expect.stringContaining('"lastSequence":7') })
  })

  it('rejects streamed dual-write content that differs from its compact authority digest', async () => {
    const scopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: 3 })
    const event: ProjectionHistoryChunkEvent = { invocationId: 'stream-inv', sequence: 1, eventId: 'stream-context',
      idempotencyKey: 'stream-context', turnId: 'stream-turn', schemaVersion: 1, kind: 'invocation-context-committed',
      sessionSequence: 1, commitOrder: 1, createdAt: 1, payloadJson: '' }
    const fact: ProjectionMessageFact = { id: 'stream-user', role: 'user', timestamp: 1, sequence: 0, queueScope: 'desktop',
      contentStorageState: 'canonical-backed-dual-write', writeMode: 'canonical', storedContent: '',
      storedContentLength: 4, storedContentDigest: createHash('sha256').update('body', 'utf8').digest('hex') }
    async function* messages() { yield { role: 'user', id: 'stream-user', content: 'evil', timestamp: 1 } }
    await expect(reduceSegmentedChatBodyContext({ stateJson: createProjectionScopeHistoryReducer().createState(scopeKey),
      event, messages: messages(), messageCount: 1, facts: [fact], scopeKey, onProjectedMessage: async () => undefined }))
      .rejects.toThrow('CHAT_BODY_AUTHORITY_MISMATCH')
  })
})
