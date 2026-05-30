import type { AppDatabase } from '../database'
import { getConfigValue, setConfigValue } from '../database'
import { mergeBrowserConfig, type BrowserConfig } from '../../src/shared/domainTypes'

export const BROWSER_CONFIG_KEY = 'config.browser'

export function readBrowserConfigFromDb(db: AppDatabase): BrowserConfig {
  const raw = getConfigValue(db, BROWSER_CONFIG_KEY)
  if (!raw) return mergeBrowserConfig(null)
  try {
    return mergeBrowserConfig(JSON.parse(raw) as Partial<BrowserConfig>)
  } catch {
    return mergeBrowserConfig(null)
  }
}

export function persistBrowserConfig(db: AppDatabase, partial: Partial<BrowserConfig>): BrowserConfig {
  const next = mergeBrowserConfig({ ...readBrowserConfigFromDb(db), ...partial })
  setConfigValue(db, BROWSER_CONFIG_KEY, JSON.stringify(next))
  return next
}
