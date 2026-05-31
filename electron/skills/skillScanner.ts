import fs from 'fs'
import path from 'path'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { getBundledBrowserSetupGuideSkill } from './bundled/browserSetupGuideSkill'
import { getBundledShellSetupGuideSkill } from './bundled/shellSetupGuideSkill'
import { assertInsideDir, getProjectSkillsDir, getUserSkillsDir } from './skillPaths'
import { readSkillFromDirectory } from './skillParser'

function getBundledSkills(): SkillDefinition[] {
  return [getBundledBrowserSetupGuideSkill(), getBundledShellSetupGuideSkill()]
}

function scanScopeDir(baseDir: string, scope: 'project' | 'user'): SkillDefinition[] {
  if (!fs.existsSync(baseDir)) return []
  const results: SkillDefinition[] = []

  for (const ent of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const skillDir = path.join(baseDir, ent.name)
    const skillMd = path.join(skillDir, 'SKILL.md')
    if (!fs.existsSync(skillMd)) continue
    try {
      assertInsideDir(baseDir, skillDir)
      results.push(readSkillFromDirectory(skillDir, scope))
    } catch {
      /* skip invalid skills */
    }
  }

  return results
}

export function scanSkills(userDataPath: string, workDir: string): SkillDefinition[] {
  const userDir = getUserSkillsDir(userDataPath)
  const projectDir = getProjectSkillsDir(workDir)

  const userSkills = scanScopeDir(userDir, 'user')
  const projectSkills = projectDir ? scanScopeDir(projectDir, 'project') : []

  const byName = new Map<string, SkillDefinition>()
  for (const skill of userSkills) byName.set(skill.meta.name, skill)
  for (const skill of projectSkills) byName.set(skill.meta.name, skill)
  for (const skill of getBundledSkills()) byName.set(skill.meta.name, skill)

  return [...byName.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name))
}

export function getSkillByName(userDataPath: string, workDir: string, name: string): SkillDefinition | null {
  const skills = scanSkills(userDataPath, workDir)
  return skills.find((s) => s.meta.name === name) ?? null
}
