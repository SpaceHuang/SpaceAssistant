export function createRateLimiter() {
  const senderRateMap = new Map<string, number[]>()
  return {
    check: (senderId: string, limit: number): boolean => {
      const now = Date.now()
      const window = senderRateMap.get(senderId) ?? []
      const recent = window.filter((t) => now - t < 60_000)
      if (recent.length >= limit) {
        senderRateMap.set(senderId, recent)
        return false
      }
      recent.push(now)
      senderRateMap.set(senderId, recent)
      return true
    },
    resetForTests: () => senderRateMap.clear()
  }
}
