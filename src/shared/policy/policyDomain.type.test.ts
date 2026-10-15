import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ExecutionLane } from '../confirmation/types'
import { policyDomainForTrustedOrigin, type PolicyDomain, type TrustedPolicyOrigin } from './policyDomain'

type IsAssignable<From, To> = [From] extends [To] ? true : false

describe('policy domain type contract', () => {
  it('policy domain excludes channel lanes while execution lane retains them', () => {
    expectTypeOf<PolicyDomain>().toEqualTypeOf<'desktop' | 'im' | 'automation'>()
    expectTypeOf<ExecutionLane>().toEqualTypeOf<'desktop' | 'wechat' | 'feishu' | 'automation'>()
    expectTypeOf<IsAssignable<'wechat', PolicyDomain>>().toEqualTypeOf<false>()
    expectTypeOf<IsAssignable<'feishu', PolicyDomain>>().toEqualTypeOf<false>()
    expectTypeOf<IsAssignable<'im', ExecutionLane>>().toEqualTypeOf<false>()
  })
})

describe('trusted policy origin mapping', () => {
  it('trusted origin entry alone determines policy domain', () => {
    const cases: Array<[TrustedPolicyOrigin, PolicyDomain]> = [
      [{ entry: 'desktop', lane: 'desktop' }, 'desktop'],
      [{ entry: 'wechat', lane: 'wechat' }, 'im'],
      [{ entry: 'feishu', lane: 'feishu' }, 'im'],
      [{ entry: 'automation', lane: 'automation' }, 'automation']
    ]
    for (const [origin, domain] of cases) expect(policyDomainForTrustedOrigin(origin)).toBe(domain)
  })

  it('unknown or conflicting entry and lane fail closed', () => {
    expect(policyDomainForTrustedOrigin({ entry: 'unknown', lane: 'desktop' })).toBeNull()
    expect(policyDomainForTrustedOrigin({ entry: 'wechat', lane: 'desktop' })).toBeNull()
    expect(policyDomainForTrustedOrigin({ entry: 'desktop', lane: 'feishu' })).toBeNull()
  })

  it('does not use caller supplied recipient or session fields to choose a wider domain', () => {
    const origin = {
      entry: 'wechat',
      lane: 'wechat',
      recipient: 'third-party',
      sessionCreatedBy: 'desktop',
      outboundTarget: 'group'
    }
    expect(policyDomainForTrustedOrigin(origin)).toBe('im')
    expect(origin).toEqual({
      entry: 'wechat', lane: 'wechat', recipient: 'third-party',
      sessionCreatedBy: 'desktop', outboundTarget: 'group'
    })
  })
})
