import { createHash } from 'node:crypto'
import path from 'node:path'
import type { TargetBinding } from '../../src/shared/automationTaskTypes'
import type { TaskPathFacts, TaskPathFactEntry } from './taskPathFacts'

export type ProposedTaskTarget =
  | { kind: 'exact'; path: string; targetType: 'file' | 'directory' }
  | { kind: 'collection'; directory: string; selector: '*.csv' | '*.tsv' | 'all' }
  | { kind: 'output'; path: string; expectedType: 'file' | 'directory' }

export type TaskTargetResolution = { ok: true; binding: TargetBinding } | { ok: false; issue: { code: string; field: string } }

type ResolveTaskTargetInput = { rawText: string; target: ProposedTaskTarget; roots: readonly string[]; facts: TaskPathFacts; taskRevision: number }

const RESOLVER_VERSION = 1

function rootsDigest(roots: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...new Set(roots)].sort())).digest('hex')
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function issue(code: string): TaskTargetResolution { return { ok: false, issue: { code, field: 'prompt' } } }

function findRoot(roots: readonly string[], target: string): string | undefined {
  return [...roots].sort((a, b) => b.length - a.length).find((root) => isWithin(root, target))
}

function findFact(facts: TaskPathFacts, target: string): TaskPathFactEntry | undefined {
  return facts.entries.find((entry) => entry.path === target)
}

function resolveExistingPath(targetPath: string, roots: readonly string[], facts: TaskPathFacts, expected: 'file' | 'directory'): string | undefined {
  const absolute = path.normalize(path.isAbsolute(targetPath) ? targetPath : targetPath)
  const root = findRoot(roots, absolute)
  if (!root) return 'TARGET_OUTSIDE_ROOTS'
  const fact = findFact(facts, absolute)
  if (!fact || fact.kind === 'symlink' || fact.kind === 'special') return 'TARGET_UNVERIFIABLE'
  if (fact.kind !== expected) return 'TARGET_TYPE_MISMATCH'
  return undefined
}

export function resolveTaskTarget(input: ResolveTaskTargetInput): TaskTargetResolution {
  const { rawText, target, roots, facts, taskRevision } = input
  if (roots.length === 0) return issue('NO_ROOTS')
  if (!facts.coverage.complete) return issue('FACTS_INCOMPLETE')
  const digest = rootsDigest(roots)
  if (target.kind === 'exact') {
    let resolvedPath = target.path
    if (!path.isAbsolute(resolvedPath)) {
      const matches = facts.entries.filter((entry) => path.basename(entry.path) === resolvedPath && entry.kind === target.targetType)
      if (matches.length === 0) return issue('TARGET_NOT_FOUND')
      if (matches.length > 1) return issue('TARGET_AMBIGUOUS')
      resolvedPath = matches[0]!.path
    }
    const exactIssue = resolveExistingPath(resolvedPath, roots, facts, target.targetType)
    if (exactIssue) return issue(exactIssue)
    return { ok: true, binding: { kind: 'exact', path: path.normalize(resolvedPath), targetType: target.targetType, rawText, resolverVersion: RESOLVER_VERSION, rootsDigest: digest, taskRevision } }
  }
  if (target.kind === 'collection') {
    if (!['*.csv', '*.tsv', 'all'].includes(target.selector)) return issue('SELECTOR_UNSUPPORTED')
    const directory = path.normalize(target.directory)
    if (!findRoot(roots, directory)) return issue('TARGET_OUTSIDE_ROOTS')
    const fact = findFact(facts, directory)
    if (!fact || fact.kind !== 'directory') return issue(fact?.kind === 'symlink' ? 'TARGET_UNVERIFIABLE' : 'TARGET_NOT_FOUND')
    return { ok: true, binding: { kind: 'collection', directory, selector: target.selector, sort: 'canonical-path', rawText, resolverVersion: RESOLVER_VERSION, rootsDigest: digest, taskRevision } }
  }
  const outputPath = path.resolve(target.path)
  const root = findRoot(roots, outputPath)
  if (!root) return issue('OUTPUT_PATH_ESCAPE')
  let ancestor = outputPath
  const suffix: string[] = []
  while (isWithin(root, ancestor) && !findFact(facts, ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    suffix.unshift(path.basename(ancestor))
    ancestor = parent
  }
  const ancestorFact = findFact(facts, ancestor)
  if (!ancestorFact || ancestorFact.kind !== 'directory') return issue('OUTPUT_ANCESTOR_INVALID')
  return { ok: true, binding: { kind: 'output', path: outputPath, ancestor, relativeSuffix: suffix.join(path.sep), expectedType: target.expectedType, rawText, resolverVersion: RESOLVER_VERSION, rootsDigest: digest, taskRevision } }
}
