import { LOCALE_STORAGE_KEY, resolveAppLocale, type AppLocale } from '../../shared/locale'

export type { AppLocale }

export function detectLocale(storedLocale?: string | null, systemLanguage?: string): AppLocale {
  return resolveAppLocale({
    storedLocale,
    systemLanguage
  })
}

export function readStoredLocale(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(LOCALE_STORAGE_KEY)
}
