import type { ToolExecutionContext } from '../tools/types'
import type { ReviewFileReceipt, ReviewScopeCandidate, ReviewWriteLease } from './reviewScopeCache'

/** Coordinates a single controlled file write with the session review receipt generation. */
export function beginReviewScopeWrite(ctx: ToolExecutionContext): {
  captureReceipt: boolean
  complete(receipt?: ReviewFileReceipt): void
  fail(): void
} {
  const cache = ctx.reviewScopeCache
  const scope = ctx.reviewScopeCandidateScope as ReviewScopeCandidate | undefined
  const digest = ctx.reviewScopeCandidateDigest
  if (!cache || !scope || !digest || !cache.state(scope)) return {
    captureReceipt: false, complete: () => undefined, fail: () => undefined
  }
  const state = cache.state(scope)
  const lease: ReviewWriteLease | null = state?.state === 'active' ? cache.beginWrite(scope) : null
  let settled = false
  const fail = () => {
    if (settled) return
    settled = true
    if (lease) cache.failWrite(lease)
    else cache.revoke(scope)
  }
  return {
    captureReceipt: true,
    complete(receipt) {
      if (settled) return
      settled = true
      if (!receipt) {
        if (lease) cache.failWrite(lease)
        else cache.revoke(scope)
        return
      }
      const completed = lease ? cache.completeWrite(lease, receipt) : cache.activateFirstWrite(scope, digest, receipt)
      if (!completed) {
        if (lease) cache.failWrite(lease)
        else cache.revoke(scope)
      }
    },
    fail
  }
}
