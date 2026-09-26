export type ReadConfirmationEntry = { requestId: string; toolUseId: string; inputDigest: string; factIds: string[]; ruleId: string; expiresAt: number; state: 'pending' | 'approved' | 'consumed' | 'rejected' | 'expired' }
type ActiveReadConfirmationEntry = Omit<ReadConfirmationEntry, 'state'> & { state: 'pending' | 'approved' }

type ReadConfirmationRegistryOptions = {
  /** 同时允许存在的 pending/approved 完整登记数；超限时新登记 fail-closed。 */
  maxEntries?: number
  /** 终态重放墓碑的最大数量；最旧墓碑先淘汰。 */
  maxTombstones?: number
  /** 终态键阻止重放的保留期。 */
  tombstoneTtlMs?: number
}

const DEFAULT_MAX_ENTRIES = 4096
const DEFAULT_MAX_TOMBSTONES = 4096
const DEFAULT_TOMBSTONE_TTL_MS = 10 * 60 * 1000

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value))
}

export class ReadConfirmationRegistry {
  /** 仅 pending/approved 项保留完整 facts；状态结束后必须移出此 Map。 */
  private readonly entries = new Map<string, ActiveReadConfirmationEntry>()
  /** 重放保护只保留 request/tool key 与过期时间，不保留摘要、规则或路径 factId。 */
  private readonly tombstones = new Map<string, number>()
  private readonly maxEntries: number
  private readonly maxTombstones: number
  private readonly tombstoneTtlMs: number

  constructor(
    private readonly clock: { now: () => number } = { now: () => Date.now() },
    options: ReadConfirmationRegistryOptions = {}
  ) {
    this.maxEntries = boundedPositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES)
    this.maxTombstones = boundedPositiveInteger(options.maxTombstones, DEFAULT_MAX_TOMBSTONES)
    this.tombstoneTtlMs = boundedPositiveInteger(options.tombstoneTtlMs, DEFAULT_TOMBSTONE_TTL_MS)
  }

  private key(requestId: string, toolUseId: string): string { return `${requestId}\u0000${toolUseId}` }

  private rememberTerminalKey(key: string, now: number): void {
    this.tombstones.delete(key)
    this.tombstones.set(key, now + this.tombstoneTtlMs)
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.tombstones.delete(oldest)
    }
  }

  /** 惰性回收已过期登记与墓碑；所有公开操作都会调用，避免依赖定时器清理。 */
  private prune(now: number): void {
    for (const [key, expiresAt] of this.tombstones) {
      if (now >= expiresAt) this.tombstones.delete(key)
    }
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key)
        this.rememberTerminalKey(key, now)
      }
    }
  }

  /** 只暴露数量，便于运行监控与验证有界性，不泄露登记键或目标路径。 */
  stats(): { activeEntries: number; tombstones: number } {
    this.prune(this.clock.now())
    return { activeEntries: this.entries.size, tombstones: this.tombstones.size }
  }

  register(entry: Omit<ReadConfirmationEntry, 'state'>): boolean {
    const now = this.clock.now()
    this.prune(now)
    const key = this.key(entry.requestId, entry.toolUseId)
    if (!entry.requestId || !entry.toolUseId || entry.expiresAt <= now || this.entries.has(key) || this.tombstones.has(key) || this.entries.size >= this.maxEntries) return false
    this.entries.set(key, Object.freeze({ ...entry, factIds: [...entry.factIds], state: 'pending' }))
    return true
  }

  settle(requestId: string, toolUseId: string, state: 'rejected' | 'expired'): boolean {
    const now = this.clock.now()
    this.prune(now)
    const key = this.key(requestId, toolUseId)
    const entry = this.entries.get(key)
    if (!entry || entry.state !== 'pending') return false
    this.entries.delete(key)
    this.rememberTerminalKey(key, now)
    return true
  }

  approve(input: { requestId: string; toolUseId: string; inputDigest: string; approvedFactIds: string[]; ruleId?: string }): boolean {
    const now = this.clock.now()
    this.prune(now)
    const key = this.key(input.requestId, input.toolUseId)
    const entry = this.entries.get(key)
    if (!entry || entry.state !== 'pending') return false
    if (entry.toolUseId !== input.toolUseId || entry.inputDigest !== input.inputDigest || (input.ruleId !== undefined && entry.ruleId !== input.ruleId)) return false
    const expected = [...entry.factIds].sort(); const actual = [...new Set(input.approvedFactIds)].sort()
    if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) return false
    this.entries.set(key, { ...entry, state: 'approved' })
    return true
  }

  consume(requestId: string, toolUseId: string, expected?: { inputDigest: string; factIds: string[]; ruleId?: string }): ReadConfirmationEntry | undefined {
    const now = this.clock.now()
    this.prune(now)
    const key = this.key(requestId, toolUseId)
    const entry = this.entries.get(key)
    if (!entry || entry.state !== 'approved') return undefined
    if (expected && (entry.inputDigest !== expected.inputDigest || entry.ruleId !== expected.ruleId || entry.factIds.length !== expected.factIds.length || entry.factIds.some((id, index) => id !== expected.factIds[index]))) return undefined
    this.entries.delete(key)
    this.rememberTerminalKey(key, now)
    return { ...entry, state: 'consumed' }
  }
}

export const readConfirmationRegistry = new ReadConfirmationRegistry()
