import { isErrorCode } from '../../shared/errorCodes'
import { translateError } from './errorTranslator'

/** 将 IPC/工具错误（错误码或遗留自由文本）转为当前语言的展示文案 */
export function formatUserFacingError(raw: string | undefined | null): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''

  const pipe = trimmed.indexOf('|')
  if (pipe > 0) {
    const code = trimmed.slice(0, pipe)
    if (isErrorCode(code)) {
      return translateError({ code, params: { code: trimmed.slice(pipe + 1) } })
    }
  }

  if (isErrorCode(trimmed)) {
    return translateError({ code: trimmed })
  }
  return raw
}
