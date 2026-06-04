export type AppLocale = 'zh-CN' | 'en-US'

export const APP_LOCALES: AppLocale[] = ['zh-CN', 'en-US']

export const LOCALE_STORAGE_KEY = 'sa_locale'

export function isAppLocale(value: string): value is AppLocale {
  return value === 'zh-CN' || value === 'en-US'
}

export function detectLocaleFromSystem(systemLanguage: string): AppLocale {
  return systemLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function resolveAppLocale(options: {
  storedLocale?: string | null
  configLocale?: string | null
  systemLanguage?: string
}): AppLocale {
  if (options.configLocale && isAppLocale(options.configLocale)) {
    return options.configLocale
  }
  if (options.storedLocale && isAppLocale(options.storedLocale)) {
    return options.storedLocale
  }
  return detectLocaleFromSystem(options.systemLanguage ?? 'zh-CN')
}
