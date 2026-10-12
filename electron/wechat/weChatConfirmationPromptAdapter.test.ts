import { describe, expect, it, vi } from 'vitest'
import { MessageBuilder } from '@wechatbot/wechatbot'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createMockWeChatBot } from './__mocks__/wechatBotMock'
import { WeChatConfirmationPromptAdapter, WECHAT_CONFIRMATION_QUOTE_CONTRACT, wrapFetchForLosslessWeChatMessageId } from './weChatConfirmationPromptAdapter'
import { createWeChatQuoteMarker } from './weChatQuoteBinding'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('WeChatConfirmationPromptAdapter protocol', () => {
  it('preserves int64 sendmessage message_id digits as a string before the SDK JSON parser runs', async () => {
    const exactId = '17917655126112345'
    const fetchImpl = vi.fn(async () => new Response(`{"ret":0,"message_id":${exactId}}`))
    const fetchWithLosslessIds = wrapFetchForLosslessWeChatMessageId(fetchImpl as typeof fetch)

    const response = await fetchWithLosslessIds('https://ilink.test/ilink/bot/sendmessage', { method: 'POST' })

    await expect(response.json()).resolves.toEqual({ ret: 0, message_id: exactId })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not rewrite message_id-looking text or responses from other endpoints', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(
      typeof input === 'string' && input.includes('/sendmessage')
        ? '{"ret":0,"errmsg":"literal \\"message_id\\":17917655126112345"}'
        : '{"message_id":17917655126112345}'
    ))
    const fetchWithLosslessIds = wrapFetchForLosslessWeChatMessageId(fetchImpl as typeof fetch)

    const sendResponse = await fetchWithLosslessIds('https://ilink.test/ilink/bot/sendmessage', { method: 'POST' })
    const otherResponse = await fetchWithLosslessIds('https://ilink.test/ilink/bot/getupdates', { method: 'POST' })

    await expect(sendResponse.json()).resolves.toEqual({ ret: 0, errmsg: 'literal "message_id":17917655126112345' })
    await expect(otherResponse.json()).resolves.toEqual({ message_id: 17917655126112345 })
  })

  it('checks the pinned SDK protocol: sendRaw discards the send response and parser drops ref msg_id', () => {
    const require = createRequire(import.meta.url)
    const packageRoot = resolve(dirname(require.resolve('@wechatbot/wechatbot')), '..')
    const sdkPackage = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version: string }
    const senderSource = readFileSync(resolve(packageRoot, 'dist/messaging/sender.js'), 'utf8')
    const parserSource = readFileSync(resolve(packageRoot, 'dist/message/parser.js'), 'utf8')
    const apiSource = readFileSync(resolve(packageRoot, 'dist/protocol/api.js'), 'utf8')
    const apiDeclarations = readFileSync(resolve(packageRoot, 'dist/protocol/api.d.ts'), 'utf8')
    const clientSource = readFileSync(resolve(packageRoot, 'dist/core/client.js'), 'utf8')
    const apiTypes = readFileSync(resolve(packageRoot, 'dist/protocol/types.d.ts'), 'utf8')
    expect(sdkPackage.version).toBe(WECHAT_CONFIRMATION_QUOTE_CONTRACT.sdkVersion)
    expect(senderSource).toContain('await this.api.sendMessage(baseUrl, token, msg)')
    expect(apiSource).toContain("return this.http.apiPost(baseUrl, '/ilink/bot/sendmessage'")
    expect(clientSource).toContain('this.api = new ILinkApi(this.http, options.botAgent)')
    expect(apiDeclarations).toContain('sendMessage(baseUrl: string, token: string, msg: SendMessageRequest[\'msg\']): Promise<Record<string, unknown>>')
    expect(apiTypes).toContain('export interface RefMessage')
    expect(apiTypes).not.toMatch(/export interface RefMessage\s*\{[^}]*message_id/s)
    expect(apiTypes).toContain('message_item?: WireMessageItem')
    expect(parserSource).toContain('ref.message_item.text_item?.text')
    expect(parserSource).not.toContain('ref.message_item.msg_id')
  })

  it('waits for a matching BOT echo after send ack and binds the server message_id', async () => {
    const bot = createMockWeChatBot()
    bot.sendRaw.mockImplementationOnce(async () => undefined)
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    const resultPromise = adapter.send('owner', 'prompt')
    await vi.waitFor(() => expect(bot.sendRaw).toHaveBeenCalledOnce())
    const payload = bot.sendRaw.mock.calls[0]![0] as { text?: string; client_id?: string }
    await Promise.resolve()
    expect(adapter.pendingCount).toBe(1)
    expect(payload.text).toBe('prompt')
    adapter.observeWireMessages([
      { client_id: payload.client_id, to_user_id: 'someone-else', message_type: 2, message_id: 1840 },
      { client_id: payload.client_id, to_user_id: 'owner', message_type: 1, message_id: 1841 },
      { client_id: 'different-client', to_user_id: 'owner', message_type: 2, message_id: 1842 }
    ])
    expect(adapter.pendingCount).toBe(1)
    adapter.observeWireMessages([{ client_id: payload.client_id, to_user_id: 'owner', message_type: 2, message_id: 1843 }])
    await expect(resultPromise).resolves.toMatchObject({
      kind: 'sent', sendCall: 'fulfilled', delivery: 'bound',
      binding: { kind: 'message-id', value: '1843', clientId: payload.client_id }
    })
    expect(bot.poller.listenerCount('messages')).toBe(0)
    expect(bot.sendRaw).toHaveBeenCalledOnce()
    expect(adapter.pendingCount).toBe(0)
    adapter.close()
  })

  it('binds the message_id returned by sendmessage without waiting for a poller BOT echo', async () => {
    const bot = createMockWeChatBot()
    const sendMessage = vi.fn(async () => ({ message_id: 'server-message-301', ret: 0 }))
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage }
    })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })

    await expect(adapter.send('owner', 'prompt')).resolves.toMatchObject({
      kind: 'sent', sendCall: 'fulfilled', delivery: 'bound',
      binding: { kind: 'message-id', value: 'server-message-301' }
    })
    expect(sendMessage).toHaveBeenCalledWith('https://ilink.test', 'test-token', expect.objectContaining({
      to_user_id: 'owner', client_id: expect.stringMatching(/^spaceassistant-confirm:/)
    }))
    expect(bot.sendRaw).not.toHaveBeenCalled()
    expect(adapter.pendingCount).toBe(0)
    adapter.close()
  })

  it('binds an exact int64 message_id returned through the lossless SDK fetch shim', async () => {
    const exactId = '17917655126112345'
    const bot = createMockWeChatBot()
    const fetchWithLosslessIds = wrapFetchForLosslessWeChatMessageId(vi.fn(async () => new Response(
      `{"ret":0,"message_id":${exactId}}`
    )) as typeof fetch)
    const sendMessage = vi.fn(async () => {
      const response = await fetchWithLosslessIds('https://ilink.test/ilink/bot/sendmessage', { method: 'POST' })
      return response.json()
    })
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage }
    })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })

    await expect(adapter.send('owner', 'prompt')).resolves.toMatchObject({
      kind: 'sent', delivery: 'bound', binding: { kind: 'message-id', value: exactId }
    })
    adapter.close()
  })

  it('waits for a correlated BOT echo when sendmessage has no usable message_id', async () => {
    const bot = createMockWeChatBot()
    const acknowledgement = deferred<unknown>()
    const sendMessage = vi.fn(() => acknowledgement.promise)
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage }
    })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    const resultPromise = adapter.send('owner', 'prompt')
    const payload = sendMessage.mock.calls[0]![2] as { client_id: string }

    acknowledgement.resolve({ message_id: 0, ret: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(adapter.pendingCount).toBe(1)
    adapter.observeWireMessages([{ client_id: payload.client_id, to_user_id: 'owner', message_type: 2, message_id: 1846 }])
    await expect(resultPromise).resolves.toMatchObject({
      kind: 'sent', sendCall: 'fulfilled', delivery: 'bound',
      binding: { kind: 'message-id', value: '1846', clientId: payload.client_id }
    })
    adapter.close()
  })

  it('accepts the protocol msg_id alias in the sendmessage acknowledgement', async () => {
    const bot = createMockWeChatBot()
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage: vi.fn(async () => ({ msg_id: 'server-message-alias', ret: 0 })) }
    })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })

    await expect(adapter.send('owner', 'prompt')).resolves.toMatchObject({
      kind: 'sent', binding: { kind: 'message-id', value: 'server-message-alias' }
    })
    adapter.close()
  })

  it('keeps concurrent confirmation sends bound to their own IDs when responses arrive out of order', async () => {
    const bot = createMockWeChatBot()
    const firstAck = deferred<unknown>()
    const secondAck = deferred<unknown>()
    let callCount = 0
    const sendMessage = vi.fn(() => callCount++ === 0 ? firstAck.promise : secondAck.promise)
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage }
    })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    const first = adapter.send('owner', 'first')
    const second = adapter.send('owner', 'second')
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))

    secondAck.resolve({ message_id: 'server-message-second', ret: 0 })
    firstAck.resolve({ message_id: 'server-message-first', ret: 0 })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ kind: 'sent', binding: { value: 'server-message-first' } })
    expect(secondResult).toMatchObject({ kind: 'sent', binding: { value: 'server-message-second' } })
    expect(adapter.pendingCount).toBe(0)
    adapter.close()
  })

  it('waits briefly for a poller echo before failing binding without an acknowledged ID', async () => {
    const bot = createMockWeChatBot()
    const sendMessage = vi.fn(async () => ({ ret: 0, errmsg: '' }))
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage }
    })
    const onSettled = vi.fn()
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000, bindingTimeoutMs: 5, onSettled })

    await expect(adapter.send('owner', 'prompt')).resolves.toMatchObject({
      kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound'
    })
    expect(bot.sendRaw).not.toHaveBeenCalled()
    expect(adapter.pendingCount).toBe(0)
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ kind: 'binding-unavailable' }), expect.objectContaining({
      sendResponseKeys: ['ret', 'errmsg'], sendResponseMessageIdPresent: false,
      sendResponseMessageIdShape: 'missing', echoedMessageIdPresent: false
    }))
    adapter.close()
  })

  it.each([
    [{ message_id: 0 }, 'zero'],
    [{ message_id: '' }, 'empty-string'],
    [{ message_id: Number.MAX_SAFE_INTEGER + 1 }, 'unsafe-positive-integer'],
    [{ message_id: 'server-message-301' }, 'non-empty-string']
  ])('records the send acknowledgement ID shape without exposing the ID value', async (response, expectedShape) => {
    const bot = createMockWeChatBot()
    Object.assign(bot, {
      getCredentials: () => ({ baseUrl: 'https://ilink.test', token: 'test-token' }),
      api: { sendMessage: vi.fn(async () => response) }
    })
    const onSettled = vi.fn()
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000, bindingTimeoutMs: 5, onSettled })

    await adapter.send('owner', 'prompt')

    expect(onSettled.mock.calls[0]?.[1]).toMatchObject({ sendResponseMessageIdShape: expectedShape })
    expect(JSON.stringify(onSettled.mock.calls[0]?.[1])).not.toContain('server-message-301')
    adapter.close()
  })

  it('binds only after send acknowledgement and a matching raw BOT echo provide the server message_id', async () => {
    const bot = createMockWeChatBot()
    const send = deferred<void>()
    bot.sendRaw.mockImplementationOnce(() => send.promise)
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    const resultPromise = adapter.send('owner', 'prompt')
    const payload = bot.sendRaw.mock.calls[0]![0] as { client_id: string }
    adapter.observeWireMessages([{ client_id: payload.client_id, to_user_id: 'owner', message_type: 2, message_id: 1842 }])
    send.resolve()
    await expect(resultPromise).resolves.toMatchObject({
      kind: 'sent', sendCall: 'fulfilled', delivery: 'bound',
      binding: { kind: 'message-id', value: '1842', clientId: payload.client_id }
    })
    adapter.close()
  })

  it('does not bind when a matching BOT echo arrives before sendRaw later rejects', async () => {
    const bot = createMockWeChatBot()
    const send = deferred<void>()
    bot.sendRaw.mockImplementationOnce(() => send.promise)
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    const resultPromise = adapter.send('owner', 'prompt')
    const payload = bot.sendRaw.mock.calls[0]![0] as { client_id: string }
    adapter.observeWireMessages([{ client_id: payload.client_id, to_user_id: 'owner', message_type: 2, message_id: 1845 }])
    send.reject(new Error('send rejected after echo'))
    await expect(resultPromise).resolves.toMatchObject({ kind: 'send-rejected', sendCall: 'rejected', delivery: 'unknown' })
    expect(adapter.pendingCount).toBe(0)
    adapter.close()
  })

  it('uses the SDK MessageBuilder and does not treat an inbound user message as an outbound echo', async () => {
    const bot = createMockWeChatBot()
    bot.createMessage = ((userId: string) => MessageBuilder.to(userId, 'context-token')) as never
    let payload!: Record<string, unknown>
    bot.sendRaw.mockImplementationOnce(async (wirePayload: Record<string, unknown>) => { payload = wirePayload })
    const adapter = new WeChatConfirmationPromptAdapter(bot as never)
    const resultPromise = adapter.send('owner', 'confirm')
    await vi.waitFor(() => expect(bot.sendRaw).toHaveBeenCalledOnce())
    expect(payload).toMatchObject({
      to_user_id: 'owner', client_id: expect.stringMatching(/^spaceassistant-confirm:/), message_type: 2
    })
    expect(payload).not.toHaveProperty('message_id')
    const text = (payload.item_list as Array<{ text_item?: { text?: string } }>)[0]?.text_item?.text
    expect(text).toBe('confirm')
    adapter.observeWireMessages([{ client_id: payload.client_id, to_user_id: 'owner', message_type: 2, message_id: 1844 }])
    await expect(resultPromise).resolves.toMatchObject({ kind: 'sent', binding: { kind: 'message-id', value: '1844' } })
    adapter.close()
  })

  it('send rejection stays a failure and is not retried by the adapter', async () => {
    const bot = createMockWeChatBot()
    bot.sendRaw.mockRejectedValueOnce(new Error('API rejected'))
    const adapter = new WeChatConfirmationPromptAdapter(bot as never)
    await expect(adapter.send('owner', 'prompt')).resolves.toMatchObject({ kind: 'send-rejected', sendCall: 'rejected' })
    expect(bot.sendRaw).toHaveBeenCalledTimes(1)
    adapter.close()
  })

  it('send ack without a matching echo is binding-unavailable, not send failure', async () => {
    const bot = createMockWeChatBot()
    const send = deferred<void>()
    bot.sendRaw.mockImplementationOnce(() => send.promise)
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 5 })
    await expect(adapter.send('owner', 'prompt')).resolves.toMatchObject({ kind: 'timed-out', sendCall: 'pending', delivery: 'unknown' })
    send.reject(new Error('late rejection'))
    expect(adapter.pendingCount).toBe(0)
    adapter.close()
  })

  it('cancellation and close release pending sends once', async () => {
    const bot = createMockWeChatBot()
    const send = deferred<void>()
    bot.sendRaw.mockImplementation(() => send.promise)
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000 })
    const controller = new AbortController()
    const first = adapter.send('owner', 'prompt', controller.signal)
    controller.abort()
    await expect(first).resolves.toMatchObject({ kind: 'cancelled' })
    const second = adapter.send('owner', 'prompt-2')
    adapter.close()
    await expect(second).resolves.toMatchObject({ kind: 'cancelled' })
    expect(adapter.pendingCount).toBe(0)
    send.resolve()
  })

  it('classifies fulfilled send without a BOT echo as binding-unavailable after the binding wait', async () => {
    const bot = createMockWeChatBot()
    const adapter = new WeChatConfirmationPromptAdapter(bot as never, { sendTimeoutMs: 1000, bindingTimeoutMs: 5 })
    await expect(adapter.send('owner', 'prompt')).resolves.toMatchObject({
      kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound', errorCategory: 'message-binding-unavailable'
    })
    adapter.close()
  })

  it('quote markers are cryptographically unique and reject malformed nonce inputs', () => {
    expect(createWeChatQuoteMarker()).not.toBe(createWeChatQuoteMarker())
    expect(() => createWeChatQuoteMarker('invalid')).toThrow('WECHAT_QUOTE_NONCE_INVALID')
  })
})
