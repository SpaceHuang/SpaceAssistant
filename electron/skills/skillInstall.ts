import fs from 'fs'
import path from 'path'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { assertInsideDir, getProjectSkillsDir, getUserSkillsDir } from './skillPaths'
import { readSkillFromDirectory, validateSkillSourceDir } from './skillParser'

export type InstallConflict =
  | { type: 'user_exists'; existing: SkillDefinition; incoming: SkillDefinition }
  | { type: 'project_shadow'; projectSkill: SkillDefinition; incoming: SkillDefinition }

export function detectInstallConflict(
  userDataPath: string,
  workDir: string,
  incoming: SkillDefinition
): InstallConflict | null {
  const userDir = path.join(getUserSkillsDir(userDataPath), incoming.meta.name)
  if (fs.existsSync(userDir)) {
    try {
      const existing = readSkillFromDirectory(userDir, 'user')
      return { type: 'user_exists', existing, incoming }
    } catch {
      return { type: 'user_exists', existing: incoming, incoming }
    }
  }
  const projectDir = getProjectSkillsDir(workDir)
  if (projectDir) {
    const projPath = path.join(projectDir, incoming.meta.name)
    if (fs.existsSync(projPath)) {
      try {
        const projectSkill = readSkillFromDirectory(projPath, 'project')
        return { type: 'project_shadow', projectSkill, incoming }
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, ent.name)
    const destPath = path.join(dest, ent.name)
    if (ent.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(srcPath)
      const resolved = path.resolve(path.dirname(srcPath), linkTarget)
      const st = fs.statSync(resolved)
      if (st.isDirectory()) await copyDirRecursive(resolved, destPath)
      else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.copyFileSync(resolved, destPath)
      }
    } else if (ent.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else if (ent.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

export async function installSkillToUserDir(
  userDataPath: string,
  sourcePath: string,
  overwrite = false
): Promise<SkillDefinition> {
  const resolvedSource = path.resolve(sourcePath)
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    throw new Error('所选路径不是有效目录')
  }

  const validated = validateSkillSourceDir(resolvedSource)
  const userBase = getUserSkillsDir(userDataPath)
  fs.mkdirSync(userBase, { recursive: true })

  const targetDir = path.join(userBase, validated.meta.name)
  assertInsideDir(userBase, targetDir)

  if (fs.existsSync(targetDir) && !overwrite) {
    throw new Error(`用户级目录下已存在 Skill「${validated.meta.name}」`)
  }

  const tmpDir = path.join(userBase, `.tmp-${validated.meta.name}-${Date.now()}`)
  try {
    await copyDirRecursive(resolvedSource, tmpDir)
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true })
    }
    fs.renameSync(tmpDir, targetDir)
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err instanceof Error ? err : new Error(String(err))
  }

  return readSkillFromDirectory(targetDir, 'user')
}

export async function exportSkill(sourceDir: string, destDir: string): Promise<void> {
  const resolvedDest = path.resolve(destDir)
  fs.mkdirSync(resolvedDest, { recursive: true })
  await copyDirRecursive(path.resolve(sourceDir), resolvedDest)
}

export function deleteUserSkill(userDataPath: string, name: string): void {
  const userBase = getUserSkillsDir(userDataPath)
  const targetDir = path.join(userBase, name)
  assertInsideDir(userBase, targetDir)
  if (!fs.existsSync(targetDir)) throw new Error(`Skill「${name}」不存在`)
  fs.rmSync(targetDir, { recursive: true, force: true })
}
