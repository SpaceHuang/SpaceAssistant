import path from 'path'

export const PLANS_DIR_REL = '.spaceassistant/plans'

export function plansDirAbs(workDir: string): string {
  return path.join(workDir, PLANS_DIR_REL)
}

export function planFileAbs(workDir: string, relPlanPath: string): string {
  const normalized = relPlanPath.replace(/\\/g, '/')
  if (normalized.startsWith(PLANS_DIR_REL + '/')) {
    return path.join(workDir, normalized)
  }
  return path.join(workDir, PLANS_DIR_REL, path.basename(normalized))
}

export function relPlanPathFromAbs(workDir: string, absPath: string): string {
  const rel = path.relative(workDir, absPath).replace(/\\/g, '/')
  if (rel.startsWith(PLANS_DIR_REL)) return rel
  return `${PLANS_DIR_REL}/${path.basename(absPath)}`
}
