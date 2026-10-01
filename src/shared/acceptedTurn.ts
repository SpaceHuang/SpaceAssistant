import type { TurnExecutionConfig } from './assistantFactAggregator'

export type AcceptedTurn = Readonly<{
  turnId: string
  requestId: string
  sessionId: string
  lane: NonNullable<TurnExecutionConfig['lane']>
  startToken: string
  currentUserMessageId: string
  transcriptVersion: number
  config: Readonly<TurnExecutionConfig>
}>

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/** Build the immutable identity/configuration snapshot at the driver acceptance boundary. */
export function createAcceptedTurn(input: AcceptedTurn): AcceptedTurn {
  for (const key of ['turnId', 'requestId', 'sessionId', 'startToken', 'currentUserMessageId'] as const) {
    if (!input[key].trim()) throw new Error(`ACCEPTED_TURN_${key.toUpperCase()}_REQUIRED`)
  }
  if (!Number.isSafeInteger(input.transcriptVersion) || input.transcriptVersion < 0) throw new Error('ACCEPTED_TURN_TRANSCRIPT_VERSION_INVALID')
  const config = structuredClone(input.config)
  return Object.freeze({ ...input, config: deepFreeze(config) })
}
