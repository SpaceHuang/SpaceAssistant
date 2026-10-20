import { createHash } from 'node:crypto'
import path from 'node:path'
import type { TargetBinding } from '../../src/shared/automationTaskTypes'
import type { TaskPathFacts, TaskPathFactEntry } from './taskPathFacts'

export type ProposedTaskTarget =
  | { kind: 'exact'; path: string; targetType: 'file' | 'directory' }
  | { kind: 'collection'; directory: string; selector: '*.csv' | '*.tsv' | 'all' }
  | { kind: 'output'; path: string; expectedType: 'file' | 'directory' }

export type TaskTargetResolution = { ok: true; binding: TargetBinding } | { ok: false; issue: { code: string; field: string; reference?: string; candidates?: string[]; candidateCount?: number } }

type ResolveTaskTargetInput = { rawText: string; target: ProposedTaskTarget; roots: readonly string[]; outputRoot?: string; facts: TaskPathFacts; taskRevision: number }

const RESOLVER_VERSION = 3

function rootsDigest(roots: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...new Set(roots)].sort())).digest('hex')
}

function outputRootDigest(outputRoot: string): string {
  return createHash('sha256').update(JSON.stringify({ outputRoot: path.normalize(outputRoot) })).digest('hex')
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function issue(code: string, details: { reference?: string; candidates?: string[]; candidateCount?: number } = {}): TaskTargetResolution { return { ok: false, issue: { code, field: 'prompt', ...details } } }

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
  const { rawText, target, roots, outputRoot: requestedOutputRoot, facts, taskRevision } = input
  if (target.kind === 'output' && requestedOutputRoot) {
    const outputRoot = path.normalize(requestedOutputRoot)
    if (!path.isAbsolute(outputRoot) || (facts.outputRoot !== undefined && path.normalize(facts.outputRoot) !== outputRoot)) return issue('OUTPUT_ROOT_INVALID', { reference: target.path })
    const rawPath = target.path.trim()
    if (!rawPath || path.win32.isAbsolute(rawPath) && !path.isAbsolute(rawPath)) return issue('OUTPUT_PATH_ESCAPE', { reference: target.path })
    let relative = ''
    if (path.isAbsolute(rawPath)) {
      const absolute = path.normalize(rawPath)
      if (!isWithin(outputRoot, absolute)) return issue('OUTPUT_PATH_ESCAPE', { reference: target.path })
      relative = path.relative(outputRoot, absolute)
    } else {
      const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'))
      const pieces = normalized.split('/')
      if (path.posix.isAbsolute(normalized) || pieces.some((part) => part === '..')) return issue('OUTPUT_PATH_ESCAPE', { reference: target.path })
      relative = pieces.filter((part) => part && part !== '.').join(path.sep)
    }
    if (!relative || relative === '.') return issue('OUTPUT_PATH_INVALID', { reference: target.path })
    const outputPath = path.resolve(outputRoot, relative)
    if (!isWithin(outputRoot, outputPath) || outputPath === outputRoot) return issue('OUTPUT_PATH_ESCAPE', { reference: target.path })
    return { ok: true, binding: {
      kind: 'output', path: outputPath, ancestor: outputRoot, relativeSuffix: relative, outputRoot,
      expectedType: target.expectedType, rawText, resolverVersion: RESOLVER_VERSION,
      rootsDigest: outputRootDigest(outputRoot), taskRevision,
    } }
  }
  if (roots.length === 0) return issue('NO_ROOTS')
  const digest = rootsDigest(roots)
  if (target.kind === 'exact') {
    let resolvedPath = target.path
    if (!path.isAbsolute(resolvedPath)) {
      const isRelativePath = resolvedPath.includes('/') || resolvedPath.includes('\\')
      if (!isRelativePath && !facts.coverage.complete) return issue('FACTS_INCOMPLETE', { reference: target.path })
      if (isRelativePath && !facts.coverage.complete && roots.length !== 1) return issue('FACTS_INCOMPLETE', { reference: target.path })
      const normalizedRelative = path.posix.normalize(resolvedPath.replace(/\\/g, '/'))
      const matches = facts.entries.filter((entry) => (isRelativePath
        ? entry.relativePath === normalizedRelative
        : path.basename(entry.path) === resolvedPath) && entry.kind === target.targetType)
      if (matches.length === 0 && !facts.coverage.complete) return issue('FACTS_INCOMPLETE', { reference: target.path })
      if (matches.length === 0) return issue('TARGET_NOT_FOUND', { reference: target.path })
      if (matches.length > 1) return issue('TARGET_AMBIGUOUS', { reference: target.path, candidates: matches.slice(0, 20).map((entry) => entry.path), candidateCount: matches.length })
      resolvedPath = matches[0]!.path
    }
    if (!facts.coverage.complete && path.isAbsolute(resolvedPath) && !findFact(facts, resolvedPath)) return issue('FACTS_INCOMPLETE', { reference: target.path })
    const exactIssue = resolveExistingPath(resolvedPath, roots, facts, target.targetType)
    if (exactIssue) return issue(exactIssue, { reference: target.path })
    const referenceIsPath = path.isAbsolute(target.path) || target.path.includes('/') || target.path.includes('\\')
    const referenceValue = referenceIsPath && !path.isAbsolute(target.path)
      ? path.posix.normalize(target.path.replace(/\\/g, '/'))
      : target.path
    const targetReference = { kind: referenceIsPath ? 'path' as const : 'basename' as const, value: referenceValue }
    return { ok: true, binding: { kind: 'exact', path: path.normalize(resolvedPath), targetType: target.targetType, targetReference, rawText, resolverVersion: RESOLVER_VERSION, rootsDigest: digest, taskRevision } }
  }
  if (target.kind === 'collection') {
    if (!['*.csv', '*.tsv', 'all'].includes(target.selector)) return issue('SELECTOR_UNSUPPORTED', { reference: target.directory })
    const directory = path.normalize(target.directory)
    if (!findRoot(roots, directory)) return issue('TARGET_OUTSIDE_ROOTS', { reference: target.directory })
    const fact = findFact(facts, directory)
    if (!fact || fact.kind !== 'directory') return issue(fact?.kind === 'symlink' ? 'TARGET_UNVERIFIABLE' : 'TARGET_NOT_FOUND', { reference: target.directory })
    return { ok: true, binding: { kind: 'collection', directory, selector: target.selector, sort: 'canonical-path', rawText, resolverVersion: RESOLVER_VERSION, rootsDigest: digest, taskRevision } }
  }
  if (!facts.coverage.complete) return issue('FACTS_INCOMPLETE', { reference: target.path })
  const outputPath = path.resolve(target.path)
  const root = findRoot(roots, outputPath)
  if (!root) return issue('OUTPUT_PATH_ESCAPE', { reference: target.path })
  let ancestor = outputPath
  const suffix: string[] = []
  while (isWithin(root, ancestor) && !findFact(facts, ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    suffix.unshift(path.basename(ancestor))
    ancestor = parent
  }
  const ancestorFact = findFact(facts, ancestor)
  if (!ancestorFact || ancestorFact.kind !== 'directory') return issue('OUTPUT_ANCESTOR_INVALID', { reference: target.path })
  return { ok: true, binding: { kind: 'output', path: outputPath, ancestor, relativeSuffix: suffix.join(path.sep), expectedType: target.expectedType, rawText, resolverVersion: 2, rootsDigest: digest, taskRevision } }
}

export function validatePersistedTargetBindings(input: {
  bindings: readonly TargetBinding[]
  roots: readonly string[]
  outputRoot?: string
  facts: TaskPathFacts
  taskRevision: number
}): { ok: true } | { ok: false; code: string } {
  const { bindings, roots, outputRoot, facts, taskRevision } = input
  if (!roots.length && !outputRoot) return { ok: false, code: 'NO_ROOTS' }
  // final-check: recursive completeness is required only for bindings that rely on discovery;
  // no-target and output-root bindings can be verified from their directly approved identities.
  const digest = rootsDigest(roots)
  for (const binding of bindings) {
    if (binding.resolverVersion !== RESOLVER_VERSION && binding.resolverVersion !== 2 && !(binding.resolverVersion === 1 && binding.kind !== 'exact')) return { ok: false, code: 'RESOLVER_VERSION_UNSUPPORTED' }
    if (binding.taskRevision !== taskRevision) return { ok: false, code: 'TASK_REVISION_MISMATCH' }
    if (binding.kind === 'output' && binding.resolverVersion === RESOLVER_VERSION) {
      if (!outputRoot || !binding.outputRoot || path.normalize(outputRoot) !== path.normalize(binding.outputRoot)) return { ok: false, code: 'OUTPUT_ROOT_MISMATCH' }
      if (binding.rootsDigest !== outputRootDigest(outputRoot)) return { ok: false, code: 'OUTPUT_ROOT_DIGEST_MISMATCH' }
      const relative = binding.relativeSuffix
      if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..')) return { ok: false, code: 'OUTPUT_SUFFIX_INVALID' }
      const expectedPath = path.resolve(outputRoot, relative)
      if (!isWithin(outputRoot, expectedPath) || expectedPath === path.normalize(outputRoot) || expectedPath !== path.normalize(binding.path) || path.normalize(binding.ancestor) !== path.normalize(outputRoot)) return { ok: false, code: 'OUTPUT_SUFFIX_INVALID' }
      continue
    }
    if (binding.rootsDigest !== digest) return { ok: false, code: 'ROOTS_DIGEST_MISMATCH' }
    if (binding.kind === 'exact') {
      if (!binding.targetReference || typeof binding.targetReference.value !== 'string' || !['basename', 'path'].includes(binding.targetReference.kind)) return { ok: false, code: 'TARGET_REFERENCE_MISSING' }
      const referenceMatchesPath = binding.targetReference.kind === 'basename'
        ? path.basename(binding.path) === binding.targetReference.value
        : path.isAbsolute(binding.targetReference.value)
          ? path.normalize(binding.targetReference.value) === path.normalize(binding.path)
          : roots.some((root) => path.resolve(root, binding.targetReference.value) === path.normalize(binding.path))
      if (!referenceMatchesPath) return { ok: false, code: 'TARGET_REFERENCE_MISMATCH' }
      if (!findRoot(roots, binding.path)) return { ok: false, code: 'TARGET_OUTSIDE_ROOTS' }
      if (!facts.coverage.complete && binding.targetReference.kind === 'basename') return { ok: false, code: 'FACTS_INCOMPLETE' }
      const fact = findFact(facts, binding.path)
      if (!fact || fact.kind !== binding.targetType) return { ok: false, code: 'TARGET_UNVERIFIABLE' }
      // Recheck the exact reference extracted at preflight. Never infer reference mode from the full prompt.
      if (binding.targetReference.kind === 'basename') {
        const matches = facts.entries.filter((entry) => path.basename(entry.path) === binding.targetReference.value && entry.kind === binding.targetType)
        if (matches.length !== 1 || matches[0]!.path !== binding.path) return { ok: false, code: 'TARGET_AMBIGUOUS_OR_CHANGED' }
      }
      continue
    }
    if (binding.kind === 'collection') {
      if (!['*.csv', '*.tsv', 'all'].includes(binding.selector) || binding.sort !== 'canonical-path') return { ok: false, code: 'SELECTOR_UNSUPPORTED' }
      if (!findRoot(roots, binding.directory)) return { ok: false, code: 'TARGET_OUTSIDE_ROOTS' }
      if (findFact(facts, binding.directory)?.kind !== 'directory') return { ok: false, code: 'COLLECTION_DIRECTORY_INVALID' }
      continue
    }
    if (!facts.coverage.complete) return { ok: false, code: 'FACTS_INCOMPLETE' }
    const root = findRoot(roots, binding.ancestor)
    if (!root || !isWithin(root, binding.path) || !isWithin(root, binding.ancestor)) return { ok: false, code: 'OUTPUT_PATH_ESCAPE' }
    const ancestor = findFact(facts, binding.ancestor)
    if (!ancestor || ancestor.kind !== 'directory') return { ok: false, code: 'OUTPUT_ANCESTOR_INVALID' }
    if (path.isAbsolute(binding.relativeSuffix) || binding.relativeSuffix.split(path.sep).some((part) => part === '..')) return { ok: false, code: 'OUTPUT_SUFFIX_INVALID' }
    const expectedPath = path.resolve(binding.ancestor, binding.relativeSuffix)
    if (expectedPath !== path.normalize(binding.path)) return { ok: false, code: 'OUTPUT_SUFFIX_INVALID' }
  }
  return { ok: true }
}
