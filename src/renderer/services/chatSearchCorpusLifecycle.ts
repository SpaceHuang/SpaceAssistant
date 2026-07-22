/**
 * 语料加载门控：绑定 sessionId + 面板打开状态；query 变化不得触发重载。
 */
export function shouldReloadSearchCorpus(args: {
  active: boolean
  isOpen: boolean
  sessionId: string | null | undefined
  loadedSessionId: string | null
}): boolean {
  if (!args.active || !args.isOpen || !args.sessionId) return false
  return args.loadedSessionId !== args.sessionId
}

export function shouldClearSearchCorpus(args: {
  active: boolean
  isOpen: boolean
  sessionId: string | null | undefined
}): boolean {
  return !args.active || !args.isOpen || !args.sessionId
}
