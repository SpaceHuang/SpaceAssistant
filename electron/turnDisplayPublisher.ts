const COALESCED_DISPLAY_EVENT_TYPES = new Set([
  'content-delta',
  'thinking-delta',
  'tool-progress',
  'preview-rollback',
  'preview-commit',
  'content-reconciled',
  'thinking-reconciled'
])

type TurnWithId = { turnId: string }
type EventWithType = { type: string }
type Pending<TTurn, TEvent> = { turn: TTurn; event: TEvent }

/** Coalesces renderer-only streaming snapshots while preserving critical event ordering. */
export function createTurnDisplayPublisher<TTurn extends TurnWithId, TEvent extends EventWithType>(
  publish: (turn: TTurn, event: TEvent) => void,
  delayMs = 50
): { enqueue(turn: TTurn, event: TEvent): void; flush(): void; dispose(): void } {
  const pending = new Map<string, Pending<TTurn, TEvent>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const batch = Array.from(pending.values())
    pending.clear()
    for (const item of batch) publish(item.turn, item.event)
  }

  return {
    enqueue(turn, event) {
      if (disposed) return
      if (!COALESCED_DISPLAY_EVENT_TYPES.has(event.type)) {
        flush()
        publish(turn, event)
        return
      }
      pending.set(turn.turnId, { turn, event })
      if (timer === undefined) timer = setTimeout(flush, Math.max(0, delayMs))
    },
    flush,
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending.clear()
    }
  }
}
