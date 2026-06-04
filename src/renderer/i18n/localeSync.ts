import { LOCALE_STORAGE_KEY, type AppLocale } from '../../shared/locale'
import i18n from './index'

export async function changeAppLocale(locale: AppLocale): Promise<void> {
  await i18n.changeLanguage(locale)
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  }
}

export function syncLocaleFromConfig(locale: AppLocale): void {
  if (i18n.language !== locale) {
    void changeAppLocale(locale)
  }
}

export async function persistLocaleToBackend(locale: AppLocale): Promise<void> {
  if (typeof window !== 'undefined' && window.api?.configSet) {
    await window.api.configSet({ locale })
  }
}
