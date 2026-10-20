import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveTaskTarget, validatePersistedTargetBindings } from './taskTargetResolver'
import type { TaskPathFacts } from './taskPathFacts'

function facts(root: string, entries: TaskPathFacts['entries'], complete = true): TaskPathFacts {
  return { roots: [root], gitRepositories: [], entries, coverage: { complete, truncated: !complete, roots: 1, visited: entries.length, errors: 0 }, digest: 'facts-digest' }
}

describe('resolveTaskTarget', () => {
  const root = '/workspace'

  it('resolves one unambiguous root basename to an exact binding', () => {
    const result = resolveTaskTarget({ rawText: 'read report.csv', target: { kind: 'exact', path: 'report.csv', targetType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/report.csv`, relativePath: 'report.csv', kind: 'file' }]), taskRevision: 3 })
    expect(result).toMatchObject({ ok: true, binding: { kind: 'exact', path: `${root}/report.csv`, targetReference: { kind: 'basename', value: 'report.csv' }, resolverVersion: 3, taskRevision: 3 } })
  })

  it('blocks basename ambiguity and incomplete coverage', () => {
    const ambiguous = resolveTaskTarget({ rawText: 'read report.csv', target: { kind: 'exact', path: 'report.csv', targetType: 'file' }, roots: [root], facts: facts(root, [
      { path: `${root}/a/report.csv`, relativePath: 'a/report.csv', kind: 'file' },
      { path: `${root}/b/report.csv`, relativePath: 'b/report.csv', kind: 'file' }
    ]), taskRevision: 1 })
    expect(ambiguous).toMatchObject({ ok: false, issue: { code: 'TARGET_AMBIGUOUS' } })
    const incomplete = resolveTaskTarget({ rawText: 'read report.csv', target: { kind: 'exact', path: 'report.csv', targetType: 'file' }, roots: [root], facts: facts(root, [], false), taskRevision: 1 })
    expect(incomplete).toMatchObject({ ok: false, issue: { code: 'FACTS_INCOMPLETE' } })
  })

  it('resolves an explicit root target from its direct fact when unrelated descendants are truncated', () => {
    const partialFacts = facts(root, [{ path: root, relativePath: '', kind: 'directory' }], false)
    const resolved = resolveTaskTarget({
      rawText: root,
      target: { kind: 'exact', path: root, targetType: 'directory' },
      roots: [root], facts: partialFacts, taskRevision: 3
    })
    expect(resolved).toMatchObject({ ok: true, binding: { kind: 'exact', path: root, targetReference: { kind: 'path', value: root } } })
    if (!resolved.ok) return
    expect(validatePersistedTargetBindings({ bindings: [resolved.binding], roots: [root], facts: partialFacts, taskRevision: 3 })).toEqual({ ok: true })
  })

  it('binds a directly verified collection directory on partial facts', () => {
    const partialFacts = facts(root, [{ path: root, relativePath: '', kind: 'directory' }], false)
    const resolved = resolveTaskTarget({
      rawText: 'process all CSV files in the repository',
      target: { kind: 'collection', directory: root, selector: '*.csv' },
      roots: [root], facts: partialFacts, taskRevision: 3
    })
    expect(resolved).toMatchObject({ ok: true, binding: { kind: 'collection', directory: root, selector: '*.csv' } })
    if (!resolved.ok) return
    expect(validatePersistedTargetBindings({ bindings: [resolved.binding], roots: [root], facts: partialFacts, taskRevision: 3 })).toEqual({ ok: true })
  })

  it('creates an output binding from the nearest existing authorized ancestor', () => {
    const result = resolveTaskTarget({ rawText: 'write summary.txt', target: { kind: 'output', path: `${root}/out/new/summary.txt`, expectedType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/out`, relativePath: 'out', kind: 'directory' }]), taskRevision: 9 })
    expect(result).toMatchObject({ ok: true, binding: { kind: 'output', ancestor: `${root}/out`, relativeSuffix: 'new/summary.txt' } })
  })

  it('binds relative output paths to a separate output root even when there are no authorized read roots', () => {
    const outputRoot = '/results'
    const result = resolveTaskTarget({
      rawText: 'write summary.txt',
      target: { kind: 'output', path: 'reports/summary.txt', expectedType: 'file' },
      roots: [], outputRoot, facts: facts('/unused', [], true), taskRevision: 9,
    })
    expect(result).toMatchObject({ ok: true, binding: {
      kind: 'output', path: path.join(outputRoot, 'reports/summary.txt'), ancestor: outputRoot,
      relativeSuffix: path.join('reports', 'summary.txt'), resolverVersion: 3,
    } })
    if (!result.ok) return
    const outputFacts = { roots: [], outputRoot, gitRepositories: [], entries: [], coverage: { complete: true, truncated: false, roots: 0, visited: 0, errors: 0 }, digest: 'output-only' }
    expect(validatePersistedTargetBindings({ bindings: [result.binding], roots: [], outputRoot, facts: outputFacts, taskRevision: 9 })).toEqual({ ok: true })
    expect(validatePersistedTargetBindings({ bindings: [result.binding], roots: [], outputRoot: '/elsewhere', facts: outputFacts, taskRevision: 9 })).toEqual({ ok: false, code: 'OUTPUT_ROOT_MISMATCH' })
  })

  it('revalidates an output-root binding without requiring unrelated read-root enumeration to be complete', () => {
    const outputRoot = '/results'
    const partialFacts = {
      roots: [root], outputRoot, gitRepositories: [],
      entries: [{ path: root, relativePath: '', kind: 'directory' as const }],
      coverage: { complete: false, truncated: true, roots: 1, visited: 1, errors: 0 }, digest: 'partial-read-tree'
    }
    const resolved = resolveTaskTarget({
      rawText: 'write summary',
      target: { kind: 'output', path: 'summary.md', expectedType: 'file' },
      roots: [root], outputRoot, facts: partialFacts, taskRevision: 9
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    expect(validatePersistedTargetBindings({
      bindings: [resolved.binding], roots: [root], outputRoot, facts: partialFacts, taskRevision: 9
    })).toEqual({ ok: true })
  })

  it('rejects output target traversal outside the selected output root', () => {
    const result = resolveTaskTarget({
      rawText: 'write outside',
      target: { kind: 'output', path: '../private.txt', expectedType: 'file' },
      roots: [], outputRoot: '/results', facts: facts('/unused', []), taskRevision: 1,
    })
    expect(result).toMatchObject({ ok: false, issue: { code: 'OUTPUT_PATH_ESCAPE' } })
  })

  it('binds a constrained collection selector and blocks unsupported selectors', () => {
    const input = { rawText: 'process all CSV files', target: { kind: 'collection' as const, directory: `${root}/data`, selector: '*.csv' as const }, roots: [root], facts: facts(root, [{ path: `${root}/data`, relativePath: 'data', kind: 'directory' }]), taskRevision: 5 }
    expect(resolveTaskTarget(input)).toMatchObject({ ok: true, binding: { kind: 'collection', selector: '*.csv', sort: 'canonical-path' } })
    expect(resolveTaskTarget({ ...input, target: { ...input.target, selector: '**/*.csv' as '*.csv' } })).toMatchObject({ ok: false, issue: { code: 'SELECTOR_UNSUPPORTED' } })
  })

  it('rejects targets outside selected roots and prevents output traversal', () => {
    const outside = resolveTaskTarget({ rawText: '/private/secret.txt', target: { kind: 'exact', path: '/private/secret.txt', targetType: 'file' }, roots: [root], facts: facts(root, []), taskRevision: 1 })
    expect(outside).toMatchObject({ ok: false, issue: { code: 'TARGET_OUTSIDE_ROOTS' } })
    const traversal = resolveTaskTarget({ rawText: 'escape', target: { kind: 'output', path: `${root}/../outside.txt`, expectedType: 'file' }, roots: [root], facts: facts(root, []), taskRevision: 1 })
    expect(traversal).toMatchObject({ ok: false, issue: { code: 'OUTPUT_PATH_ESCAPE' } })
  })

  it('does not treat a symlink as an authorized output ancestor', () => {
    const result = resolveTaskTarget({ rawText: 'write through link', target: { kind: 'output', path: `${root}/link/new.txt`, expectedType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/link`, relativePath: 'link', kind: 'symlink' }]), taskRevision: 1 })
    expect(result).toMatchObject({ ok: false, issue: { code: 'OUTPUT_ANCESTOR_INVALID' } })
  })

  it('revalidates exact ambiguity while allowing collection membership changes and a not-yet-created output', () => {
    const exact = resolveTaskTarget({ rawText: 'report.csv', target: { kind: 'exact', path: 'report.csv', targetType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/report.csv`, relativePath: 'report.csv', kind: 'file' }]), taskRevision: 4 })
    const collection = resolveTaskTarget({ rawText: 'all csv in data', target: { kind: 'collection', directory: `${root}/data`, selector: '*.csv' }, roots: [root], facts: facts(root, [{ path: `${root}/data`, relativePath: 'data', kind: 'directory' }]), taskRevision: 4 })
    const output = resolveTaskTarget({ rawText: 'write report', target: { kind: 'output', path: `${root}/out/new/report.txt`, expectedType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/out`, relativePath: 'out', kind: 'directory' }]), taskRevision: 4 })
    expect(exact.ok && collection.ok && output.ok).toBe(true)
    if (!exact.ok || !collection.ok || !output.ok) return
    expect(validatePersistedTargetBindings({ bindings: [exact.binding], roots: [root], facts: facts(root, [
      { path: `${root}/report.csv`, relativePath: 'report.csv', kind: 'file' },
      { path: `${root}/nested/report.csv`, relativePath: 'nested/report.csv', kind: 'file' }
    ]), taskRevision: 4 })).toEqual({ ok: false, code: 'TARGET_AMBIGUOUS_OR_CHANGED' })
    expect(validatePersistedTargetBindings({ bindings: [collection.binding], roots: [root], facts: facts(root, [
      { path: `${root}/data`, relativePath: 'data', kind: 'directory' },
      { path: `${root}/data/new.csv`, relativePath: 'data/new.csv', kind: 'file' }
    ]), taskRevision: 4 })).toEqual({ ok: true })
    expect(validatePersistedTargetBindings({ bindings: [{ ...collection.binding, resolverVersion: 1 }], roots: [root], facts: facts(root, [
      { path: `${root}/data`, relativePath: 'data', kind: 'directory' }
    ]), taskRevision: 4 })).toEqual({ ok: true })
    expect(validatePersistedTargetBindings({ bindings: [output.binding], roots: [root], facts: facts(root, [{ path: `${root}/out`, relativePath: 'out', kind: 'directory' }]), taskRevision: 4 })).toEqual({ ok: true })
    expect(validatePersistedTargetBindings({ bindings: [exact.binding], roots: [root], facts: facts(root, [{ path: `${root}/report.csv`, relativePath: 'report.csv', kind: 'file' }]), taskRevision: 5 })).toEqual({ ok: false, code: 'TASK_REVISION_MISMATCH' })
    expect(validatePersistedTargetBindings({ bindings: [{ ...exact.binding, resolverVersion: 1 }], roots: [root], facts: facts(root, [{ path: `${root}/report.csv`, relativePath: 'report.csv', kind: 'file' }]), taskRevision: 4 })).toEqual({ ok: false, code: 'RESOLVER_VERSION_UNSUPPORTED' })
  })

  it('keeps an explicit relative exact path bound to its logical path when another basename appears', () => {
    const result = resolveTaskTarget({ rawText: 'reports/report.csv', target: { kind: 'exact', path: `${root}/reports/report.csv`, targetType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/reports/report.csv`, relativePath: 'reports/report.csv', kind: 'file' }]), taskRevision: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(validatePersistedTargetBindings({ bindings: [{ ...result.binding, rawText: 'reports/report.csv' }], roots: [root], facts: facts(root, [
      { path: `${root}/reports/report.csv`, relativePath: 'reports/report.csv', kind: 'file' },
      { path: `${root}/archive/report.csv`, relativePath: 'archive/report.csv', kind: 'file' }
    ]), taskRevision: 4 })).toEqual({ ok: true })
  })
})
