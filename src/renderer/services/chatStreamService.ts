import type { ClaudeChatSendStreamPayload } from '../../shared/api'

export type StreamCallbacks = {
  onDelta: (text: string) => void
  onThinkingDelta?: (text: string) => void
  onDone: (data?: { usage?: unknown }) => void
  onError: (message: string) => void
}

/**
 * 发起主进程流式请求并订阅增量；通过 requestId 过滤陈旧事件（与 NovelAI claude 服务思路一致）。
 */
export async function runClaudeChatStream(
  payload: ClaudeChatSendStreamPayload,
  callbacks: StreamCallbacks
): Promise<void> {
  const { requestId } = payload
  const unsubs: Array<() => void> = []
  const cleanup = () => {
    for (const u of unsubs) u()
    unsubs.length = 0
  }

  unsubs.push(
    window.api.claudeChatOnDelta((d) => {
      if (d.requestId !== requestId) return
      callbacks.onDelta(d.text)
    })
  )
  unsubs.push(
    window.api.claudeChatOnThinkingDelta((d) => {
      if (d.requestId !== requestId) return
      callbacks.onThinkingDelta?.(d.text)
    })
  )
  unsubs.push(
    window.api.claudeChatOnDone((d) => {
      if (d.requestId !== requestId) return
      cleanup()
      callbacks.onDone({ usage: d.usage })
    })
  )
  unsubs.push(
    window.api.claudeChatOnError((d) => {
      if (d.requestId !== requestId) return
      cleanup()
      callbacks.onError(d.message)
    })
  )

  try {
    const res = await window.api.claudeChatSendStream(payload)
    if (!res.ok) {
      cleanup()
      callbacks.onError(res.error)
    }
  } catch (e) {
    cleanup()
    callbacks.onError(e instanceof Error ? e.message : String(e))
  }
}
