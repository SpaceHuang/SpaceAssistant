import fs from 'node:fs'
import path from 'node:path'

/** Lists existing Butler task roots after rejecting symlinked or escaped directories. */
export function listManagedButlerSessionLedgerRoots(userDataDir: string): readonly string[] {
  const automationRoot = path.resolve(userDataDir, 'automation-sessions')
  const automationStat = fs.lstatSync(automationRoot, { throwIfNoEntry: false })
  if (!automationStat?.isDirectory() || automationStat.isSymbolicLink()) return []
  const realAutomationRoot = fs.realpathSync(automationRoot)
  const roots: string[] = []
  for (const entry of fs.readdirSync(realAutomationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = path.join(realAutomationRoot, entry.name)
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false })
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue
    const realCandidate = fs.realpathSync(candidate)
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
