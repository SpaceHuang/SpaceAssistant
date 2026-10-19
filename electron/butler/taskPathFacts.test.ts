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

  it('reports Git repositories found at authorized roots as local facts', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-path-facts-git-'))
    await fs.mkdir(path.join(root, '.git'))

    const facts = await new TaskPathFactsProvider().collect([root])

    expect(facts.gitRepositories).toEqual([await fs.realpath(root)])
    expect(facts.entries.some((entry) => entry.path.includes(`${path.sep}.git${path.sep}`))).toBe(false)
    expect(facts.digest).toBeTruthy()
  })

  it('recognizes worktree .git files and nested repositories without following marker symlinks', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-path-facts-nested-git-'))
    const nested = path.join(root, 'project')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, '.git'), 'gitdir: ../.git/worktrees/project')
    const symlinkRepo = path.join(root, 'linked')
    await fs.mkdir(symlinkRepo)
    await fs.symlink(path.join(nested, '.git'), path.join(symlinkRepo, '.git'))

    const facts = await new TaskPathFactsProvider().collect([root])

    expect(facts.gitRepositories).toEqual([await fs.realpath(nested)])
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

  it('reports the output root separately without scanning its contents and permits no authorized read roots', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-output-facts-'))
    const authorizedRoot = path.join(root, 'authorized')
    const outputRoot = path.join(root, 'output')
    await fs.mkdir(authorizedRoot)
    await fs.mkdir(outputRoot)
    await fs.mkdir(path.join(outputRoot, '.git'))
    await fs.writeFile(path.join(outputRoot, 'private-existing.csv'), 'must not be read as a task input')

    const facts = await new TaskPathFactsProvider().collect([authorizedRoot], outputRoot)
    expect(facts.roots).toEqual([await fs.realpath(authorizedRoot)])
    expect(facts.outputRoot).toBe(await fs.realpath(outputRoot))
    expect(facts.outputRootIsGitRepository).toBe(true)
    expect(facts.entries.map((entry) => entry.path)).not.toContain(path.join(await fs.realpath(outputRoot), 'private-existing.csv'))
    expect(facts.entries.map((entry) => entry.path)).not.toContain(path.join(await fs.realpath(outputRoot), '.git'))

    const outputOnly = await new TaskPathFactsProvider().collect([], outputRoot)
    expect(outputOnly.roots).toEqual([])
    expect(outputOnly.outputRoot).toBe(await fs.realpath(outputRoot))
    expect(outputOnly.outputRootIsGitRepository).toBe(true)
    expect(outputOnly.entries).toEqual([])
  })
})
