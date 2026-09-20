/**
 * 本地化键化消息（偏差 13 收口）：主进程不产出文案，只产出「键 + 参数」；
 * 文案唯一真源是渲染端 i18n 资源（zh-CN 为真源）。主进程直接显示处（菜单 / 托盘 /
 * 系统通知）经注入的 translate 端口解析（宿主实现见 electron/i18n/hostTranslate.ts）。
 */

/** 键化消息：key 为渲染端 i18n 资源键（`命名空间.语义` 层级）。 */
export interface LocalizedMessage {
  key: string
  params?: Record<string, string | number>
}

/** 宿主翻译端口：契约（AgentHostPorts.translate）与主进程显示端共用同一形态。 */
export type TranslateFn = (message: LocalizedMessage) => string

/** 占位插值：i18next 同款 {{name}} 语法；缺失参数保留占位原样（fail-visible）。 */
export function interpolateMessage(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
