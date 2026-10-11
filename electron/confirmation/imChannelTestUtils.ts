import { ImChannel, type ImChannelDeps, type PromptPreflightFailure } from './imChannel'
import type { PromptSendResult } from './promptSend'

/** Keeps legacy synchronous unit fixtures concise while still exercising bound replies. */
export function createImChannelForTest(deps: ImChannelDeps): ImChannel {
  class TestImChannel extends ImChannel {
    override tryResolveFromInbound(
      parsed: { kind: string; confirmId?: string; tier?: number },
      inbound: { matchKey?: string; messageId: string; quotedMessageId?: string; quotedMessageText?: string }
    ): boolean {
      const pending = this.listPending().find((entry) => entry.confirmId === parsed.confirmId)
      return super.tryResolveFromInbound(parsed, {
        ...inbound,
        quotedMessageId: inbound.quotedMessageId ?? pending?.promptMessageId,
        quotedMessageText: inbound.quotedMessageText ?? (pending?.promptQuoteMarker ? `test prompt${pending.promptQuoteMarker}` : undefined)
      })
    }
  }
  return new TestImChannel({
    ...deps,
    sendPrompt: (entry) => {
      const result = deps.sendPrompt(entry)
      const bind = (value: { messageId: string } | PromptPreflightFailure | PromptSendResult | void) => {
        if (value && typeof value === 'object' && 'kind' in value) {
          if (value.kind === 'sent') {
            if (value.binding.kind === 'message-id') entry.promptMessageId = value.binding.value
            else entry.promptQuoteMarker = value.binding.marker
          }
          return value
        }
        const sent = value && typeof value === 'object' && 'messageId' in value && typeof value.messageId === 'string'
          ? value
          : { messageId: `test-prompt-${entry.id}` }
        entry.promptMessageId = sent.messageId
        return sent
      }
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<{ messageId: string } | PromptPreflightFailure | void>).then(bind)
      }
      return bind(result as { messageId: string } | PromptPreflightFailure | void)
    }
  })
}
