import { describe, expect, it } from 'vitest'
import {
  getOrCreateProvenanceContext,
  hashScript,
  isAgentGeneratedRunScript,
  normalizeScriptBody,
  recordReadFileForProvenance,
  recordWriteFileForProvenance,
  clearAllProvenanceContexts
} from './runScriptProvenance'

function ctx() {
  clearAllProvenanceContexts()
  return getOrCreateProvenanceContext('req-1')
}

describe('runScriptProvenance', () => {
  it('R1: inline os.makedirs is agent-generated', () => {
    const c = ctx()
    const code = 'import os\nos.makedirs("foo", exist_ok=True)'
    expect(isAgentGeneratedRunScript(code, c)).toBe(true)
  })

  it('R2: read existing legacy.py then run same content is not agent-generated', () => {
    const c = ctx()
    const code = 'print("legacy")\n'
    recordReadFileForProvenance(c, 'legacy.py', code)
    expect(isAgentGeneratedRunScript(code, c)).toBe(false)
  })

  it('R3: write-then-run same content is agent-generated', () => {
    const c = ctx()
    const code = 'print("setup")\n'
    recordWriteFileForProvenance(c, 'setup.py', code)
    expect(isAgentGeneratedRunScript(code, c)).toBe(true)
  })

  it('normalizeScriptBody strips shebang and normalizes newlines', () => {
    expect(normalizeScriptBody('#!/usr/bin/env python\r\nx=1')).toBe('x=1')
    expect(hashScript('#!/usr/bin/env python\nx=1')).toBe(hashScript('x=1'))
  })
})
