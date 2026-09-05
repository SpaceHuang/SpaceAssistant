import { describe, expect, it } from 'vitest'
import { DialectRetryBreaker } from './dialectRetryBreaker'

describe('DialectRetryBreaker', () => {
  it('连续两次相同 profile/signals mismatch 后熔断，成功后可清除', () => {
    const breaker = new DialectRetryBreaker()
    expect(breaker.record('profile', ['export']).tripped).toBe(false)
    expect(breaker.record('profile', ['export']).tripped).toBe(true)
    breaker.clear('profile', ['export'])
    expect(breaker.record('profile', ['export']).count).toBe(1)
  })

  it('不同 signal 集合分别计数', () => {
    const breaker = new DialectRetryBreaker()
    breaker.record('profile', ['export'])
    expect(breaker.record('profile', ['rm-rf']).count).toBe(1)
  })
})
