import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import {
  SESSION_META_TITLE_GENERATED,
  SESSION_META_TITLE_USER_CUSTOM,
  scheduleSessionTitleSuggestion
} from './sessionTitleSuggest'
import type { Session } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SESSION_SKILLS_STATE } from '../src/shared/domainTypes'
import type { AppDatabase } from './database'

const mockUpdateSession = vi.fn()
const mockCreateAnthropicClient = vi.fn()
const mockGetApiKey = vi.fn()

vi.mock('./database', () => ({
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  getSession: vi.fn(),
  getMessages: vi.fn(() => [])
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

function stubSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: '用户标题',
    preview: '',
    model: 'claude-sonnet',
    temperature: 0.7,
    maxTokens: 4096,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 3,
    skillsState: { ...DEFAULT_SESSION_SKILLS_STATE },
    metadata: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ...overrides
  }
}

function makeDb(session: Session): AppDatabase {
  return {
    data: { sessions: [session], messages: [], config: {} }
  } as unknown as AppDatabase
}

function makeSender(): WebContents {
  return { send: vi.fn() } as unknown as WebContents
}

describe('scheduleSessionTitleSuggestion manual title mutex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetApiKey.mockResolvedValue('test-key')
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '自动标题' }]
        })
      }
    })
  })

  it('skips LLM and updateSession when titleUserCustom is true', async () => {
    const session = stubSession({
      metadata: { [SESSION_META_TITLE_USER_CUSTOM]: true }
    })
    const db = makeDb(session)
    const sender = makeSender()

    scheduleSessionTitleSuggestion({
      db,
      sender,
      sessionId: session.id,
      model: session.model,
      messagesForApi: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
        { role: 'user', content: '继续' },
        { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
        { role: 'user', content: '再问' },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }] }
      ],
      getApiKey: mockGetApiKey
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(mockCreateAnthropicClient).not.toHaveBeenCalled()
    expect(mockUpdateSession).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('writes generated title when no user custom flag', async () => {
    const session = stubSession({ name: '', metadata: {} })
    const db = makeDb(session)
    const sender = makeSender()
    const updated = stubSession({
      name: '自动标题',
      metadata: { [SESSION_META_TITLE_GENERATED]: true }
    })
    mockUpdateSession.mockReturnValue(updated)

    scheduleSessionTitleSuggestion({
      db,
      sender,
      sessionId: session.id,
      model: session.model,
      messagesForApi: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
        { role: 'user', content: '继续' },
        { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
        { role: 'user', content: '再问' },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }] }
      ],
      getApiKey: mockGetApiKey
    })

    await vi.waitFor(() => {
      expect(mockUpdateSession).toHaveBeenCalled()
    })
    expect(mockUpdateSession.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        name: '自动标题',
        metadata: expect.objectContaining({
          [SESSION_META_TITLE_GENERATED]: true
        })
      })
    )
    expect(sender.send).toHaveBeenCalledWith('session:title-generated', { session: updated })
  })
})
