import { describe, expect, it } from 'vitest'
import {
  buildClaudeToolChatMessages,
  buildToolResultBlock,
  buildUserMessageContent,
  trimClaudeToolChatMessages
} from './claudeToolHistory'
import type { ChatImageAttachment, Message, ToolCallRecord } from './domainTypes'
import { SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './toolResultPairing'

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

describe('buildClaudeToolChatMessages attachments (strategy A)', () => {
  it('full-hydrates historical image messages on later turns', () => {
    const history = userMsg('u1', 'earlier', { attachments: [imageAttachment('old.png')] })
    const current = userMsg('u2', 'now')
    const resolveImage = (a: ChatImageAttachment) => ({
      mimeType: a.mimeType,
      data: `data-for-${a.fileName}`
    })

    const api = buildClaudeToolChatMessages([history, current], {
      currentUserMessageId: 'u2',
      resolveImage
    })

    expect(api).toHaveLength(2)
    expect(api[0]!.content).toEqual([
      { type: 'text', text: 'earlier' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'data-for-old.png' }
      }
    ])
    expect(api[1]!.content).toBe('now')
  })

  it('ignores imagesDeliveredToApi and still full-hydrates', () => {
    const history = userMsg('u1', 'earlier', {
      attachments: [imageAttachment('sent.png')],
      imagesDeliveredToApi: true
    })
    const current = userMsg('u2', 'follow-up')

    const api = buildClaudeToolChatMessages([history, current], {
      currentUserMessageId: 'u2',
      resolveImage: () => ({ mimeType: 'image/png', data: 'still-hydrated' })
    })

    expect(api).toHaveLength(2)
    expect(api[0]!.content).toEqual([
      { type: 'text', text: 'earlier' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'still-hydrated' }
      }
    ])
  })

  it('uses stale text when staging is missing', () => {
    const history = userMsg('u1', 'earlier', { attachments: [imageAttachment('gone.png')] })
    const api = buildClaudeToolChatMessages([history], {
      currentUserMessageId: 'u1',
      resolveImage: () => null
    })

    expect(api).toHaveLength(1)
    expect(api[0]!.content).toEqual([
      { type: 'text', text: 'earlier' },
      { type: 'text', text: '[图片附件已失效: gone.png]' }
    ])
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

  it('15: drops orphaned tool_result when slice cuts use/result pair', () => {
    const api = [
      { role: 'user' as const, content: 'old' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 't-cut', name: 'read_file', input: {} }]
      },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't-cut', content: 'ok' }] },
      { role: 'user' as const, content: 'keep' }
    ]
    const trimmed = trimClaudeToolChatMessages(api, 2)
    expect(trimmed).toHaveLength(1)
    expect(trimmed[0]!.content).toBe('keep')
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

function toolCall(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id'>): ToolCallRecord {
  return {
    toolName: 'read_file',
    input: {},
    status: 'completed',
    riskLevel: 'low',
    ...overrides
  }
}

describe('buildToolResultBlock', () => {
  it('9: marks missing result as synthetic error placeholder', () => {
    const block = buildToolResultBlock(toolCall({ id: 't1' }))
    expect(block.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
    expect(block.isError).toBe(true)
  })

  it('10: marks failed result with isError', () => {
    const block = buildToolResultBlock(
      toolCall({ id: 't1', result: { success: false, error: 'permission denied' } })
    )
    expect(block.content).toBe('permission denied')
    expect(block.isError).toBe(true)
  })
})

describe('buildClaudeToolChatMessages toolCalls pairing', () => {
  it('emits tool_use and tool_result with matching ids and is_error for missing result', () => {
    const messages: Message[] = [
      userMsg('u1', 'read file'),
      {
        ...assistantMsg('a1', ''),
        toolCalls: [toolCall({ id: 'toolu_abc', result: undefined })]
      }
    ]
    const api = buildClaudeToolChatMessages(messages)
    expect(api).toHaveLength(3)
    const assistantBlocks = api[1]!.content as Array<{ type: string; id?: string }>
    const resultBlocks = api[2]!.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content: string }>
    expect(assistantBlocks.some((b) => b.type === 'tool_use' && b.id === 'toolu_abc')).toBe(true)
    expect(resultBlocks[0]?.tool_use_id).toBe('toolu_abc')
    expect(resultBlocks[0]?.is_error).toBe(true)
    expect(resultBlocks[0]?.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
  })
})
