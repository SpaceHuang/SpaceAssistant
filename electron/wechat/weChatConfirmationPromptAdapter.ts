import { randomUUID } from 'node:crypto'
import type { WeChatBot } from '@wechatbot/wechatbot'
import type { PromptSendResult } from '../confirmation/promptSend'

/**
 * The pinned SDK's sendRaw() hides the sendmessage response. Its low-level
 * ILinkApi.sendMessage() returns that response, including message_id when the
 * platform provides it. Poller echoes are only a fallback.
 */
export const WECHAT_CONFIRMATION_QUOTE_CONTRACT = Object.freeze({
  sdkVersion: '2.2.0',
  sendEndpoint: '/ilink/bot/sendmessage',
  sendAcknowledgement: ['message_id', 'ret', 'errmsg'],
  quoteBinding: 'ref_msg.message_item.msg_id',
  echoBinding: 'getupdates.msgs[client_id,to_user_id,message_type=BOT].message_id (fallback)',
  platformQuoteRoundTripVerified: true as const
})

type PendingSend = {
  clientId: string
  userId: string
  resolve: (result: PromptSendResult) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
  settled: boolean
  sendCall: 'pending' | 'fulfilled'
  sendResponseKeys: string[]
  sendResponseMessageIdShape: string
  acknowledgedMessageId?: string
  echoedMessageId?: string
}

type SendApiAccess = {
  getCredentials?: () => { baseUrl?: unknown; token?: unknown } | undefined
  api?: { sendMessage?: (baseUrl: string, token: string, payload: unknown) => Promise<unknown> }
}

type RawWireMessage = {
  client_id?: unknown
  to_user_id?: unknown
  message_type?: unknown
  message_id?: unknown
}

const losslessFetchWrappers = new WeakSet<typeof fetch>()

/**
 * The pinned SDK parses JSON with JSON.parse, which rounds iLink's int64
 * message_id before the confirmation adapter can bind a quote. Preserve the
 * decimal token as a string only for the sendmessage response.
 */
export function wrapFetchForLosslessWeChatMessageId(fetchImplementation: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const response = await fetchImplementation.call(globalThis, input, init)
    let url: URL
    try {
      const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      url = new URL(inputUrl)
    } catch {
      return response
    }
    if (url.pathname.replace(/\/+$/, '') !== '/ilink/bot/sendmessage') return response

    const rawBody = await response.clone().text()
    const losslessBody = rawBody.replace(/(^|[,{]\s*"message_id"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"')
    if (losslessBody === rawBody) return response
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(losslessBody, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  }
  losslessFetchWrappers.add(wrapped)
  return wrapped
}

function installLosslessWeChatMessageIdFetch(): void {
  const currentFetch = globalThis.fetch
  if (losslessFetchWrappers.has(currentFetch)) return
  globalThis.fetch = wrapFetchForLosslessWeChatMessageId(currentFetch)
}

function messageIdFromSendResponse(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const response = value as Record<string, unknown>
  for (const key of ['message_id', 'msg_id', 'messageId']) {
    const id = response[key]
    if (typeof id === 'string' && id.trim()) return id
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id)
  }
  return undefined
}

function messageIdShapeFromSendResponse(value: unknown): string {
  if (!value || typeof value !== 'object') return 'no-response-object'
  const response = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(response, 'message_id')
    && !Object.prototype.hasOwnProperty.call(response, 'msg_id')
    && !Object.prototype.hasOwnProperty.call(response, 'messageId')) return 'missing'
  const id = response.message_id ?? response.msg_id ?? response.messageId
  if (id === null || id === undefined) return 'nullish'
  if (typeof id === 'string') return id.trim() ? 'non-empty-string' : 'empty-string'
  if (typeof id === 'number') {
    if (!Number.isFinite(id)) return 'non-finite-number'
    if (!Number.isInteger(id)) return 'non-integer-number'
    if (id === 0) return 'zero'
    if (id < 0) return 'negative-integer'
    if (!Number.isSafeInteger(id)) return 'unsafe-positive-integer'
    return 'positive-integer'
  }
  return `unsupported-${typeof id}`
}

function responseKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.keys(value).filter((key) => /^[a-zA-Z0-9_]{1,40}$/.test(key)).slice(0, 12)
}

/** Sends once and binds only after send success and a correlated server BOT echo. */
export class WeChatConfirmationPromptAdapter {
  private readonly pending = new Map<string, PendingSend>()
  private closed = false

  constructor(
    private readonly bot: WeChatBot,
    private readonly options: {
      sendTimeoutMs?: number
      bindingTimeoutMs?: number
      onSettled?: (result: PromptSendResult, metadata: {
        clientId: string
        sendResponseKeys: string[]
        sendResponseMessageIdPresent: boolean
        sendResponseMessageIdShape: string
        echoedMessageIdPresent: boolean
      }) => void
      onEcho?: (metadata: { clientId: string; messageId: string }) => void
    } = {}
  ) {
    installLosslessWeChatMessageIdFetch()
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Consume raw getupdates wire messages before the SDK filters BOT messages. */
  observeWireMessages(messages: readonly unknown[]): void {
    if (this.closed) return
    for (const value of messages) {
      if (!value || typeof value !== 'object') continue
      const wire = value as RawWireMessage
      if (typeof wire.client_id !== 'string' || typeof wire.to_user_id !== 'string' || wire.message_type !== 2) continue
      if (typeof wire.message_id !== 'string' && typeof wire.message_id !== 'number') continue
      const operation = this.pending.get(wire.client_id)
      if (!operation || operation.userId !== wire.to_user_id) continue
      operation.echoedMessageId = String(wire.message_id)
      try { this.options.onEcho?.({ clientId: operation.clientId, messageId: operation.echoedMessageId }) } catch { /* Diagnostics cannot affect settlement. */ }
      this.settleIfBound(operation)
    }
  }

  send(userId: string, content: string, signal?: AbortSignal): Promise<PromptSendResult> {
    if (this.closed) return Promise.resolve({ kind: 'not-attempted', sendCall: 'not-attempted', delivery: 'not-attempted', errorCategory: 'bot-unavailable' })
    if (signal?.aborted) return Promise.resolve({ kind: 'cancelled', sendCall: 'pending', delivery: 'unbound' })

    const clientId = `spaceassistant-confirm:${randomUUID()}`
    const payload = this.bot.createMessage(userId).withClientId(clientId).text(content).build()
    return new Promise<PromptSendResult>((resolve) => {
      const operation: PendingSend = {
        clientId,
        userId,
        resolve,
        timer: setTimeout(() => this.finish(operation, operation.sendCall === 'fulfilled'
          ? { kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound', errorCategory: 'message-binding-unavailable' }
          : { kind: 'timed-out', sendCall: 'pending', delivery: 'unknown' }), this.options.sendTimeoutMs ?? 60_000),
        ...(signal ? { signal } : {}),
        settled: false,
        sendCall: 'pending',
        sendResponseKeys: [],
        sendResponseMessageIdShape: 'pending'
      }
      operation.timer.unref?.()
      if (signal) {
        operation.onAbort = () => this.finish(operation, { kind: 'cancelled', sendCall: operation.sendCall, delivery: 'unbound' })
        signal.addEventListener('abort', operation.onAbort, { once: true })
      }
      this.pending.set(clientId, operation)
      if (signal?.aborted) {
        this.finish(operation, { kind: 'cancelled', sendCall: 'pending', delivery: 'unbound' })
        return
      }

      let sendPromise: Promise<unknown>
      try {
        sendPromise = this.sendPromptPayload(payload)
      } catch (error) {
        this.finish(operation, { kind: 'send-rejected', sendCall: 'rejected', delivery: 'unknown', error })
        return
      }
      void Promise.resolve(sendPromise).then((response) => {
        operation.sendCall = 'fulfilled'
        operation.sendResponseKeys = responseKeys(response)
        operation.sendResponseMessageIdShape = messageIdShapeFromSendResponse(response)
        operation.acknowledgedMessageId = messageIdFromSendResponse(response)
        try { void this.bot.stopTyping(userId).catch(() => undefined) } catch { /* best-effort typing cleanup */ }
        this.settleIfBound(operation)
        if (operation.settled) return
        this.waitForMessageBinding(operation)
      }, (error: unknown) => {
        this.finish(operation, { kind: 'send-rejected', sendCall: 'rejected', delivery: 'unknown', error })
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const operation of [...this.pending.values()]) {
      this.finish(operation, { kind: 'cancelled', sendCall: operation.sendCall, delivery: 'unbound' })
    }
  }

  private settleIfBound(operation: PendingSend): void {
    if (operation.sendCall !== 'fulfilled') return
    if (operation.acknowledgedMessageId && operation.echoedMessageId && operation.acknowledgedMessageId !== operation.echoedMessageId) {
      this.finish(operation, { kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound', errorCategory: 'message-binding-unavailable' })
      return
    }
    const messageId = operation.acknowledgedMessageId ?? operation.echoedMessageId
    if (!messageId) return
    this.finish(operation, {
      kind: 'sent', sendCall: 'fulfilled', delivery: 'bound',
      binding: { kind: 'message-id', value: messageId, clientId: operation.clientId }
    })
  }

  private waitForMessageBinding(operation: PendingSend): void {
    clearTimeout(operation.timer)
    operation.timer = setTimeout(() => this.finish(operation, {
      kind: 'binding-unavailable', sendCall: 'fulfilled', delivery: 'unbound', errorCategory: 'message-binding-unavailable'
    }), this.options.bindingTimeoutMs ?? 5_000)
    operation.timer.unref?.()
  }

  private sendPromptPayload(payload: unknown): Promise<unknown> {
    const access = this.bot as unknown as SendApiAccess
    const credentials = access.getCredentials?.()
    if (typeof access.api?.sendMessage === 'function'
      && typeof credentials?.baseUrl === 'string'
      && typeof credentials.token === 'string') {
      return access.api.sendMessage(credentials.baseUrl, credentials.token, payload)
    }
    return this.bot.sendRaw(payload as never)
  }

  private finish(operation: PendingSend, result: PromptSendResult): void {
    if (operation.settled || this.pending.get(operation.clientId) !== operation) return
    operation.settled = true
    this.pending.delete(operation.clientId)
    clearTimeout(operation.timer)
    if (operation.signal && operation.onAbort) operation.signal.removeEventListener('abort', operation.onAbort)
    try {
      this.options.onSettled?.(result, {
        clientId: operation.clientId,
        sendResponseKeys: operation.sendResponseKeys,
        sendResponseMessageIdPresent: Boolean(operation.acknowledgedMessageId),
        sendResponseMessageIdShape: operation.sendResponseMessageIdShape,
        echoedMessageIdPresent: Boolean(operation.echoedMessageId)
      })
    } catch { /* Diagnostics cannot affect send settlement. */ }
    operation.resolve(result)
  }
}
