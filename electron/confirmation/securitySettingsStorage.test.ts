import { afterEach, describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { createSecuritySettingsStorage } from './securitySettingsStorage'

describe('security settings storage adapter', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
  })

  it('owns PolicyRuleStore and decision-cache persistence behind a narrow adapter', () => {
    const temp = createTempDatabase('security-settings-storage-')
    cleanup = temp.cleanup
    const storage = createSecuritySettingsStorage(temp.db)

    expect(storage.listRuleOverrides()).toEqual([])
    storage.setOverride({ ruleId: 'test-rule', action: 'ask', params: { threshold: 2 } })
    expect(storage.getOverride('test-rule')).toEqual({ ruleId: 'test-rule', action: 'ask', params: { threshold: 2 } })
    expect(storage.listRuleOverrides()).toEqual([{ ruleId: 'test-rule', action: 'ask', params: { threshold: 2 } }])
    expect(storage.removeOverride('test-rule')).toBe(1)
    expect(storage.listRuleOverrides()).toEqual([])
    expect(storage.listDecisionCache()).toEqual([])
    expect(storage.clearDecisionCache({ kind: 'remote-write', sessionId: 'session-test' })).toBe(0)
    expect(storage.clearAllDecisionCache()).toBe(0)
  })
})
