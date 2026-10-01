import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { rebuildClaudeMessagesFromHistory, toCanonicalModelMessages } from './canonicalHistory'

type HostMessage = import('../../src/shared/api').ClaudeChatMessageWithBlocks
type CanonicalModelMessage = import('../../packages/agent-sdk/src/model').CanonicalModelMessage
type CanonicalToolCall = NonNullable<Extract<CanonicalModelMessage, { role: 'assistant' }>['toolCalls']>[number]

export type SessionHistoryCutoverResult =
  | Readonly<{ kind: 'matched'; messages: readonly HostMessage[] }>
  | Readonly<{ kind: 'current-user-missing' | 'current-user-not-last' | 'transcript-mismatch' | 'history-unrebuildable' }>

export type CanonicalRequestCutoverResult =
  | Readonly<{ kind: 'matched'; messages: readonly import('../../packages/agent-sdk/src/model').CanonicalModelMessage[] }>
  | Readonly<{ kind: 'required-user-missing' | 'required-user-not-last' | 'transcript-mismatch' | 'history-unrebuildable' }>

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

type TranscriptUnit = Readonly<{ key: string; messages: readonly CanonicalModelMessage[] }>

/** Legacy chat rows coalesce assistant rounds for one user turn; compare their content as one turn. */
function transcriptUnits(messages: readonly CanonicalModelMessage[]): TranscriptUnit[] {
  const units: TranscriptUnit[] = []
  let assistantContent: Array<Record<string, unknown>> = []
  let toolCalls: CanonicalToolCall[] = []
  let tools: CanonicalModelMessage[] = []
  let turnMessages: CanonicalModelMessage[] = []

  const flushAssistantContent = (content: readonly Record<string, unknown>[]) => {
    for (const block of content) {
      if (block.type === 'thinking') continue
      const previous = assistantContent.at(-1)
      if (block.type === 'text' && previous?.type === 'text') {
        assistantContent[assistantContent.length - 1] = { type: 'text', text: `${String(previous.text ?? '')}${String(block.text ?? '')}` }
      } else assistantContent.push(block)
    }
  }
  const flushTurn = () => {
    if (turnMessages.length === 0) return
    const normalizedContent = assistantContent.map((block) => ({ ...block }))
    const firstTextIndex = normalizedContent.findIndex((block) => block.type === 'text')
    let lastTextIndex = -1
    for (let index = normalizedContent.length - 1; index >= 0; index -= 1) {
      if (normalizedContent[index]?.type === 'text') {
        lastTextIndex = index
        break
      }
    }
    if (firstTextIndex >= 0) normalizedContent[firstTextIndex] = { ...normalizedContent[firstTextIndex]!, text: String(normalizedContent[firstTextIndex]!.text ?? '').trimStart() }
    if (lastTextIndex >= 0) normalizedContent[lastTextIndex] = { ...normalizedContent[lastTextIndex]!, text: String(normalizedContent[lastTextIndex]!.text ?? '').trimEnd() }
    const comparisonContent = normalizedContent.filter((block) => block.type !== 'text' || String(block.text ?? '').length > 0)
    const assistant: Record<string, unknown> = {
      role: 'assistant',
      ...(comparisonContent.length ? { content: comparisonContent } : {}),
      ...(toolCalls.length ? { toolCalls } : {})
    }
    units.push({ key: stable([assistant, ...tools]), messages: turnMessages })
    assistantContent = []
    toolCalls = []
    tools = []
    turnMessages = []
  }

  const normalizedAssistantKey = (message: Extract<CanonicalModelMessage, { role: 'assistant' }>) => {
    const content: Record<string, unknown>[] = []
    if (typeof message.content === 'string') content.push({ type: 'text', text: message.content })
    else if (Array.isArray(message.content)) {
      for (const block of message.content as readonly Record<string, unknown>[]) {
        if (block.type === 'thinking') continue
        const previous = content.at(-1)
        if (block.type === 'text' && previous?.type === 'text') {
          content[content.length - 1] = { type: 'text', text: `${String(previous.text ?? '')}${String(block.text ?? '')}` }
        } else content.push(block)
      }
    }
    return stable({ role: 'assistant', ...(content.length ? { content } : {}), ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) })
  }

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      flushTurn()
      units.push({ key: stable(message), messages: [message] })
    } else if (message.role === 'assistant') {
      if (!message.toolCalls?.length) {
        flushTurn()
        units.push({ key: normalizedAssistantKey(message), messages: [message] })
        continue
      }
      turnMessages.push(message)
      if (typeof message.content === 'string') flushAssistantContent([{ type: 'text', text: message.content }])
      else if (Array.isArray(message.content)) flushAssistantContent(message.content as readonly Record<string, unknown>[])
      toolCalls.push(...message.toolCalls)
    } else {
      turnMessages.push(message)
      tools.push(message)
    }
  }
  flushTurn()
  return units
}

/** Rebuild prior conversation from canonical History while retaining the current input and message identities. */
export function resolveSessionHistoryCutover(input: {
  snapshot: HistorySnapshot
  legacyMessages: readonly HostMessage[]
  currentUserMessageId: string
}): SessionHistoryCutoverResult {
  try {
    const currentIndex = input.legacyMessages.findIndex((message) => message.id === input.currentUserMessageId)
    if (currentIndex < 0) return { kind: 'current-user-missing' }
    if (currentIndex !== input.legacyMessages.length - 1 || input.legacyMessages[currentIndex]?.role !== 'user') {
      return { kind: 'current-user-not-last' }
    }
    const historyMessages = rebuildClaudeMessagesFromHistory(input.snapshot.events)
    const legacyPrefix = input.legacyMessages.slice(0, currentIndex)
    const canonicalHistory = toCanonicalModelMessages(historyMessages).filter((message) => message.role !== 'system')
    const canonicalLegacy = toCanonicalModelMessages(legacyPrefix).filter((message) => message.role !== 'system')
    if (stable(canonicalHistory) !== stable(canonicalLegacy) || historyMessages.length !== legacyPrefix.length) {
      return { kind: 'transcript-mismatch' }
    }
    const withLegacyIdentity = historyMessages.map((message, index) => ({
      ...message,
      ...(legacyPrefix[index]?.id ? { id: legacyPrefix[index]!.id } : {})
    }))
    return { kind: 'matched', messages: [...withLegacyIdentity, input.legacyMessages[currentIndex]!] }
  } catch {
    return { kind: 'history-unrebuildable' }
  }
}

/** Project the current request's intentional context selection from canonical History. */
export function resolveCanonicalRequestCutover(input: {
  snapshot?: HistorySnapshot
  requestMessages: readonly import('../../packages/agent-sdk/src/model').CanonicalModelMessage[]
  requiredUserMessage: import('../../packages/agent-sdk/src/model').CanonicalModelMessage
  additionalAcceptedMessages?: readonly import('../../packages/agent-sdk/src/model').CanonicalModelMessage[]
}): CanonicalRequestCutoverResult {
  try {
    const required = stable(input.requiredUserMessage)
    let requiredIndex = -1
    for (let index = input.requestMessages.length - 1; index >= 0; index -= 1) {
      if (stable(input.requestMessages[index]) === required) {
        requiredIndex = index
        break
      }
    }
    if (requiredIndex < 0) return { kind: 'required-user-missing' }
    if (input.requestMessages.slice(requiredIndex + 1).some((message) => String(message.role) !== 'system')) {
      return { kind: 'required-user-not-last' }
    }
    const requestPrefix = input.requestMessages.slice(0, requiredIndex).filter((message) => message.role !== 'system')
    const historyMessages = [
      ...(input.snapshot ? toCanonicalModelMessages(rebuildClaudeMessagesFromHistory(input.snapshot.events)) : []),
      ...(input.additionalAcceptedMessages ?? [])
    ].filter((message) => message.role !== 'system')
    const requestUnits = transcriptUnits(requestPrefix)
    const historyUnits = transcriptUnits(historyMessages)
    const selectedHistory: CanonicalModelMessage[] = []
    let historyIndex = 0
    for (const requested of requestUnits) {
      // Failed pre-dispatch turns can leave legacy user/error messages after the last
      // canonical event. They are not transcript evidence and must not shadow the
      // committed History prefix used for this request.
      if (historyIndex >= historyUnits.length) continue
      while (historyIndex < historyUnits.length && historyUnits[historyIndex]!.key !== requested.key) historyIndex += 1
      if (historyIndex >= historyUnits.length) return { kind: 'transcript-mismatch' }
      selectedHistory.push(...historyUnits[historyIndex]!.messages)
      historyIndex += 1
    }
    const systemMessages = input.requestMessages.filter((message) => message.role === 'system')
    return { kind: 'matched', messages: [...systemMessages, ...selectedHistory, input.requestMessages[requiredIndex]!] }
  } catch {
    return { kind: 'history-unrebuildable' }
  }
}
