import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WritePathFact } from './extractors/writePathFacts'
import { isReviewScopeWriteEligible, projectReviewScopeEditResult, REVIEW_SCOPE_SCRIPT_EXTENSIONS } from './reviewScopeEligibility'

const dirs: string[] = []
async function root(): Promise<string> {
  const value = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-eligible-')))
  dirs.push(value)
  await fs.mkdir(path.join(value, '.git'))
  return value
}
function fact(target: string, kind: 'file' | 'missing' = 'missing', mode = 0o100600): WritePathFact {
  return { rawPath: target, normalizedPath: target, zone: 'workdir-normal', targetKind: kind, parentReal: path.dirname(target),
    parentIdentity: { dev: 1, ino: 1, mode: 0o40755, size: 1, mtimeMs: 1 },
    ...(kind === 'file' ? { identity: { dev: 1, ino: 2, mode, size: 8, mtimeMs: 1, nlink: 1 } } : {}) }
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))) })

describe('review scope target eligibility', () => {
  it('pins the complete ASCII case-insensitive script extension set', async () => {
    expect(REVIEW_SCOPE_SCRIPT_EXTENSIONS).toEqual(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.ps1', '.bat', '.cmd', '.rb', '.pl', '.php'])
    const workDir = await root()
    for (const extension of REVIEW_SCOPE_SCRIPT_EXTENSIONS) {
      const target = path.join(workDir, `ordinary${extension.toUpperCase()}`)
      expect(await isReviewScopeWriteEligible({ target: fact(target), workDir })).toBe(false)
    }
  })

  it('excludes POSIX executable bits, shebang, ELF, Mach-O, and valid bounded PE headers', async () => {
    const workDir = await root()
    const target = path.join(workDir, 'program.bin')
    expect(await isReviewScopeWriteEligible({ target: fact(target), workDir, proposedContent: '#!/bin/sh\necho hi' })).toBe(false)
    expect(await isReviewScopeWriteEligible({ target: fact(target), workDir, proposedContent: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) })).toBe(false)
    expect(await isReviewScopeWriteEligible({ target: fact(target), workDir, proposedContent: Buffer.from([0xfe, 0xed, 0xfa, 0xce]) })).toBe(false)
    const pe = Buffer.alloc(0x44); pe[0] = 0x4d; pe[1] = 0x5a; pe.writeUInt32LE(0x40, 0x3c); pe.set([0x50, 0x45, 0, 0], 0x40)
    expect(await isReviewScopeWriteEligible({ target: fact(target), workDir, proposedContent: pe })).toBe(false)
    if (process.platform !== 'win32') expect(await isReviewScopeWriteEligible({ target: fact(target, 'file', 0o100755), workDir })).toBe(false)
  })

  it('matches only the fixed single-level CI paths relative to the Git root', async () => {
    const workDir = await root()
    const allowed = ['.github/workflows/build.yml', '.github/workflows/deploy.YAML', '.gitlab-ci.yml', '.circleci/config.yml']
    const disallowed = ['.github/workflows/nested/build.yml', '.gitlab-ci.yaml', '.circleci/nested/config.yml', 'notes-ci.yml']
    for (const relative of allowed) expect(await isReviewScopeWriteEligible({ target: fact(path.join(workDir, relative)), workDir })).toBe(false)
    for (const relative of disallowed) expect(await isReviewScopeWriteEligible({ target: fact(path.join(workDir, relative)), workDir })).toBe(true)
  })

  it('misses when an existing target cannot be securely inspected', async () => {
    const workDir = await root()
    const target = path.join(workDir, 'normal.txt')
    await fs.writeFile(target, 'safe text')
    const stat = await fs.stat(target)
    expect(await isReviewScopeWriteEligible({ target: { ...fact(target, 'file'), identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink } }, workDir })).toBe(true)
    expect(await isReviewScopeWriteEligible({ target: fact(target, 'file'), workDir })).toBe(false)
  })

  it('projects the actual replace_all result before checking executable headers', async () => {
    const workDir = await root()
    const target = path.join(workDir, 'normal.txt')
    await fs.writeFile(target, 'draft\nDRAFT\n')
    const stat = await fs.stat(target)
    const writeFact: WritePathFact = { ...fact(target, 'file'), identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode,
      size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink } }
    const result = await projectReviewScopeEditResult({ target: writeFact, oldString: 'draft', newString: '#!/bin/sh', replaceAll: true, tolerateEscapeLayer: false })
    expect(result).toBe('#!/bin/sh\nDRAFT\n')
    expect(await isReviewScopeWriteEligible({ target: writeFact, workDir, proposedContent: result })).toBe(false)
    await expect(projectReviewScopeEditResult({ target: writeFact, oldString: 'draft', newString: 'x', replaceAll: false, tolerateEscapeLayer: true }))
      .resolves.toBeUndefined()
  })
})
