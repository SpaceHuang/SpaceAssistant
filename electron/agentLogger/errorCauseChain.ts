/**
 * llm.error 日志专用的错误因果链序列化。
 *
 * HostedTurnFinalizedError / ToolExecutionAfterDispatchError 等包装层会把原始错误
 * 存在自定义字段里（cause / originalError），只记最外层 stack 会丢掉最内层的抛出点
 * （如 read_file 的 `EBADF: file closed` 从哪个 FileHandle 操作抛出）。
 */

export type SerializedErrorLink = {
  name?: string
  message: string
  code?: string
  stack?: string
}

const MAX_CAUSE_CHAIN_DEPTH = 5
const MAX_STACK_LENGTH = 4000

function nextCause(err: Error): unknown {
  const link = err as Error & { cause?: unknown; originalError?: unknown }
  if (link.originalError !== undefined && link.originalError !== err) return link.originalError
  return link.cause !== err ? link.cause : undefined
}

function truncateStack(stack: string): string {
  return stack.length > MAX_STACK_LENGTH ? `${stack.slice(0, MAX_STACK_LENGTH)}…[truncated]` : stack
}

export function serializeErrorCauseChain(err: unknown): SerializedErrorLink[] | undefined {
  if (err == null) return undefined
  const chain: SerializedErrorLink[] = []
  const visited = new Set<unknown>()
  let current: unknown = err
  while (current != null && chain.length < MAX_CAUSE_CHAIN_DEPTH && !visited.has(current)) {
    visited.add(current)
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code
      chain.push({
        ...(current.name ? { name: current.name } : {}),
        message: current.message,
        ...(code !== undefined ? { code } : {}),
        ...(current.stack ? { stack: truncateStack(current.stack) } : {})
      })
    } else {
      chain.push({ message: String(current) })
    }
    current = current instanceof Error ? nextCause(current) : undefined
  }
  return chain.length > 0 ? chain : undefined
}
