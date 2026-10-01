import i18n from './index'
import type { NamespaceKeyMap } from './types'

type RuntimeTextKey = NamespaceKeyMap['runtime']
type TranslationOptions = Parameters<typeof i18n.t>[1]

export function runtimeText(key: RuntimeTextKey, options?: TranslationOptions): string {
  const translationOptions = (options ?? {}) as Record<string, unknown>
  return i18n.t(key, { ...translationOptions, ns: 'runtime' })
}
