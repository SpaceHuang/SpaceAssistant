import { describe, expect, it } from 'vitest'
import { resolveTaskTarget } from './taskTargetResolver'
import type { TaskPathFacts } from './taskPathFacts'

function facts(root: string, entries: TaskPathFacts['entries'], complete = true): TaskPathFacts {
  return { roots: [root], entries, coverage: { complete, truncated: !complete, roots: 1, visited: entries.length, errors: 0 }, digest: 'facts-digest' }
}

describe('resolveTaskTarget', () => {
  const root = '/workspace'

  it('resolves one unambiguous root basename to an exact binding', () => {
    const result = resolveTaskTarget({ rawText: 'read report.csv', target: { kind: 'exact', path: 'report.csv', targetType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/report.csv`, relativePath: 'report.csv', kind: 'file' }]), taskRevision: 3 })
    expect(result).toMatchObject({ ok: true, binding: { kind: 'exact', path: `${root}/report.csv`, resolverVersion: 1, taskRevision: 3 } })
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

  it('creates an output binding from the nearest existing authorized ancestor', () => {
    const result = resolveTaskTarget({ rawText: 'write summary.txt', target: { kind: 'output', path: `${root}/out/new/summary.txt`, expectedType: 'file' }, roots: [root], facts: facts(root, [{ path: `${root}/out`, relativePath: 'out', kind: 'directory' }]), taskRevision: 9 })
    expect(result).toMatchObject({ ok: true, binding: { kind: 'output', ancestor: `${root}/out`, relativeSuffix: 'new/summary.txt' } })
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
})
