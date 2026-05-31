import type { ShellTerminalScrollback, ToolCallRecord } from '../../shared/domainTypes'
import { routePatchMessage } from './chatRunnerService'

export function mergeToolCallScrollback(
  toolCalls: ToolCallRecord[] | undefined,
  toolUseId: string,
  scrollback: ShellTerminalScrollback
): ToolCallRecord[] {
  const list = toolCalls ? [...toolCalls] : []
  const i = list.findIndex((t) => t.id === toolUseId)
  if (i < 0) return list
  const prev = list[i]!
  const prevData =
    prev.result?.data && typeof prev.result.data === 'object'
      ? { ...(prev.result.data as Record<string, unknown>) }
      : {}
  list[i] = {
    ...prev,
    progressOutput: undefined,
    progressOutputRaw: undefined,
    progressSeq: undefined,
    result: prev.result
      ? {
          ...prev.result,
          data: { ...prevData, terminalScrollback: scrollback }
        }
      : prev.result
  }
  return list
}

export function patchShellTerminalScrollback(args: {
  sessionId: string
  messageId: string
  toolUseId: string
  toolCalls: ToolCallRecord[] | undefined
  scrollback: ShellTerminalScrollback
}): void {
  const next = mergeToolCallScrollback(args.toolCalls, args.toolUseId, args.scrollback)
  routePatchMessage(args.sessionId, args.messageId, { toolCalls: next })
  void window.api.chatPatchMessage({
    sessionId: args.sessionId,
    messageId: args.messageId,
    patch: { toolCalls: next }
  })
}
