import type { AgentRuntime } from './agentRuntime'

/**
 * 默认 runtime 槽位(A2,偏差 18;P8 结构解环终态):
 * 零依赖纯槽位——兼容转发(六原模块的 @deprecated 全局函数)打到这里。
 * 未装配即抛错(fail-loud):桌面宿主 main.ts 启动装配;测试显式 setDefaultAgentRuntime。
 * 环纪律:六原模块 → 本模块;本模块不 import 任何业务模块(此前惰性组装会把
 * builtinExecutors 的 442 文件闭包拉进加载环,在 imChannel/feishuImChannel 链实测
 * 「Class extends value undefined」)。
 */

let defaultRuntime: AgentRuntime | null = null

/** 默认 runtime(必须先经 setDefaultAgentRuntime 装配)。 */
export function getDefaultAgentRuntime(): AgentRuntime {
  if (!defaultRuntime) {
    throw new Error('agent runtime 未装配:请先调用 setDefaultAgentRuntime(桌面宿主在 main.ts 启动时装配)')
  }
  return defaultRuntime
}

/** 宿主装配入口(main.ts 启动时调用一次;重复装配打告警——槽位是全局单点,防意外覆盖)。 */
export function setDefaultAgentRuntime(runtime: AgentRuntime): void {
  if (defaultRuntime && defaultRuntime !== runtime) {
    console.warn('[agentRuntime] 默认 runtime 被重复装配(先前的实例仍被既有引用持有)', {
      previousInstanceId: defaultRuntime.instanceId,
      nextInstanceId: runtime.instanceId
    })
  }
  defaultRuntime = runtime
}

/** 仅供测试重置默认 runtime。 */
export function resetDefaultAgentRuntimeForTests(): void {
  defaultRuntime = null
}
