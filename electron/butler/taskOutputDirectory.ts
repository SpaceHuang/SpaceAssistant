import path from 'node:path'
import type { AutomationOutputOrganization, TargetBinding } from '../../src/shared/automationTaskTypes'

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
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
