import { describe, expect, it } from 'vitest'
import { approvalFallbackReasonFor } from './fallbackReason'

describe('approvalFallbackReasonFor', () => {
  it.each([
    ['unavailable', 'zh-CN', '服务暂不可用'],
    ['timeout', 'zh-CN', '等待超时'],
    ['unavailable', 'en-US', 'Service unavailable'],
    ['timeout', 'en-US', 'Timed out']
  ] as const)('maps %s/%s to the localized short reason', (cause, locale, expected) => {
    expect(approvalFallbackReasonFor(cause, locale)).toBe(expected)
  })
})
