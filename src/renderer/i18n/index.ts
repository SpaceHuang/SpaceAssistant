import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { LOCALE_STORAGE_KEY } from '../../shared/locale'
import { detectLocale, readStoredLocale } from './detectLocale'

import zhCNCommon from './resources/zh-CN/common.json'
import zhCNConfig from './resources/zh-CN/config.json'
import zhCNChat from './resources/zh-CN/chat.json'
import zhCNErrors from './resources/zh-CN/errors.json'
import zhCNFileTree from './resources/zh-CN/fileTree.json'
import zhCNSearch from './resources/zh-CN/search.json'
import zhCNFeishu from './resources/zh-CN/feishu.json'
import zhCNWiki from './resources/zh-CN/wiki.json'
import zhCNDetailPanel from './resources/zh-CN/detailPanel.json'
import zhCNContextUsage from './resources/zh-CN/contextUsage.json'
import zhCNNotification from './resources/zh-CN/notification.json'
import enUSCommon from './resources/en-US/common.json'
import enUSConfig from './resources/en-US/config.json'
import enUSChat from './resources/en-US/chat.json'
import enUSErrors from './resources/en-US/errors.json'
import enUSFileTree from './resources/en-US/fileTree.json'
import enUSSearch from './resources/en-US/search.json'
import enUSFeishu from './resources/en-US/feishu.json'
import enUSWiki from './resources/en-US/wiki.json'
import enUSDetailPanel from './resources/en-US/detailPanel.json'
import enUSContextUsage from './resources/en-US/contextUsage.json'
import enUSNotification from './resources/en-US/notification.json'

const initialLocale = detectLocale(
  readStoredLocale(),
  typeof navigator !== 'undefined' ? navigator.language : undefined
)

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': {
        common: zhCNCommon,
        config: zhCNConfig,
        chat: zhCNChat,
        errors: zhCNErrors,
        fileTree: zhCNFileTree,
        search: zhCNSearch,
        feishu: zhCNFeishu,
        wiki: zhCNWiki,
        detailPanel: zhCNDetailPanel,
        contextUsage: zhCNContextUsage,
        notification: zhCNNotification
      },
      'en-US': {
        common: enUSCommon,
        config: enUSConfig,
        chat: enUSChat,
        errors: enUSErrors,
        fileTree: enUSFileTree,
        search: enUSSearch,
        feishu: enUSFeishu,
        wiki: enUSWiki,
        detailPanel: enUSDetailPanel,
        contextUsage: enUSContextUsage,
        notification: enUSNotification
      }
    },
    lng: initialLocale,
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common', 'config', 'chat', 'errors', 'fileTree', 'search', 'feishu', 'wiki', 'detailPanel', 'contextUsage', 'notification'],
    interpolation: { escapeValue: false },
    debug: import.meta.env.DEV && !import.meta.env.VITEST,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: import.meta.env.VITEST ? [] : ['localStorage']
    }
  })

export { LOCALE_STORAGE_KEY }
export default i18n
