import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pathIdentity } from './pathIdentity'

describe('pathIdentity', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

  it('uses realpath for existing paths and lexical normalization for absent paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-identity-'))
    dirs.push(root)
    const existing = path.join(root, 'actual.txt')
    fs.writeFileSync(existing, 'x')

    // On win32 the identity is the case-folded, forward-slash normalized path; on other
    // platforms it is the filesystem realpath for the existing file and the lexical
    // normalized path for an absent one.
    const expectedExisting =
      process.platform === 'win32'
        ? path.win32.normalize(path.join(root, '.', 'actual.txt')).replace(/\\/g, '/').toLowerCase()
        : fs.realpathSync(existing)
    const expectedAbsent =
      process.platform === 'win32'
        ? path.win32.normalize(path.join(root, 'nested', '..', 'new.txt')).replace(/\\/g, '/').toLowerCase()
        : path.normalize(path.join(root, 'new.txt'))

    expect(pathIdentity(path.join(root, '.', 'actual.txt'))).toBe(expectedExisting)
    expect(pathIdentity(path.join(root, 'nested', '..', 'new.txt'))).toBe(expectedAbsent)
  })

  it('normalizes Windows separators and case while rejecting ambiguous aliases', () => {
    expect(pathIdentity('C:\\Work\\Reports\\FINAL.TXT', { platform: 'win32' })).toBe('c:/work/reports/final.txt')
    expect(() => pathIdentity('C:\\Work\\CON.txt', { platform: 'win32' })).toThrow(/device name/i)
    expect(() => pathIdentity('C:\\Work\\report. ', { platform: 'win32' })).toThrow(/trailing/i)
  })
})
