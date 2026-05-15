import fs from 'fs'
import path from 'path'

export const PROJECT_SKILLS_DIRNAME = '.space-skills'
export const USER_SKILLS_DIRNAME = 'skills'

export function getUserSkillsDir(userDataPath: string): string {
  return path.join(userDataPath, USER_SKILLS_DIRNAME)
}

export function getProjectSkillsDir(workDir: string): string | null {
  const trimmed = workDir.trim()
  if (!trimmed) return null
  return path.join(path.resolve(trimmed), PROJECT_SKILLS_DIRNAME)
}

export function ensureSkillsDirs(userDataPath: string, workDir: string): { userDir: string; projectDir: string | null } {
  const userDir = getUserSkillsDir(userDataPath)
  fs.mkdirSync(userDir, { recursive: true })
  const projectDir = getProjectSkillsDir(workDir)
  if (projectDir) fs.mkdirSync(projectDir, { recursive: true })
  return { userDir, projectDir }
}

export function assertInsideDir(baseDir: string, targetPath: string): void {
  const base = path.resolve(baseDir)
  const resolved = path.resolve(targetPath)
  const rel = path.relative(base, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径超出 Skill 目录范围')
  }
}
