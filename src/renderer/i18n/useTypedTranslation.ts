import { useTranslation, type UseTranslationOptions } from 'react-i18next'
import type { I18nNamespaces, NamespaceKeyMap } from './types'

type TranslationOptions = Parameters<ReturnType<typeof useTranslation>['t']>[1]

export function useTypedTranslation<N extends I18nNamespaces>(
  ns: N,
  options?: UseTranslationOptions<N>
) {
  const { t, i18n, ready } = useTranslation(ns, options)

  const typedT = (key: NamespaceKeyMap[N], tOptions?: TranslationOptions) => t(key, tOptions)

  return { t: typedT, i18n, ready }
}
