import { ErrorCodes, splitCodedError } from '../../shared/errorCodes'
import { translateError } from './errorTranslator'

/** 将 IPC/工具错误（错误码或遗留自由文本）转为当前语言的展示文案 */
export function formatUserFacingError(raw: string | undefined | null): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''

  const parsed = splitCodedError(trimmed)
  if (!parsed) return raw

  const { code, detail } = parsed
  if (trimmed === code) return translateError({ code })
  if (code === ErrorCodes.BROWSER_RATE_LIMIT_REJECTED) {
    return translateError({ code, params: { perMinute: detail } })
  }
  if (code === ErrorCodes.BROWSER_RATE_LIMIT_WAIT_TIMEOUT) {
    return translateError({ code, params: { maxWaitSec: detail } })
  }
  return translateError({ code, params: { code: detail } })
}
