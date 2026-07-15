import { describe, expect, it } from 'vitest'
import { analyzeScriptContent } from './scriptContentSecurity'

/** Residual known-bypass fixtures — must NOT include B1–B11 patterns. */
const RESIDUAL_FIXTURES = {
  R1: "import os\nname = 'system'\ngetattr(os, name)('id')",
  R2: `import base64
t = base64.b64decode('cGFzcw==')
x = 1
y = 2
z = 3
w = 4
exec(t)`,
  R3: `import types
import marshal
code = marshal.loads(b'...')
types.FunctionType(code, globals())()`
}

const B_PATTERN_IDS = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11']

describe('scriptContentSecurity — List R (residual known bypass)', () => {
  it('R1 — variable attr name getattr(os, name) → allow (known bypass)', () => {
    const r = analyzeScriptContent(RESIDUAL_FIXTURES.R1, { remote: false })
    expect(r.verdict).toBe('allow')
    expect(r.patterns).not.toEqual(expect.arrayContaining(B_PATTERN_IDS))
  })

  it('R2 — multi-step decode beyond B11 window: no B11, but direct exec still A3 ask', () => {
    // Past B11 adjacency window so B11 must not fire; bare exec() is still A3 (not residual).
    const r = analyzeScriptContent(RESIDUAL_FIXTURES.R2, { remote: false })
    expect(r.verdict).toBe('ask')
    expect(r.patterns).toContain('A3')
    expect(r.patterns).not.toContain('B11')
    for (const b of B_PATTERN_IDS) {
      expect(r.patterns).not.toContain(b)
    }
  })

  it('R3 — marshal / FunctionType bytecode → allow (known bypass)', () => {
    const r = analyzeScriptContent(RESIDUAL_FIXTURES.R3, { remote: false })
    expect(r.verdict).toBe('allow')
    for (const b of B_PATTERN_IDS) {
      expect(r.patterns).not.toContain(b)
    }
  })

  it('residual fixtures must not be named or tagged as known-bypass for B patterns', () => {
    const fixtureKeys = Object.keys(RESIDUAL_FIXTURES)
    for (const key of fixtureKeys) {
      expect(key.startsWith('R')).toBe(true)
      expect(key).not.toMatch(/^B\d/)
    }
    for (const code of Object.values(RESIDUAL_FIXTURES)) {
      for (const b of B_PATTERN_IDS) {
        expect(code).not.toContain(`/* ${b} */`)
        expect(code).not.toContain(`# ${b} known bypass`)
      }
    }
  })

  it('B-style examples are absent from residual file fixtures', () => {
    const bShapes = [
      "getattr(__import__('o'+'s'), 'sys'+'tem')",
      'import os as o',
      'from os import system as s',
      "getattr(x, 'system')"
    ]
    for (const code of Object.values(RESIDUAL_FIXTURES)) {
      for (const shape of bShapes) {
        expect(code).not.toContain(shape)
      }
    }
  })
})
