import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TaskPathFactsProvider } from './taskPathFacts'

describe('TaskPathFactsProvider', () => {
  let root = ''
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = '' })

  it('only reports entries inside canonical roots and produces a stable digest', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-path-facts-'))
    await fs.mkdir(path.join(root, 'reports'))
    await fs.writeFile(path.join(root, 'reports', 'a.csv'), 'x')
    const provider = new TaskPathFactsProvider()
    const first = await provider.collect([root])
    const second = await provider.collect([root])
    expect(first.entries.map((entry) => entry.path)).toContain(await fs.realpath(path.join(root, 'reports', 'a.csv')))
    expect(first.digest).toBe(second.digest)
    expect(first.coverage).toMatchObject({ complete: true, roots: 1, visited: expect.any(Number) })
  })

  it('fails closed when scan bounds are exceeded', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-path-facts-bound-'))
    for (let index = 0; index < 4; index += 1) await fs.writeFile(path.join(root, `${index}.txt`), 'x')
    const result = await new TaskPathFactsProvider({ maxEntriesPerRoot: 2 }).collect([root])
    expect(result.coverage.complete).toBe(false)
    expect(result.coverage.truncated).toBe(true)
  })

  it('rejects empty roots and never traverses outside a selected root', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-path-facts-boundary-'))
    await expect(new TaskPathFactsProvider().collect([])).rejects.toMatchObject({ code: 'NO_ROOTS' })
    const facts = await new TaskPathFactsProvider().collect([root])
    const canonicalRoot = await fs.realpath(root)
    expect(facts.entries.every((entry) => entry.path === canonicalRoot || entry.path.startsWith(`${canonicalRoot}${path.sep}`))).toBe(true)
  })
})
