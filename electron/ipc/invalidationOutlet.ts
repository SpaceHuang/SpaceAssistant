import { getMainWindow } from '../windowRef'

/**
 * 偏差 11:失效通知统一出口。
 * 主进程 → 渲染端唯一广播通道:scope:invalidated { scope, version, hint? }。
 * 载荷只带 scope 与版本(可带失效指示 hint),不带真相(文件内容/列表);渲染端收到后自行重取。
 */
export function broadcastScopeInvalidation(scope: string, version: number, hint?: unknown): void {
  getMainWindow()?.webContents.send(
    'scope:invalidated',
    hint === undefined ? { scope, version } : { scope, version, hint }
  )
}
