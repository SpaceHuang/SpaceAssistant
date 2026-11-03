/** Shared p95 budgets used by the opt-in storage performance tests and their CI observation lane. */
export const STORAGE_PERF_BUDGET = Object.freeze({
  relativeP95: Object.freeze({ multiplier: 2, allowanceMs: 5 }),
  apiShadowP95Ms: 50,
  canonicalApiP95Ms: 50,
  projectedApiContextP95Ms: 50,
  canonicalGlobalSearchP95Ms: 20,
  warmL1ProjectionP95Ms: 50,
  multiSpillPreparedReadP95Ms: 50,
  multiSpillSearchP95Ms: 20,
  globalSearchP95Ms: 20
})
