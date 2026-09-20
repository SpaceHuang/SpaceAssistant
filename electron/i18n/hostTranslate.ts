import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { interpolateMessage, type LocalizedMessage, type TranslateFn } from '../../src/shared/localization'

/**
 * 宿主 translate 端口实现（偏差 13）：主进程直接加载渲染端 i18n 资源解析键化消息
 * （zh-CN 为真源，实现取简——基线风险表「主进程直接加载 zh-CN 真源」拍板）。
 * 资源不可达 / 缺键：退化显示键名并落审计，不抛错、不阻塞启动。
 */

/** 打包态目录名（electron-builder extraResources `to`）。 */
const PACKAGED_DIR_NAME = 'i18n-resources'

/**
 * 渲染端 i18n 资源目录：
 * - 开发态：`{项目根}/src/renderer/i18n/resources`——从 mainDirname 逐级向上探测
 *   （编译输出深度随构建配置变化，写死层级必漂：P1-4 评审实测 dist-electron/electron/i18n
 *   需向上三级）；探测不到时回退「向上两级」的历史口径；
 * - 打包态：`{process.resourcesPath}/i18n-resources`（extraResources 拷贝，见 package.json build 字段）。
 */
export function resolveI18nResourcesDir(isPackaged: boolean, mainDirname: string, resourcesPath?: string): string {
  if (isPackaged) {
    return path.join(resourcesPath ?? process.resourcesPath, PACKAGED_DIR_NAME)
  }
  const REL = path.join('src', 'renderer', 'i18n', 'resources')
  let dir = path.resolve(mainDirname)
  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(dir, REL)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(mainDirname, '..', '..', REL)
}

type NamespaceTable = Record<string, string>

export function createHostTranslator(options?: {
  locale?: string
  resourcesDir?: string
  isPackaged?: boolean
}): TranslateFn {
  const locale = options?.locale ?? 'zh-CN'
  const resourcesDir =
    options?.resourcesDir ??
    resolveI18nResourcesDir(options?.isPackaged ?? Boolean(app?.isPackaged), __dirname)

  const cache = new Map<string, NamespaceTable | null>()

  function readNamespace(namespace: string, forLocale: string): NamespaceTable | null {
    const cacheKey = `${forLocale}/${namespace}`
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null
    const file = path.join(resourcesDir, forLocale, `${namespace}.json`)
    let table: NamespaceTable | null = null
    try {
      if (existsSync(file)) {
        table = JSON.parse(readFileSync(file, 'utf-8')) as NamespaceTable
      }
    } catch (error) {
      logAgentEvent('warn', 'i18n.resource_load_failed', {
        locale: forLocale,
        namespace,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
    cache.set(cacheKey, table)
    return table
  }

  return (message: LocalizedMessage): string => {
    const dotIndex = message.key.indexOf('.')
    const namespace = dotIndex > 0 ? message.key.slice(0, dotIndex) : message.key
    const leaf = dotIndex > 0 ? message.key.slice(dotIndex + 1) : ''
    const table = readNamespace(namespace, locale) ?? readNamespace(namespace, 'zh-CN')
    const template = table?.[leaf]
    if (typeof template !== 'string' || template === '') {
      logAgentEvent('warn', 'i18n.missing_key', { key: message.key, locale })
      return message.key
    }
    return interpolateMessage(template, message.params)
  }
}
