import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from './sessionLedgerIdentity'

type RepairSchedulerOptions = {
  repair: (location: SessionLedgerLocationInput, retireSink: boolean) => Promise<boolean>
  onAttempt?: (result: { status: 'recovered' | 'retrying'; attempt: number; retryInMs: number }) => void
  initialDelayMs?: number
  maxDelayMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

type PendingRepair = {
  location: SessionLedgerLocationInput
  retireSink: boolean
  attempt: number
  generation?: string | number
  timer?: ReturnType<typeof setTimeout>
  running: boolean
  requestedAgain: boolean
}

/** Coalesces repair triggers and keeps a capped, low-frequency probe alive until recovery. */
export function createSessionLedgerRepairScheduler(options: RepairSchedulerOptions): {
  request(location: SessionLedgerLocationInput, requestOptions?: { retireSink?: boolean; generation?: string | number }): void
  stop(): void
  pendingCount(): number
} {
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? 1_000)
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 60_000)
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const pending = new Map<string, PendingRepair>()
  let stopped = false

  const schedule = (key: string, entry: PendingRepair, delayMs: number) => {
    if (stopped || entry.running || entry.timer) return
    entry.timer = setTimer(() => {
      entry.timer = undefined
      void run(key, entry)
    }, delayMs)
  }
  const run = async (key: string, entry: PendingRepair): Promise<void> => {
    if (stopped || pending.get(key) !== entry || entry.running) return
    entry.running = true
    const retireSink = entry.retireSink
    entry.retireSink = false
    let recovered = false
    try { recovered = await options.repair(entry.location, retireSink) } catch { recovered = false }
    entry.running = false
    if (stopped || pending.get(key) !== entry) return
    if (recovered) {
      if (entry.requestedAgain) {
        entry.requestedAgain = false
        void run(key, entry)
        return
      }
      try { options.onAttempt?.({ status: 'recovered', attempt: entry.attempt + 1, retryInMs: 0 }) } catch { /* diagnostics are best effort */ }
      pending.delete(key)
      return
    }
    entry.requestedAgain = false
    entry.attempt += 1
    const delay = Math.min(maxDelayMs, initialDelayMs * (2 ** Math.min(entry.attempt - 1, 30)))
    try { options.onAttempt?.({ status: 'retrying', attempt: entry.attempt, retryInMs: delay }) } catch { /* diagnostics are best effort */ }
    schedule(key, entry, delay)
  }

  return {
    request(location, requestOptions = {}) {
      if (stopped) return
      const key = sessionLedgerLocationIdentity(location).key
      let entry = pending.get(key)
      if (!entry) {
        entry = { location: { ...location }, retireSink: Boolean(requestOptions.retireSink), generation: requestOptions.generation,
          attempt: 0, running: false, requestedAgain: false }
        pending.set(key, entry)
      } else {
        if (requestOptions.retireSink) {
          entry.retireSink = true
          if (entry.running) entry.requestedAgain = true
        }
        if (requestOptions.generation !== undefined && requestOptions.generation !== entry.generation) {
          if (entry.running) entry.requestedAgain = true
          entry.generation = requestOptions.generation
        }
      }
      if (entry.running) {
        return
      }
      if (entry.timer) return
      void run(key, entry)
    },
    stop() {
      if (stopped) return
      stopped = true
      for (const entry of pending.values()) if (entry.timer) clearTimer(entry.timer)
      pending.clear()
    },
    pendingCount: () => pending.size
  }
}
