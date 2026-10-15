import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REGISTERED_POST_DECISION_TERMINALS = new Set([
  // Pre-decision validation / immutable execution invariants. These keep their source rule IDs
  // and are classified separately in the candidate inventory.
  'shell-precheck-deny',
  'rules-violated',
  'recursion-guard',
  'recheck-requires-confirm',
  'read-confirmation-registration-failed'
])

function findUnregisteredVerdictOverrides(source: string): string[] {
  const ids = [...source.matchAll(/(?:result\.)?decision\s*=\s*\{\s*type:\s*'(?:deny|require-confirm|auto-allow)'[\s\S]{0,240}?ruleId:\s*'([^']+)'/g)]
    .map((match) => match[1]!)
  return ids.filter((id) => !REGISTERED_POST_DECISION_TERMINALS.has(id))
}

describe('policy decision single-source architecture guard', () => {
  it('detects a newly added unregistered post-decision verdict branch', () => {
    expect(findUnregisteredVerdictOverrides("decision = { type: 'deny', ruleId: 'unregistered-product-veto' }")).toEqual(['unregistered-product-veto'])
  })

  it('keeps post-decision tool gate verdict changes limited to named invariants and validators', () => {
    const gate = fs.readFileSync(path.join(__dirname, 'toolCallGate.ts'), 'utf8')
    expect(findUnregisteredVerdictOverrides(gate)).toEqual([])
  })

  it('does not let confirmation-port approval branches reinterpret the requested action class', () => {
    const port = fs.readFileSync(path.join(__dirname, 'agentSdkConfirmationPort.ts'), 'utf8')
    expect(port).not.toMatch(/actionClass\s*===\s*['"]outbound['"][\s\S]{0,180}(?:denied|deny|POLICY_DENY)/)
  })
})
