export const CHAT_CANCELLED_MESSAGE = '用户已中止'

export function isChatCancelledError(err: string): boolean {
  return err === CHAT_CANCELLED_MESSAGE
}
