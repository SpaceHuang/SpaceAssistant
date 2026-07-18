import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactPathIdentity } from './pathIdentity'

describe('artifactPathIdentity', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

  it('uses realpath for existing paths and lexical normalization for absent paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-identity-'))
    dirs.push(root)
    const existing = path.join(root, 'actual.txt')
    fs.writeFileSync(existing, 'x')

    expect(artifactPathIdentity(path.join(root, '.', 'actual.txt'))).toBe(fs.realpathSync(existing))
    expect(artifactPathIdentity(path.join(root, 'nested', '..', 'new.txt'))).toBe(path.normalize(path.join(root, 'new.txt')))
  })
})
