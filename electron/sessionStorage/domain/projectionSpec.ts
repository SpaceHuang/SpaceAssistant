import type { Message } from '../../../src/shared/domainTypes'

export type ChatBodyV1 = Readonly<Pick<Message, 'id' | 'role' | 'content' | 'timestamp'>>

/** ProjectionSpec.chatBodyV1: stable ordered chat body, excluding display and execution metadata. */
export function projectChatBodyV1(messages: readonly Message[]): ChatBodyV1[] {
  return messages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp }))
}

export function encodeChatBodyV1(messages: readonly Message[]): string {
  return JSON.stringify(projectChatBodyV1(messages))
}

export function areChatBodiesV1Equal(left: readonly Message[], right: readonly Message[]): boolean {
  return encodeChatBodyV1(left) === encodeChatBodyV1(right)
}
