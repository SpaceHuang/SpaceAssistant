import { describe, expectTypeOf, it } from 'vitest'
import type { Api } from './api'
import type { UsageAttributionSummary, UsageLatestAttribution, UsageStatsRangeArgs } from './usageStatsTypes'

describe('usage stats attribution API contract', () => {
  it('exposes the read-only attribution query through the typed preload API', () => {
    expectTypeOf<Api['usageStatsAttribution']>().toEqualTypeOf<(args: UsageStatsRangeArgs) => Promise<UsageAttributionSummary>>()
    expectTypeOf<Api['usageStatsLatestAttribution']>().toEqualTypeOf<(sessionId: string) => Promise<UsageLatestAttribution | null>>()
  })
})
