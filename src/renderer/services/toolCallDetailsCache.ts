type Entry<T> = { value: T; expiresAt: number; lastUsedAt: number }

export class ToolCallDetailsCache<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private accessSequence = 0
  constructor(private readonly options: { ttlMs: number; maxEntries: number }, private readonly now = () => Date.now()) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined }
    entry.lastUsedAt = ++this.accessSequence
    return entry.value
  }
  set(key: string, value: T): void {
    const now = this.now()
    this.entries.set(key, { value, expiresAt: now + this.options.ttlMs, lastUsedAt: ++this.accessSequence })
    while (this.entries.size > this.options.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0]
      if (oldest) this.entries.delete(oldest[0])
    }
  }
  clear(): void { this.entries.clear() }
}
