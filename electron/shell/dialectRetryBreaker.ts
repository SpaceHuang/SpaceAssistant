export class DialectRetryBreaker {
  private readonly counts = new Map<string, number>()

  record(profileId: string, signals: readonly string[]): { count: number; tripped: boolean } {
    const key = `${profileId}:${[...signals].sort().join(',')}`
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return { count, tripped: count >= 2 }
  }

  clear(profileId: string, signals: readonly string[]): void {
    const key = `${profileId}:${[...signals].sort().join(',')}`
    this.counts.delete(key)
  }
}
