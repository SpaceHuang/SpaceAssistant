import { describe, expect, it } from 'vitest'
import {
  buildClaudeToolChatMessages,
  buildUserMessageContent,
  shouldHydrateImagesForMessage,
  trimClaudeToolChatMessages
} from './claudeToolHistory'
import type { ChatImageAttachment, Message } from './domainTypes'

function userMsg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content,
    timestamp: 1,
    status: 'completed',
    ...extra
  }
}

function assistantMsg(id: string, content: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    content,
    timestamp: 2,
    status: 'completed'
  }
}

function imageAttachment(fileName: string): ChatImageAttachment {
  return {
    id: `att-${fileName}`,
    stagingKey: `chat-attachments/s1/${fileName}`,
    fileName,
    mimeType: 'image/png',
    byteLength: 100
  }
}

describe('buildUserMessageContent', () => {
  const attachment = imageAttachment('pic.png')
  const resolveImage = () => ({ mimeType: 'image/png', data: 'base64data' })

  it('returns plain text when there are no attachments', () => {
    expect(
      buildUserMessageContent('hello', undefined, {
        hydrationMode: 'full',
        resolveImage
      })
    ).toBe('hello')
  })

  it('full mode includes image blocks', () => {
    const result = buildUserMessageContent('hello', [attachment], {
      hydrationMode: 'full',
      resolveImage
    })
    expect(result).toEqual([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'base64data' }
      }
    ])
  })

  it('placeholder mode appends historical image text', () => {
    const result = buildUserMessageContent('hello', [attachment], {
      hydrationMode: 'text-placeholder-only',
      resolveImage: () => null
    })
    expect(result).toBe('hello\n[此前发送的图片: pic.png]')
  })

  it('full mode falls back to stale placeholder when resolveImage returns null', () => {
    const result = buildUserMessageContent('hello', [attachment], {
      hydrationMode: 'full',
      resolveImage: () => null
    })
    expect(result).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '[图片附件已失效: pic.png]' }
    ])
  })
})

describe('shouldHydrateImagesForMessage', () => {
  it('returns true only for the current user message with attachments', () => {
    const msg = userMsg('u1', 'hi', { attachments: [imageAttachment('a.png')] })
    expect(shouldHydrateImagesForMessage(msg, 'u1')).toBe(true)
    expect(shouldHydrateImagesForMessage(msg, 'u2')).toBe(false)
  })

  it('returns false when there are no attachments', () => {
    expect(shouldHydrateImagesForMessage(userMsg('u1', 'hi'), 'u1')).toBe(false)
  })
})

describe('buildClaudeToolChatMessages attachments', () => {
  it('hydrates current turn fully and uses placeholder for history', () => {
    const history = userMsg('u1', 'earlier', { attachments: [imageAttachment('old.png')] })
    const current = userMsg('u2', 'now', { attachments: [imageAttachment('new.png')] })
    const resolveImage = (a: ChatImageAttachment) => ({
      mimeType: a.mimeType,
      data: `data-for-${a.fileName}`
    })

    const api = buildClaudeToolChatMessages([history, current], {
      currentUserMessageId: 'u2',
      resolveImage
    })

    expect(api).toHaveLength(2)
    expect(typeof api[0]!.content).toBe('string')
    expect(api[0]!.content).toContain('[此前发送的图片: old.png]')
    expect(api[1]!.content).toEqual([
      { type: 'text', text: 'now' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'data-for-new.png' }
      }
    ])
  })

  it('uses placeholder when imagesDeliveredToApi prevents re-hydrate', () => {
    const current = userMsg('u1', 'again', {
      attachments: [imageAttachment('sent.png')],
      imagesDeliveredToApi: true
    })

    const api = buildClaudeToolChatMessages([current], {
      currentUserMessageId: 'u1',
      resolveImage: () => ({ mimeType: 'image/png', data: 'should-not-be-used' })
    })

    expect(api).toHaveLength(1)
    expect(typeof api[0]!.content).toBe('string')
    expect(api[0]!.content).toContain('[此前发送的图片: sent.png]')
    expect(api[0]!.content).not.toContain('should-not-be-used')
  })
})

describe('trimClaudeToolChatMessages', () => {
  it('returns all messages when under limit', () => {
    const messages = [userMsg('u1', 'hello'), assistantMsg('a1', 'hi')]
    const api = buildClaudeToolChatMessages(messages)
    expect(trimClaudeToolChatMessages(api, 10)).toEqual(api)
  })

  it('keeps the most recent messages when over limit', () => {
    const api = Array.from({ length: 5 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`
    }))
    const trimmed = trimClaudeToolChatMessages(api, 3)
    expect(trimmed).toHaveLength(3)
    expect(trimmed.map((m) => m.content)).toEqual(['m2', 'm3', 'm4'])
  })

  it('drops leading assistant and orphaned tool_result after slice', () => {
    const api = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant' as const, content: 'done' },
      { role: 'user' as const, content: 'next' }
    ]
    const trimmed = trimClaudeToolChatMessages(api, 2)
    expect(trimmed).toHaveLength(1)
    expect(trimmed[0]!.role).toBe('user')
    expect(trimmed[0]!.content).toBe('next')
  })

  it('starts with a plain user message after trimming tool_result orphans', () => {
    const api = [
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'user' as const, content: 'continue' },
      { role: 'assistant' as const, content: 'sure' }
    ]
    const trimmed = trimClaudeToolChatMessages(api, 2)
    expect(trimmed).toHaveLength(2)
    expect(trimmed[0]!.content).toBe('continue')
  })

  it('uses placeholder for completed assistant with empty content and no tools', () => {
    const messages = [
      userMsg('u1', 'hello'),
      {
        ...assistantMsg('a1', ''),
        status: 'completed' as const,
        toolCalls: undefined
      }
    ]
    const api = buildClaudeToolChatMessages(messages)
    expect(api).toHaveLength(2)
    expect(api[1]!.content).toBe(' ')
  })
})
