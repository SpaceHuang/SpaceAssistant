import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import { collectFailureLookupIds, loadTurnFailureReasons } from './turnFailureHydration'

function message(over: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    sessionId: 's1',
    content: '',
    timestamp: 1,
    status: 'completed',
    schemaVersion: 1,
    ...over
  }
}

function stubApi(chatGetTurnErrors?: unknown): { chatGetTurnErrors: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(chatGetTurnErrors as never)
  vi.stubGlobal('window', { api: chatGetTurnErrors === undefined ? {} : { chatGetTurnErrors: fn } })
  return { chatGetTurnErrors: fn }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('collectFailureLookupIds', () => {
  it('只收集失败的 assistant 消息并去重', () => {
    expect(
      collectFailureLookupIds([
        message({ id: 'u1', role: 'user' }),
        message({ id: 'a1', role: 'assistant', status: 'failed' }),
        message({ id: 'a1', role: 'assistant', status: 'failed' }),
        message({ id: 'a2', role: 'assistant', status: 'streaming' }),
        message({ id: 'a3', role: 'assistant', status: 'completed' }),
        message({ id: 'a4', role: 'assistant', status: 'failed' })
      ])
    ).toEqual(['a1', 'a4'])
  })
})

describe('loadTurnFailureReasons', () => {
  it('按 assistantMessageId 回查并把原因映射成 messageId 索引', async () => {
    const { chatGetTurnErrors } = stubApi(async () => [
      { assistantMessageId: 'a1', message: '会话模型「x」当前不可用（未知模型）' }
    ])

    await expect(
      loadTurnFailureReasons([message({ id: 'a1', role: 'assistant', status: 'failed' })])
    ).resolves.toEqual({ a1: '会话模型「x」当前不可用（未知模型）' })
    expect(chatGetTurnErrors).toHaveBeenCalledWith({ assistantMessageIds: ['a1'] })
  })

  it('没有失败消息时不调用主进程', async () => {
    const { chatGetTurnErrors } = stubApi(async () => [])

    await expect(loadTurnFailureReasons([message({ id: 'u1', role: 'user' })])).resolves.toEqual({})
    expect(chatGetTurnErrors).not.toHaveBeenCalled()
  })

  it('主进程未提供该通道时静默返回空结果', async () => {
    stubApi()

    await expect(
      loadTurnFailureReasons([message({ id: 'a1', role: 'assistant', status: 'failed' })])
    ).resolves.toEqual({})
  })

  it('回查失败时不影响消息加载', async () => {
    stubApi(async () => {
      throw new Error('IPC down')
    })

    await expect(
      loadTurnFailureReasons([message({ id: 'a1', role: 'assistant', status: 'failed' })])
    ).resolves.toEqual({})
  })

  it('忽略空白原因与未请求的消息', async () => {
    stubApi(async () => [
      { assistantMessageId: 'a1', message: '   ' },
      { assistantMessageId: 'a2', message: ' 已知原因 ' },
      { assistantMessageId: 'other', message: '不该出现' }
    ])

    await expect(
      loadTurnFailureReasons([
        message({ id: 'a1', role: 'assistant', status: 'failed' }),
        message({ id: 'a2', role: 'assistant', status: 'failed' })
      ])
    ).resolves.toEqual({ a2: '已知原因' })
  })
})
