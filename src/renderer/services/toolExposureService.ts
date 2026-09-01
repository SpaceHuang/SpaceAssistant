type ExposureLane = 'desktop' | 'wechat' | 'feishu'

let cache: string[] | null = null
const listeners = new Set<(tools: string[] | null) => void>()

function emit(): void {
  for (const cb of listeners) cb(cache)
}

/**
 * 渲染端 exposure 清单缓存：主进程为唯一评估者，清单经 `exposure:get-tools` 拉取 +
 * `exposure:tools-changed` 推送到达。冷启动空窗内 cache 为 null —— 调用方不得渲染工具列表。
 */
export async function refreshToolExposure(lane: ExposureLane = 'desktop'): Promise<string[]> {
  cache = await window.api.getToolExposureList({ lane })
  emit()
  return cache
}

/** 挂载时调用：先主动拉一次全量清单，再订阅配置变更后的重推。返回退订函数。 */
export function initToolExposure(): () => void {
  const off = window.api.onToolExposureChanged((payload) => {
    if (payload.lane !== 'desktop') return
    cache = payload.tools
    emit()
  })
  void refreshToolExposure('desktop').catch(() => undefined)
  return off
}

/** 订阅清单变化（含空窗 null → 首推到达）。 */
export function subscribeToolExposure(cb: (tools: string[] | null) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getCachedToolExposure(): string[] | null {
  return cache
}

export function resetToolExposureForTests(): void {
  cache = null
  listeners.clear()
}
