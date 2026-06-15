import i18n from '../i18n/index'
import { isAppLocale, type AppLocale } from '../../shared/locale'

/** 解析当前聊天请求应使用的界面 locale，供 IPC payload 传入主进程 */
export function resolveChatLocale(): AppLocale {
  return isAppLocale(i18n.language) ? i18n.language : 'zh-CN'
}
