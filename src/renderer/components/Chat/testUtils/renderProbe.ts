/** 测试用 render 计数探针：按 id 累计组件 render 次数。 */
export type RenderProbe = {
  track: (id: string) => void
  get: (id: string) => number
  reset: () => void
  snapshot: () => Record<string, number>
}

export function createRenderProbe(): RenderProbe {
  const counts = new Map<string, number>()
  return {
    track(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    },
    get(id) {
      return counts.get(id) ?? 0
    },
    reset() {
      counts.clear()
    },
    snapshot() {
      return Object.fromEntries(counts)
    }
  }
}
