import type { MessageStatus } from './domainTypes'
export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
