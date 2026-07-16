import { randomBytes } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import type { ImCliLogLevel } from './imCliLogger'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Claim lease: if process dies before executing, reclaim after this. */
export const CLAIM_LEASE_MS = 5 * 60_000

export type ImProcessedState = 'claimed' | 'executing' | 'completed'

export type ImProcessedEntry = {
  messageId: string
  state: ImProcessedState
  claimId: string
  claimedAt: number
  leaseUntil: number
  completedAt?: number
  /** Audit summary for terminal states */
  resultSummary?: string
  /** executing that timed out on restart */
  interrupted?: 'interrupted_uncertain'
}

interface ImProcessedStoreData {
  entries: ImProcessedEntry[]
}

export type ImLogFn = (
  level: ImCliLogLevel,
  event: string,
  fields?: Record<string, unknown>
) => void

function newClaimId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * Persistent IM dedup state machine: claimed → executing → completed.
 * Single-writer queue + shared load promise; saves with fsync + atomic replace.
 */
export class ImProcessedStore {
  private data: ImProcessedStoreData = { entries: [] }
  private filePath: string
  private loadPromise: Promise<void> | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private opts: {
      channel: 'feishu' | 'wechat'
      userDataDir: string
      logEvent: ImLogFn
    }
  ) {
    this.filePath = path.join(opts.userDataDir, `${opts.channel}-processed-messages.json`)
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.filePath, 'utf8')
          const parsed = JSON.parse(raw) as ImProcessedStoreData
          this.data = {
            entries: Array.isArray(parsed.entries)
              ? parsed.entries.map((e) => this.normalizeEntry(e))
              : []
          }
        } catch {
          this.data = { entries: [] }
        }
        this.recoverOnLoad()
        this.purgeExpired()
      })()
    }
    return this.loadPromise
  }

  private normalizeEntry(e: Partial<ImProcessedEntry> & { messageId?: string; processedAt?: number }): ImProcessedEntry {
    // Migrate legacy { messageId, processedAt } records
    if (e.state == null && e.messageId && typeof e.processedAt === 'number') {
      return {
        messageId: e.messageId,
        state: 'completed',
        claimId: 'legacy',
        claimedAt: e.processedAt,
        leaseUntil: e.processedAt,
        completedAt: e.processedAt,
        resultSummary: 'legacy'
      }
    }
    return {
      messageId: String(e.messageId),
      state: (e.state as ImProcessedState) ?? 'completed',
      claimId: e.claimId ?? 'unknown',
      claimedAt: e.claimedAt ?? Date.now(),
      leaseUntil: e.leaseUntil ?? Date.now(),
      completedAt: e.completedAt,
      resultSummary: e.resultSummary,
      interrupted: e.interrupted
    }
  }

  /** Restart recovery: reclaim expired claimed; mark expired executing as interrupted. */
  recoverOnLoad(now = Date.now()): void {
    const next: ImProcessedEntry[] = []
    for (const e of this.data.entries) {
      if (e.state === 'claimed' && e.leaseUntil < now) {
        // Drop — allow re-claim
        continue
      }
      if (e.state === 'executing' && e.leaseUntil < now) {
        next.push({
          ...e,
          state: 'completed',
          completedAt: now,
          interrupted: 'interrupted_uncertain',
          resultSummary: 'interrupted_uncertain'
        })
        continue
      }
      next.push(e)
    }
    this.data.entries = next
  }

  purgeExpired(now = Date.now()): void {
    const cutoff = now - RETENTION_MS
    this.data.entries = this.data.entries.filter((e) => {
      const ts = e.completedAt ?? e.claimedAt
      return ts >= cutoff
    })
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn)
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    const tmp = `${this.filePath}.${SAFE_TMP}.${randomBytes(6).toString('hex')}`
    const body = JSON.stringify(this.data, null, 2)
    const fh = await fs.open(tmp, 'wx')
    try {
      await fh.writeFile(body, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fs.rename(tmp, this.filePath)
  }

  /**
   * True if message must not start a new Agent (active claim/executing or completed).
   * @deprecated Prefer tryClaim for atomic check-and-set.
   */
  async has(messageId: string): Promise<boolean> {
    await this.ensureLoaded()
    const e = this.data.entries.find((x) => x.messageId === messageId)
    if (!e) return false
    if (e.state === 'claimed' && e.leaseUntil < Date.now()) return false
    return true
  }

  /**
   * Legacy: claim + immediately complete (used until routers migrate fully).
   * @deprecated Prefer tryClaim / markExecuting / markCompleted.
   */
  async mark(messageId: string, now = Date.now()): Promise<void> {
    const claimed = await this.tryClaim(messageId, now)
    if (!claimed.ok) return
    await this.markCompleted(messageId, claimed.claimId, 'legacy_mark', now)
  }

  async tryClaim(
    messageId: string,
    now = Date.now()
  ): Promise<{ ok: true; claimId: string } | { ok: false; reason: 'duplicate' }> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      this.recoverOnLoad(now)
      const existing = this.data.entries.find((x) => x.messageId === messageId)
      if (existing) {
        if (existing.state === 'claimed' && existing.leaseUntil < now) {
          this.data.entries = this.data.entries.filter((x) => x.messageId !== messageId)
        } else {
          return { ok: false as const, reason: 'duplicate' as const }
        }
      }
      const claimId = newClaimId()
      this.data.entries.push({
        messageId,
        state: 'claimed',
        claimId,
        claimedAt: now,
        leaseUntil: now + CLAIM_LEASE_MS
      })
      this.purgeExpired(now)
      this.opts.logEvent('info', `${this.opts.channel}.processed.claim`, {
        messageId,
        claimId,
        entryCount: this.data.entries.length
      })
      await this.save()
      return { ok: true as const, claimId }
    })
  }

  async markExecuting(messageId: string, claimId: string, now = Date.now()): Promise<boolean> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      const e = this.data.entries.find((x) => x.messageId === messageId && x.claimId === claimId)
      if (!e || e.state !== 'claimed') return false
      e.state = 'executing'
      e.leaseUntil = now + CLAIM_LEASE_MS
      await this.save()
      return true
    })
  }

  async markCompleted(
    messageId: string,
    claimId: string,
    resultSummary: string,
    now = Date.now()
  ): Promise<boolean> {
    return this.enqueueWrite(async () => {
      await this.ensureLoaded()
      const e = this.data.entries.find((x) => x.messageId === messageId && x.claimId === claimId)
      if (!e) return false
      e.state = 'completed'
      e.completedAt = now
      e.resultSummary = resultSummary
      await this.save()
      this.opts.logEvent('info', `${this.opts.channel}.processed.completed`, {
        messageId,
        claimId,
        resultSummary
      })
      return true
    })
  }
}

const SAFE_TMP = 'tmp'
