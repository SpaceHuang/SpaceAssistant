import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { uniqueFilePath } from './tempPaths'

describe('uniqueFilePath', () => {
  it('returns distinct, nonexistent file paths under the temporary directory', () => {
    const first = uniqueFilePath('sa-test-', '.json')
    const second = uniqueFilePath('sa-test-', '.json')
    expect(path.relative(os.tmpdir(), first)).not.toMatch(/^\.\./)
    expect(first).not.toBe(second)
    expect(fs.existsSync(first)).toBe(false)
    expect(fs.existsSync(second)).toBe(false)
  })
})
