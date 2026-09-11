import fs from 'fs'
import path from 'path'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { getBundledBrowserSetupGuideSkill } from './bundled/browserSetupGuideSkill'
import { getBundledShellSetupGuideSkill } from './bundled/shellSetupGuideSkill'
import { assertInsideDir, getProjectSkillsDir, getUserSkillsDir } from './skillPaths'
import { readSkillFromDirectory } from './skillParser'
import { logAgentEvent } from '../agentLogger/agentLogger'

function getBundledSkills(): SkillDefinition[] {
  return [getBundledBrowserSetupGuideSkill(), getBundledShellSetupGuideSkill()]
}

export type SkippedSkill = { dirName: string; scope: 'project' | 'user'; reason: string }

function scanScopeDir(baseDir: string, scope: 'project' | 'user', skipped: SkippedSkill[]): SkillDefinition[] {
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
    } catch (error) {
      skipped.push({ dirName: ent.name, scope, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return results
}

export function scanSkills(userDataPath: string, workDir: string): SkillDefinition[] {
  return scanSkillsWithSkipped(userDataPath, workDir).skills
}

export function scanSkillsWithSkipped(userDataPath: string, workDir: string): { skills: SkillDefinition[]; skipped: SkippedSkill[] } {
  const userDir = getUserSkillsDir(userDataPath)
  const projectDir = getProjectSkillsDir(workDir)

  const skipped: SkippedSkill[] = []
  const userSkills = scanScopeDir(userDir, 'user', skipped)
  const projectSkills = projectDir ? scanScopeDir(projectDir, 'project', skipped) : []
  for (const item of skipped) logAgentEvent('warn', 'skills.scan.skipped', item)

  const byName = new Map<string, SkillDefinition>()
  for (const skill of userSkills) byName.set(skill.meta.name, skill)
  for (const skill of projectSkills) byName.set(skill.meta.name, skill)
  for (const skill of getBundledSkills()) byName.set(skill.meta.name, skill)

  return { skills: [...byName.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name)), skipped }
}

export function getSkillByName(userDataPath: string, workDir: string, name: string): SkillDefinition | null {
  const skills = scanSkills(userDataPath, workDir)
  return skills.find((s) => s.meta.name === name) ?? null
}
