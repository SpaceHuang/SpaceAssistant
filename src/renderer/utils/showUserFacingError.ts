import { message } from 'antd'
import { formatUserFacingError } from './formatUserFacingError'

export function showUserFacingError(raw: string | undefined | null): void {
  const text = formatUserFacingError(raw)
  if (text) message.error(text)
}
