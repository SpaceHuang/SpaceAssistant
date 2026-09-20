import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MENU_LABEL_MESSAGES, buildMenuTemplate, type MenuLabelKey } from './menu'
import type { LocalizedMessage } from '../src/shared/localization'

/** 渲染端 i18n 真源(zh-CN/en-US menu.json):主进程菜单键必须与之对齐(偏差 13 防漂移)。 */
function loadMenuNamespace(locale: string): Record<string, unknown> {
  const resourcesDir = path.resolve(process.cwd(), 'src', 'renderer', 'i18n', 'resources', locale)
  return JSON.parse(readFileSync(path.join(resourcesDir, 'menu.json'), 'utf-8')) as Record<string, unknown>
}

function fakeTranslate(message: LocalizedMessage): string {
  return `[${message.key}]`
}

function resolveLabels(translate: (m: LocalizedMessage) => string): Record<MenuLabelKey, string> {
  return Object.fromEntries(
    (Object.keys(MENU_LABEL_MESSAGES) as MenuLabelKey[]).map((k) => [k, translate(MENU_LABEL_MESSAGES[k])])
  ) as Record<MenuLabelKey, string>
}

describe('menu 键化(偏差 13:主进程不产出文案)', () => {
  it('MENU_LABEL_MESSAGES 的键在 zh-CN / en-US 渲染端真源中全部存在', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const ns = loadMenuNamespace(locale)
      for (const msg of Object.values(MENU_LABEL_MESSAGES)) {
        expect(typeof ns[msg.key.split('.')[1]], `${locale}:${msg.key}`).toBe('string')
        expect(ns[msg.key.split('.')[1]], `${locale}:${msg.key} 非空`).not.toBe('')
      }
    }
  })

  it('菜单模板 label 全部来自注入的 translate 解析(显示处经端口)', () => {
    const labels = resolveLabels(fakeTranslate)
    const template = buildMenuTemplate(labels, { isMac: false, appName: 'SA' })
    const walk = (items: Electron.MenuItemConstructorOptions[]): string[] =>
      items.flatMap((item) => {
        const children = 'submenu' in item && Array.isArray(item.submenu) ? walk(item.submenu) : []
        return [...children, ...(item.label ? [item.label] : [])]
      })
    const found = walk(template)
    expect(found).toContain('[menu.view]')
    expect(found).toContain('[menu.help]')
    expect(found).toContain('[menu.quit]')
    expect(found).toContain('[menu.devTools]')
    expect(found).toContain('[menu.usageStats]')
    expect(found).toContain('[menu.settings]')
    expect(found).toContain('[menu.about]')
    expect(found).toContain('[menu.docs]')
    // 非 Mac 才有退出项
    expect(found).not.toContain('[menu.closeWindow]')
    // 模板内不得残留硬编码中文文案(抽样断言)
    for (const label of found) {
      expect(label.startsWith('['), `非键化 label:${label}`).toBe(true)
    }
  })

  it('mac 分支:关闭窗口 + 编辑菜单,无退出项', () => {
    const labels = resolveLabels(fakeTranslate)
    const template = buildMenuTemplate(labels, { isMac: true, appName: 'SA' })
    const walk = (items: Electron.MenuItemConstructorOptions[]): string[] =>
      items.flatMap((item) => {
        const children = 'submenu' in item && Array.isArray(item.submenu) ? walk(item.submenu) : []
        return [...children, ...(item.label ? [item.label] : [])]
      })
    const found = walk(template)
    expect(found).toContain('[menu.closeWindow]')
    expect(found).toContain('[menu.edit]')
    expect(found).not.toContain('[menu.quit]')
  })
})
