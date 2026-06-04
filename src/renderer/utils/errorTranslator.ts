import i18n from 'i18next'
import type { ErrorCode } from '../../shared/errorCodes'

export interface IpcErrorLike {
  code: string
  params?: Record<string, string | number>
}

export function translateError(error: IpcErrorLike): string {
  const key = error.code as ErrorCode
  return i18n.t(key, {
    ns: 'errors',
    defaultValue: error.code,
    ...error.params
  })
}
