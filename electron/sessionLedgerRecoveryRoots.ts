import fs from 'node:fs'
import path from 'node:path'

/** Lists existing Butler task roots after rejecting symlinked or escaped directories. */
export function listManagedButlerSessionLedgerRoots(
  userDataDir: string,
  onScanError?: (input: { path: string; operation: 'lstat' | 'realpath' | 'readdir'; error: unknown }) => void
): readonly string[] {
  const automationRoot = path.resolve(userDataDir, 'automation-sessions')
  let automationStat: fs.Stats | undefined
  try { automationStat = fs.lstatSync(automationRoot, { throwIfNoEntry: false }) }
  catch (error) { onScanError?.({ path: automationRoot, operation: 'lstat', error }); return [] }
  if (!automationStat?.isDirectory() || automationStat.isSymbolicLink()) return []
  let realAutomationRoot: string
  try { realAutomationRoot = fs.realpathSync(automationRoot) }
  catch (error) { onScanError?.({ path: automationRoot, operation: 'realpath', error }); return [] }
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(realAutomationRoot, { withFileTypes: true }) }
  catch (error) { onScanError?.({ path: realAutomationRoot, operation: 'readdir', error }); return [] }
  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = path.join(realAutomationRoot, entry.name)
    let stat: fs.Stats | undefined
    try { stat = fs.lstatSync(candidate, { throwIfNoEntry: false }) }
    catch (error) { onScanError?.({ path: candidate, operation: 'lstat', error }); continue }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue
    let realCandidate: string
    try { realCandidate = fs.realpathSync(candidate) }
    catch (error) { onScanError?.({ path: candidate, operation: 'realpath', error }); continue }
    if (path.dirname(realCandidate) === realAutomationRoot) roots.push(realCandidate)
  }
  return Object.freeze(roots)
}

/** Validates a runtime Butler root as one real direct child of the private automation root. */
export function isManagedButlerSessionLedgerRoot(userDataDir: string, workDir: string): boolean {
  const automationRoot = path.resolve(userDataDir, 'automation-sessions')
  const target = path.resolve(workDir)
  if (!path.basename(target)) return false
  try {
    const automationStat = fs.lstatSync(automationRoot)
    const targetStat = fs.lstatSync(target)
    if (automationStat.isSymbolicLink() || !automationStat.isDirectory() || targetStat.isSymbolicLink() || !targetStat.isDirectory()) return false
    const realAutomationRoot = fs.realpathSync(automationRoot)
    const realTarget = fs.realpathSync(target)
    return path.dirname(target) === realAutomationRoot && path.dirname(realTarget) === realAutomationRoot && realTarget === target
  } catch {
    return false
  }
}

/** Allows a Butler root only when its private task root is linked to the same session. */
export function isSessionLedgerRecoveryRootAllowed(input: {
  userDataDir: string
  workDir: string
  sessionId: string
  configuredRoots: readonly string[]
  hasButlerTaskSessionLink(taskId: string, sessionId: string): boolean
}): boolean {
  if (input.configuredRoots.some((root) => path.resolve(root) === path.resolve(input.workDir))) return true
  if (!isManagedButlerSessionLedgerRoot(input.userDataDir, input.workDir)) return false
  return input.hasButlerTaskSessionLink(path.basename(path.resolve(input.workDir)), input.sessionId)
}
