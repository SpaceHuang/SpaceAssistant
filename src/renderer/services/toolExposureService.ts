import type { AppConfig } from '../../shared/domainTypes'

let cache: string[] | null = null

/**
 * 渲染端 exposure 清单缓存：主进程经 `exposure:get-tools` 求值可见工具名，渲染端薄壳消费。
 * 冷启动空窗内 cache 为 null → 调用方回退到 `filterBuiltinToolsForRenderer` 旧滤镜。
 */
export async function refreshToolExposure(
  lane: 'desktop' | 'wechat' | 'feishu',
  config: AppConfig
): Promise<string[]> {
  cache = await window.api.getToolExposureList({ lane, config })
  return cache
}

export function getCachedToolExposure(): string[] | null {
  return cache
}

export function resetToolExposureForTests(): void {
  cache = null
}
