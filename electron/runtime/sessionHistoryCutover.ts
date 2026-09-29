import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { rebuildClaudeMessagesFromHistory, toCanonicalModelMessages } from './canonicalHistory'

type HostMessage = import('../../src/shared/api').ClaudeChatMessageWithBlocks

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
  snapshot: HistorySnapshot
  requestMessages: readonly import('../../packages/agent-sdk/src/model').CanonicalModelMessage[]
  requiredUserMessage: import('../../packages/agent-sdk/src/model').CanonicalModelMessage
}): CanonicalRequestCutoverResult {
  try {
    const required = stable(input.requiredUserMessage)
    let requiredIndex = -1
    let requiredMatches = 0
    for (let index = input.requestMessages.length - 1; index >= 0; index -= 1) {
      if (stable(input.requestMessages[index]) === required) {
        requiredIndex = index
        requiredMatches += 1
      }
    }
    if (requiredIndex < 0) return { kind: 'required-user-missing' }
    if (requiredMatches !== 1) return { kind: 'required-user-missing' }
    if (input.requestMessages.slice(requiredIndex + 1).some((message) => String(message.role) !== 'system')) {
      return { kind: 'required-user-not-last' }
    }
    const requestPrefix = input.requestMessages.slice(0, requiredIndex).filter((message) => message.role !== 'system')
    const historyMessages = toCanonicalModelMessages(rebuildClaudeMessagesFromHistory(input.snapshot.events))
    const selectedHistory: typeof historyMessages = []
    let historyIndex = 0
    for (const requested of requestPrefix) {
      while (historyIndex < historyMessages.length && stable(historyMessages[historyIndex]) !== stable(requested)) historyIndex += 1
      if (historyIndex >= historyMessages.length) return { kind: 'transcript-mismatch' }
      selectedHistory.push(historyMessages[historyIndex]!)
      historyIndex += 1
    }
    const systemMessages = input.requestMessages.filter((message) => message.role === 'system')
    return { kind: 'matched', messages: [...systemMessages, ...selectedHistory, input.requestMessages[requiredIndex]!] }
  } catch {
    return { kind: 'history-unrebuildable' }
  }
}
