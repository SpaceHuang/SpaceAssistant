import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildToolChatMessagesFromSource } from './chatMessageBuild'
import { stageChatImage } from './chatAttachmentManager'
import type { Message } from '../src/shared/domainTypes'

/** 1x1 PNG */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('buildToolChatMessagesFromSource', () => {
  let tmpUserData: string
  const sessionId = 'sess-build-1'

  beforeEach(async () => {
    tmpUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-chat-build-'))
  })

  afterEach(async () => {
    await fs.rm(tmpUserData, { recursive: true, force: true })
  })

  it('preloads attachments from historical user messages', async () => {
    const staged = await stageChatImage({
      userDataDir: tmpUserData,
      sessionId,
      fileName: 'old.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64
    })
    expect('error' in staged).toBe(false)
    if ('error' in staged) return

    const history: Message = {
      id: 'u1',
      sessionId,
      role: 'user',
      content: 'first with image',
      timestamp: 1,
      status: 'completed',
      attachments: [staged]
    }
    const current: Message = {
      id: 'u2',
      sessionId,
      role: 'user',
      content: 'follow up',
      timestamp: 2,
      status: 'completed'
    }

    const api = await buildToolChatMessagesFromSource({
      userDataDir: tmpUserData,
      sourceMessages: [history, current],
      currentUserMessageId: 'u2'
    })

    expect(api).toHaveLength(2)
    const firstContent = api[0]!.content
    expect(Array.isArray(firstContent)).toBe(true)
    const blocks = firstContent as Array<{ type: string; source?: { data?: string } }>
    const imageBlock = blocks.find((b) => b.type === 'image')
    expect(imageBlock?.source?.data).toBe(TINY_PNG_BASE64)
  })
})
