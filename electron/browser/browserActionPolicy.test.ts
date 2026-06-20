import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'
import type { ActDangerAssessment } from './browserActionPolicy'
import {
  browserActionConsumesInference,
  browserActionNeedsConfirmation,
  keywordToConsequence,
  matchHighRiskKeyword
} from './browserActionPolicy'
import {
  rememberBrowserSessionActTrust,
  rememberBrowserSessionTrustedUrl,
  resetBrowserSessionTrustForTests
} from './browserSessionTrust'

describe('browserActionNeedsConfirmation act trust', () => {
  afterEach(() => {
    resetBrowserSessionTrustForTests()
  })

  it('act requires confirm by default', () => {
    expect(browserActionNeedsConfirmation('act', {}, DEFAULT_BROWSER_CONFIG)).toBe(true)
  })

  it('act skips confirm when disabled', () => {
    expect(
      browserActionNeedsConfirmation('act', {}, { ...DEFAULT_BROWSER_CONFIG, actRequiresConfirm: false })
    ).toBe(false)
  })

  it('act requires confirm when no current page url', () => {
    expect(
      browserActionNeedsConfirmation('act', {}, DEFAULT_BROWSER_CONFIG, 'sess', undefined)
    ).toBe(true)
  })

  it('act session trust hit skips confirm', () => {
    rememberBrowserSessionActTrust('sess-x', 'https://www.github.com/repo')
    expect(
      browserActionNeedsConfirmation(
        'act',
        {},
        DEFAULT_BROWSER_CONFIG,
        'sess-x',
        'https://docs.github.com/en'
      )
    ).toBe(false)
  })

  it('act persistent trust hit skips confirm', () => {
    expect(
      browserActionNeedsConfirmation(
        'act',
        {},
        { ...DEFAULT_BROWSER_CONFIG, actTrustedDomains: ['github.com'] },
        'sess-new',
        'https://api.github.com'
      )
    ).toBe(false)
  })

  it('actSessionTrustEnabled=false always confirms', () => {
    rememberBrowserSessionActTrust('sess-x', 'https://github.com')
    expect(
      browserActionNeedsConfirmation(
        'act',
        {},
        { ...DEFAULT_BROWSER_CONFIG, actSessionTrustEnabled: false },
        'sess-x',
        'https://github.com'
      )
    ).toBe(true)
  })

  it('dangerous act always confirms regardless of trust', () => {
    rememberBrowserSessionActTrust('sess-x', 'https://github.com')
    const danger: ActDangerAssessment = {
      dangerous: true,
      source: 'keyword',
      userReason: '指令提到「支付」',
      consequence: 'money',
      detail: '支付'
    }
    expect(
      browserActionNeedsConfirmation(
        'act',
        { instruction: '支付' },
        DEFAULT_BROWSER_CONFIG,
        'sess-x',
        'https://github.com',
        danger
      )
    ).toBe(true)
  })

  it('persistent trust takes precedence path with session also trusted', () => {
    rememberBrowserSessionActTrust('sess-x', 'https://github.com')
    expect(
      browserActionNeedsConfirmation(
        'act',
        {},
        { ...DEFAULT_BROWSER_CONFIG, actTrustedDomains: ['github.com'] },
        'sess-x',
        'https://github.com'
      )
    ).toBe(false)
  })

  it('matchHighRiskKeyword maps payment to money consequence', () => {
    expect(matchHighRiskKeyword('点击支付按钮', DEFAULT_BROWSER_CONFIG.actHighRiskKeywords)).toBe('支付')
    expect(keywordToConsequence('支付')).toBe('money')
  })
})

describe('browserActionNeedsConfirmation navigate', () => {
  afterEach(() => {
    resetBrowserSessionTrustForTests()
  })

  it('navigate open to unknown domain requires confirm', () => {
    expect(
      browserActionNeedsConfirmation(
        'navigate',
        { mode: 'open', url: 'https://unknown.com' },
        DEFAULT_BROWSER_CONFIG
      )
    ).toBe(true)
  })

  it('navigate open to trusted domain skips confirm', () => {
    expect(
      browserActionNeedsConfirmation(
        'navigate',
        { mode: 'open', url: 'https://trusted.com' },
        { ...DEFAULT_BROWSER_CONFIG, trustedDomains: ['trusted.com'] }
      )
    ).toBe(false)
  })

  it('navigate open skips confirm when host approved in session', () => {
    rememberBrowserSessionTrustedUrl('sess-x', 'https://www.sohu.com/page')
    expect(
      browserActionNeedsConfirmation(
        'navigate',
        { mode: 'open', url: 'https://news.sohu.com/other' },
        DEFAULT_BROWSER_CONFIG,
        'sess-x'
      )
    ).toBe(false)
  })
})

describe('browserActionConsumesInference', () => {
  it('observe/extract/act consume', () => {
    expect(browserActionConsumesInference('observe')).toBe(true)
    expect(browserActionConsumesInference('extract')).toBe(true)
    expect(browserActionConsumesInference('act')).toBe(true)
  })
})
