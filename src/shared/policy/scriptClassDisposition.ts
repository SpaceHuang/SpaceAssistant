import type { ScriptFindingClass } from '../confirmation/types'

export type ScriptClassAction = 'allow' | 'ask' | 'deny'
export type ScriptFindingPathClass = 'absolute' | 'dotdot' | 'relative' | 'unresolved'
export interface ScriptClassDisposition {
  action: ScriptClassAction
}

export const SCRIPT_FINDING_CLASSES = [
  'process-creation', 'destructive-fs', 'dynamic-execution', 'dynamic-import',
  'native-code-load', 'network-api', 'file-write', 'cwd-change',
  'reflection', 'alias-resolution', 'decode-then-exec', 'dynamic-dispatch'
] as const satisfies readonly ScriptFindingClass[]

const SCRIPT_CLASS_DISPOSITION: Record<ScriptFindingClass, ScriptClassDisposition> = {
  'process-creation': { action: 'ask' },
  'destructive-fs': { action: 'ask' },
  'dynamic-execution': { action: 'ask' },
  'dynamic-import': { action: 'ask' },
  'native-code-load': { action: 'deny' },
  'network-api': { action: 'ask' },
  'file-write': { action: 'ask' },
  'cwd-change': { action: 'allow' },
  reflection: { action: 'ask' },
  'alias-resolution': { action: 'ask' },
  'decode-then-exec': { action: 'ask' },
  'dynamic-dispatch': { action: 'ask' }
}

/** Strategy-owned mapping from observations to actions; absent future classes fail closed. */
export function getScriptClassDisposition(
  findingClass: ScriptFindingClass,
  pathClass?: ScriptFindingPathClass
): ScriptClassDisposition {
  if (!Object.prototype.hasOwnProperty.call(SCRIPT_CLASS_DISPOSITION, findingClass)) return { action: 'ask' }
  if (findingClass === 'file-write' && pathClass === 'relative') return { action: 'allow' }
  if (findingClass === 'file-write' && (pathClass === 'absolute' || pathClass === 'dotdot')) return { action: 'deny' }
  return SCRIPT_CLASS_DISPOSITION[findingClass]
}
