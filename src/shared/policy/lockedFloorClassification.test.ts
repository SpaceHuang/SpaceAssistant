import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_RULES } from './defaultRules'

describe('locked policy floor classification', () => {
  it('classifies every locked default policy rule in the Phase 2 inventory', () => {
    const document = fs.readFileSync(path.resolve(__dirname, '../../../docs/develop/security-policy-locked-floor-classification.md'), 'utf8')
    const registeredIds = new Set([...document.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((match) => match[1]!))
    const missing = DEFAULT_POLICY_RULES.filter((rule) => rule.locked && !registeredIds.has(rule.id)).map((rule) => rule.id)
    expect(missing).toEqual([])
  })
})
