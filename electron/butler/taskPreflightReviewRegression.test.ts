import { expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../database'
import { createAutomationTask, updateAutomationTask } from './taskStore'
import { TaskPathFactsProvider } from './taskPathFacts'
import { runTaskPreflight } from './taskPreflight'
import { resolveTaskTarget, validatePersistedTargetBindings } from './taskTargetResolver'

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-preflight-review-')))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('accepts the canonical root for collections and the first output', async () => withRoot(async (root) => {
  const facts = await new TaskPathFactsProvider().collect([root])

  expect(resolveTaskTarget({
    rawText: 'process all CSV files',
    target: { kind: 'collection', directory: root, selector: '*.csv' },
    roots: [root], facts, taskRevision: 1
  })).toMatchObject({ ok: true, binding: { kind: 'collection', directory: root } })
  expect(resolveTaskTarget({
    rawText: 'write output',
    target: { kind: 'output', path: path.join(root, 'out.txt'), expectedType: 'file' },
    roots: [root], facts, taskRevision: 1
  })).toMatchObject({ ok: true, binding: { kind: 'output', ancestor: root } })
}))

it('revalidates the extracted basename without parsing the full prompt', async () => withRoot(async (root) => {
  await writeFile(path.join(root, 'report.csv'), 'a')
  await mkdir(path.join(root, 'tools'), { recursive: true })
  await writeFile(path.join(root, 'tools', 'notes.txt'), 'b')
  const facts = await new TaskPathFactsProvider().collect([root])
  const resolved = resolveTaskTarget({
    rawText: 'Read report.csv and summarize it, using /tools/notes.txt as context',
    target: { kind: 'exact', path: 'report.csv', targetType: 'file' },
    roots: [root], facts, taskRevision: 1
  })
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) return

  expect(validatePersistedTargetBindings({ bindings: [resolved.binding], roots: [root], facts, taskRevision: 1 })).toEqual({ ok: true })
  await mkdir(path.join(root, 'nested'), { recursive: true })
  await writeFile(path.join(root, 'nested', 'report.csv'), 'c')
  const changedFacts = await new TaskPathFactsProvider().collect([root])
  expect(validatePersistedTargetBindings({ bindings: [resolved.binding], roots: [root], facts: changedFacts, taskRevision: 1 }))
    .toEqual({ ok: false, code: 'TARGET_AMBIGUOUS_OR_CHANGED' })
}))

it('keeps binding revision valid after creation and repeated run metadata writes', async () => withRoot(async (root) => {
  await writeFile(path.join(root, 'report.csv'), 'a')
  const facts = await new TaskPathFactsProvider().collect([root])
  const resolved = resolveTaskTarget({
    rawText: 'report.csv',
    target: { kind: 'exact', path: 'report.csv', targetType: 'file' },
    roots: [root], facts, taskRevision: 1
  })
  if (!resolved.ok) throw new Error('test setup could not resolve report.csv')

  const db = openDatabase(':memory:')
  try {
    const task = createAutomationTask(db, {
      name: 'probe', prompt: 'report.csv', schedule: { kind: 'interval', intervalMinutes: 30 },
      deliveryPref: 'none', workDirs: [root]
    }, { targetBindings: [resolved.binding] })
    const validate = (revision: number, targetBindingsJson: string | null | undefined) => validatePersistedTargetBindings({
      bindings: JSON.parse(targetBindingsJson ?? '[]'), roots: [root], facts, taskRevision: revision
    })

    expect(task.taskRevision).toBe(1)
    expect(validate(task.taskRevision!, task.targetBindingsJson)).toEqual({ ok: true })
    updateAutomationTask(db, task.id, { lastRunAt: Date.now(), nextRunAt: Date.now() + 30_000 })
    const updated = updateAutomationTask(db, task.id, { lastRunAt: Date.now(), nextRunAt: Date.now() + 60_000 })!
    expect(updated.taskRevision).toBe(1)
    expect(validate(updated.taskRevision!, updated.targetBindingsJson)).toEqual({ ok: true })
  } finally {
    db.close()
  }
}))

it('rejects resolver and runtime validation when depth-limited facts omit a same-name target', async () => withRoot(async (root) => {
  await writeFile(path.join(root, 'report.csv'), 'shallow')
  const initialFacts = await new TaskPathFactsProvider().collect([root])
  const initial = resolveTaskTarget({
    rawText: 'read report.csv',
    target: { kind: 'exact', path: 'report.csv', targetType: 'file' },
    roots: [root], facts: initialFacts, taskRevision: 1
  })
  expect(initial.ok).toBe(true)

  await mkdir(path.join(root, 'a', 'b', 'c'), { recursive: true })
  await writeFile(path.join(root, 'a', 'b', 'c', 'report.csv'), 'deep duplicate')
  const facts = await new TaskPathFactsProvider().collect([root])
  expect(facts.entries.some((entry) => entry.path.endsWith('/a/b/c/report.csv'))).toBe(false)
  expect(facts.coverage).toMatchObject({ complete: false, truncated: true })
  expect(resolveTaskTarget({
    rawText: 'read report.csv',
    target: { kind: 'exact', path: 'report.csv', targetType: 'file' },
    roots: [root], facts, taskRevision: 1
  })).toMatchObject({ ok: false, issue: { code: 'FACTS_INCOMPLETE' } })
  if (initial.ok) {
    expect(validatePersistedTargetBindings({ bindings: [initial.binding], roots: [root], facts, taskRevision: 1 }))
      .toEqual({ ok: false, code: 'FACTS_INCOMPLETE' })
  }
}))

it('preflights, saves, and revalidates an explicit deep path from direct host facts', async () => withRoot(async (root) => {
  const deepDirectory = path.join(root, '1', '2', '3', '4')
  await mkdir(deepDirectory, { recursive: true })
  const targetPath = path.join(deepDirectory, 'note.txt')
  await writeFile(targetPath, 'deep content')
  const prompt = `Read ${targetPath}`
  const analysis = {
    targets: [{ kind: 'exact' as const, path: targetPath, targetType: 'file' as const }],
    mockTrace: [{ kind: 'proposed-tool-call' as const, toolName: 'read_file', input: { path: targetPath }, dispatch: 'simulated' as const, resultKind: 'synthetic' as const }]
  }
  const preflight = await runTaskPreflight({
    prompt, scheduleSummary: 'daily', deliverySummary: 'none', roots: [root], taskRevision: 1
  }, { analyzer: { analyze: async () => analysis } })

  expect(preflight.report).toMatchObject({ status: 'passed', blockers: [] })
  expect(preflight.bindings).toMatchObject([{ kind: 'exact', path: targetPath, targetType: 'file', targetReference: { kind: 'path', value: targetPath } }])

  const db = openDatabase(':memory:')
  try {
    const task = createAutomationTask(db, {
      name: 'deep explicit target', prompt, schedule: { kind: 'interval', intervalMinutes: 30 },
      deliveryPref: 'none', workDirs: [root]
    }, { targetBindings: preflight.bindings })
    const provider = new TaskPathFactsProvider()
    const runtimeFacts = await provider.collect([root])
    const exactFacts = await provider.inspectPaths([targetPath])
    const withDirectFacts = { ...runtimeFacts, proposedPathCandidates: exactFacts }
    expect(validatePersistedTargetBindings({
      bindings: JSON.parse(task.targetBindingsJson ?? '[]'), roots: [root], facts: withDirectFacts, taskRevision: task.taskRevision!
    })).toEqual({ ok: true })

    await rm(targetPath)
    await symlink(path.join(root, 'outside.txt'), targetPath)
    const symlinkFacts = { ...await provider.collect([root]), proposedPathCandidates: await provider.inspectPaths([targetPath]) }
    expect(validatePersistedTargetBindings({
      bindings: JSON.parse(task.targetBindingsJson ?? '[]'), roots: [root], facts: symlinkFacts, taskRevision: task.taskRevision!
    })).toMatchObject({ ok: false })

    await rm(targetPath)
    await mkdir(targetPath)
    const changedTypeFacts = { ...await provider.collect([root]), proposedPathCandidates: await provider.inspectPaths([targetPath]) }
    expect(validatePersistedTargetBindings({
      bindings: JSON.parse(task.targetBindingsJson ?? '[]'), roots: [root], facts: changedTypeFacts, taskRevision: task.taskRevision!
    })).toMatchObject({ ok: false })

    const movedOutsidePath = path.join(path.dirname(root), `${path.basename(root)}-moved-note.txt`)
    await rm(targetPath, { recursive: true, force: true })
    await writeFile(movedOutsidePath, 'moved outside the authorized root')
    try {
      const movedFacts = { ...await provider.collect([root]), proposedPathCandidates: await provider.inspectPaths([targetPath]) }
      expect(validatePersistedTargetBindings({
        bindings: JSON.parse(task.targetBindingsJson ?? '[]'), roots: [root], facts: movedFacts, taskRevision: task.taskRevision!
      })).toMatchObject({ ok: false })
    } finally {
      await rm(movedOutsidePath, { force: true })
    }
  } finally {
    db.close()
  }
}))
