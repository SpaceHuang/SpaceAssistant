import path from 'node:path'
import { constants } from 'node:fs'
import { access, lstat, mkdir, realpath } from 'node:fs/promises'
import type { AutomationOutputOrganization, AutomationRunOutputScope, TargetBinding } from '../../src/shared/automationTaskTypes'

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Final-check path semantics follow the trusted root/host; POSIX backslashes stay literal path characters. */
function pathApi(referencePath: string): typeof path.posix {
  const isExplicitWindowsPath = /^[a-z]:[\\/]/i.test(referencePath) || /^\\\\[^\\]/.test(referencePath)
  return process.platform === 'win32' || isExplicitWindowsPath ? path.win32 : path.posix
}

function samePath(left: string, right: string): boolean {
  const api = pathApi(left)
  const a = api.normalize(left)
  const b = api.normalize(right)
  return api === path.win32 ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b
}

function isWithinPath(root: string, target: string): boolean {
  const api = pathApi(root)
  const relative = api.relative(api.resolve(root), api.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
}

/** Policy phase: resolves a deterministic archive directory from the frozen schedule slot. */
export function resolveAutomationRunOutputDir(
  outputDir: string,
  organization: AutomationOutputOrganization,
  scheduledFor: number,
): string {
  if (!path.isAbsolute(outputDir) || !Number.isFinite(scheduledFor)) throw new Error('INVALID_AUTOMATION_OUTPUT_DIRECTORY_INPUT')
  if (organization === 'direct') return path.normalize(outputDir)
  const date = new Date(scheduledFor)
  if (Number.isNaN(date.getTime())) throw new Error('INVALID_AUTOMATION_SCHEDULED_FOR')
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const dateFolder = `${year}${month}${day}`
  if (organization === 'daily') return path.join(outputDir, dateFolder)
  if (organization === 'hourly') return path.join(outputDir, `${dateFolder}-${String(date.getHours()).padStart(2, '0')}`)
  throw new Error('INVALID_AUTOMATION_OUTPUT_ORGANIZATION')
}

/** Facts/final-check: the frozen per-run path must be exactly the archive derived from the user-approved output settings. */
export function isValidAutomationRunOutputScope(scope: AutomationRunOutputScope): boolean {
  if (!scope.outputDirectory || !path.isAbsolute(scope.outputDirectory) || !scope.runOutputDir || !path.isAbsolute(scope.runOutputDir)
    || !Number.isFinite(scope.scheduledFor) || !Number.isInteger(scope.taskRevision) || scope.taskRevision < 0) return false
  try {
    return samePath(resolveAutomationRunOutputDir(scope.outputDirectory, scope.organization, scope.scheduledFor), scope.runOutputDir)
  } catch {
    return false
  }
}

/** Facts/final-check: result-write covers files below this run's archive, never reads or arbitrary authorized roots; dialect boundaries are covered in taskOutputDirectory.test.ts. */
export function matchesAutomationRunOutputWriteTarget(
  scope: AutomationRunOutputScope,
  target: { normalizedPath: string; parentReal: string; targetKind: string; zone?: string },
): boolean {
  if (!isValidAutomationRunOutputScope(scope)
    || (target.targetKind !== 'file' && target.targetKind !== 'missing')
    || target.zone === 'sensitive-file' || target.zone === 'system-dir') return false
  const api = pathApi(scope.runOutputDir)
  if (!api.isAbsolute(target.normalizedPath) || !api.isAbsolute(target.parentReal)) return false
  const root = api.resolve(scope.runOutputDir)
  const candidate = api.resolve(target.normalizedPath)
  const parent = api.resolve(target.parentReal)
  return !samePath(root, candidate) && isWithinPath(root, candidate) && isWithinPath(root, parent)
}

/** Runtime admission: create the scheduled archive without following links below the user-selected root. */
export async function ensureAutomationRunOutputDirectory(
  outputDir: string,
  organization: AutomationOutputOrganization,
  scheduledFor: number,
): Promise<string> {
  const selectedRoot = path.resolve(outputDir)
  let rootInfo
  let canonicalRoot: string
  try {
    rootInfo = await lstat(selectedRoot)
    canonicalRoot = await realpath(selectedRoot)
  } catch {
    throw new Error('OUTPUT_DIRECTORY_UNAVAILABLE')
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || path.normalize(canonicalRoot) !== path.normalize(selectedRoot)) {
    throw new Error('OUTPUT_DIRECTORY_ROOT_INVALID')
  }
  const runOutputDir = resolveAutomationRunOutputDir(canonicalRoot, organization, scheduledFor)
  if (!isWithin(canonicalRoot, runOutputDir)) throw new Error('OUTPUT_DIRECTORY_ESCAPE')
  const relative = path.relative(canonicalRoot, runOutputDir)
  let current = canonicalRoot
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('OUTPUT_DIRECTORY_UNAVAILABLE')
      try { await mkdir(current, { mode: 0o700 }) }
      catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('OUTPUT_DIRECTORY_UNAVAILABLE')
      }
      try { info = await lstat(current) } catch { throw new Error('OUTPUT_DIRECTORY_UNAVAILABLE') }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('OUTPUT_DIRECTORY_COMPONENT_INVALID')
    let canonicalComponent: string
    try { canonicalComponent = await realpath(current) } catch { throw new Error('OUTPUT_DIRECTORY_COMPONENT_INVALID') }
    if (path.normalize(canonicalComponent) !== path.normalize(current)) throw new Error('OUTPUT_DIRECTORY_COMPONENT_INVALID')
  }
  try { await access(runOutputDir, constants.W_OK | constants.X_OK) }
  catch { throw new Error('OUTPUT_DIRECTORY_UNAVAILABLE') }
  return runOutputDir
}

/** Final-check input: remaps a preflight-relative result into this run's archive slot. */
export function resolveBoundOutputTarget(
  binding: Extract<TargetBinding, { kind: 'output' }>,
  runOutputDir: string,
): string {
  const outputRoot = binding.outputRoot
  if (binding.resolverVersion !== 3 || !outputRoot || !path.isAbsolute(outputRoot) || !path.isAbsolute(runOutputDir)) {
    throw new Error('OUTPUT_BINDING_INVALID')
  }
  const canonicalOutputRoot = path.normalize(outputRoot)
  const canonicalRunOutputDir = path.normalize(runOutputDir)
  const suffix = binding.relativeSuffix.replace(/\\/g, path.sep)
  if (!suffix || path.isAbsolute(suffix) || path.win32.isAbsolute(binding.relativeSuffix)
    || suffix.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')) {
    throw new Error('OUTPUT_PATH_ESCAPE')
  }
  const boundBaseTarget = path.resolve(canonicalOutputRoot, suffix)
  if (path.normalize(binding.ancestor) !== canonicalOutputRoot
    || path.normalize(binding.path) !== boundBaseTarget
    || !isWithin(canonicalOutputRoot, boundBaseTarget)
    || canonicalRunOutputDir !== canonicalOutputRoot && !isWithin(canonicalOutputRoot, canonicalRunOutputDir)) {
    throw new Error('OUTPUT_PATH_ESCAPE')
  }
  const runTarget = path.resolve(canonicalRunOutputDir, suffix)
  if (runTarget === canonicalRunOutputDir || !isWithin(canonicalRunOutputDir, runTarget)) throw new Error('OUTPUT_PATH_ESCAPE')
  return runTarget
}

/** Facts/final-check helper: file bindings are exact; directory bindings cover only descendants. */
export function matchesBoundOutputWriteTarget(
  binding: Extract<TargetBinding, { kind: 'output' }>,
  runOutputDir: string,
  normalizedTarget: string,
): boolean {
  if (binding.expectedType !== 'file' && binding.expectedType !== 'directory') throw new Error('OUTPUT_BINDING_TYPE_INVALID')
  const boundTarget = resolveBoundOutputTarget(binding, runOutputDir)
  const windowsPath = process.platform === 'win32'
    || /^[a-z]:[\\/]/i.test(boundTarget) || /^[a-z]:[\\/]/i.test(normalizedTarget)
    || boundTarget.startsWith('\\\\') || normalizedTarget.startsWith('\\\\')
  const pathApi = windowsPath ? path.win32 : path
  const bound = pathApi.normalize(boundTarget)
  const target = pathApi.normalize(normalizedTarget)
  const equivalent = windowsPath
    ? bound.toLocaleLowerCase('en-US') === target.toLocaleLowerCase('en-US')
    : bound === target
  if (binding.expectedType === 'file') return equivalent
  if (equivalent) return false
  const relative = pathApi.relative(bound, target)
  const escapes = relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)
  return !escapes
}
