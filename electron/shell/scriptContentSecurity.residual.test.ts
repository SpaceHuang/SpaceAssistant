import { describe, expect, it } from 'vitest'
import { analyzeScriptContent } from './scriptContentSecurity'

/** Residual known-bypass fixtures — these must not be mistaken for listed B1–B11 hits. */
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

describe('scriptContentSecurity — residual pattern facts', () => {
  it('R1 — variable attr name is not reported as a listed B pattern', () => {
    const result = analyzeScriptContent(RESIDUAL_FIXTURES.R1)
    expect(result.findings.map((finding) => finding.pattern)).not.toEqual(expect.arrayContaining(B_PATTERN_IDS))
  })

  it('R2 — a distant decode does not create B11; direct exec still creates A3', () => {
    const result = analyzeScriptContent(RESIDUAL_FIXTURES.R2)
    const ids = result.findings.map((finding) => finding.pattern)
    expect(ids).toContain('A3')
    expect(ids).not.toContain('B11')
  })

  it('R3 — FunctionType construction does not synthesize a listed B pattern', () => {
    const result = analyzeScriptContent(RESIDUAL_FIXTURES.R3)
    expect(result.findings.map((finding) => finding.pattern)).not.toEqual(expect.arrayContaining(B_PATTERN_IDS))
  })

  it('findings are caller-independent; remote certification is emitted by its separate extractor', () => {
    const result = analyzeScriptContent(RESIDUAL_FIXTURES.R1)
    expect(result).toMatchObject({ coverage: 'complete' })
    expect(result).not.toHaveProperty('verdict')
  })
})
