let enabled = false

/** Process-local test switch. It is never persisted and is writable only from an unpackaged build. */
export function isImAutoReviewTestModeEnabled(): boolean {
  return enabled
}

export function setImAutoReviewTestModeEnabled(value: boolean, isPackaged: boolean): boolean {
  if (isPackaged) throw new Error('IM_AUTO_REVIEW_TEST_MODE_UNAVAILABLE')
  if (typeof value !== 'boolean') throw new Error('IM_AUTO_REVIEW_TEST_MODE_INVALID')
  enabled = value
  return enabled
}
