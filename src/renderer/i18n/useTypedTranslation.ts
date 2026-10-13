import { useCallback } from 'react'
import { useTranslation, type UseTranslationOptions } from 'react-i18next'
import type { I18nNamespaces, NamespaceKeyMap } from './types'

type TranslationOptions = Parameters<ReturnType<typeof useTranslation>['t']>[1]

export function useTypedTranslation<N extends I18nNamespaces>(
  ns: N,
  options?: UseTranslationOptions<N>
) {
  const { t, i18n, ready } = useTranslation(ns, options)

  // 引用稳定：把 t 放进 effect/useCallback 依赖数组的消费方不应因重渲染而反复触发。
  // react-i18next 的 t 仅在语言/命名空间变化时变引用，语言切换仍会及时更新。
  const typedT = useCallback(
    (key: NamespaceKeyMap[N], tOptions?: TranslationOptions) =>
      // react-i18next overload resolution is wider than our NamespaceKeyMap; cast at the boundary.
      (t as (k: string, o?: TranslationOptions) => string)(key, tOptions),
    [t]
  )

  return { t: typedT, i18n, ready }
}
