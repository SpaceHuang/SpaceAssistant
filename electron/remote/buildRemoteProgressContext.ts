import type { AppLocale } from '../../src/shared/locale'
import type { RemoteProgressHookContext } from './remoteProgressHooks'
import { createRemoteProgressT, createToolCallLabelFormatter } from '../toolCallLabel'

export function buildRemoteProgressHookContext(sessionId: string, locale: AppLocale): RemoteProgressHookContext {
  return {
    sessionId,
    formatToolLabel: createToolCallLabelFormatter(locale),
    t: createRemoteProgressT(locale)
  }
}
