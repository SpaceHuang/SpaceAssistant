import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'
import {
  browserActionConsumesInference,
  browserActionNeedsConfirmation
} from './browserActionPolicy'
import { rememberBrowserSessionTrustedUrl, resetBrowserSessionTrustForTests } from './browserSessionTrust'

describe('browserActionNeedsConfirmation', () => {
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

  it('navigate refresh does not require confirm', () => {
    expect(browserActionNeedsConfirmation('navigate', { mode: 'refresh' }, DEFAULT_BROWSER_CONFIG)).toBe(
      false
    )
  })

  it('navigate back/forward do not require confirm', () => {
    expect(browserActionNeedsConfirmation('navigate', { mode: 'back' }, DEFAULT_BROWSER_CONFIG)).toBe(false)
    expect(browserActionNeedsConfirmation('navigate', { mode: 'forward' }, DEFAULT_BROWSER_CONFIG)).toBe(
      false
    )
  })

  it('observe/extract/screenshot/close do not require confirm', () => {
    expect(browserActionNeedsConfirmation('observe', {}, DEFAULT_BROWSER_CONFIG)).toBe(false)
    expect(browserActionNeedsConfirmation('extract', {}, DEFAULT_BROWSER_CONFIG)).toBe(false)
    expect(browserActionNeedsConfirmation('screenshot', {}, DEFAULT_BROWSER_CONFIG)).toBe(false)
    expect(browserActionNeedsConfirmation('close', {}, DEFAULT_BROWSER_CONFIG)).toBe(false)
  })
})

describe('browserActionConsumesInference', () => {
  it('observe/extract/act consume', () => {
    expect(browserActionConsumesInference('observe')).toBe(true)
    expect(browserActionConsumesInference('extract')).toBe(true)
    expect(browserActionConsumesInference('act')).toBe(true)
  })

  it('navigate/screenshot/close do not consume', () => {
    expect(browserActionConsumesInference('navigate')).toBe(false)
    expect(browserActionConsumesInference('screenshot')).toBe(false)
    expect(browserActionConsumesInference('close')).toBe(false)
  })
})
