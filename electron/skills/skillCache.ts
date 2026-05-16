import fs from 'fs'
import path from 'path'
import type { SkillDefinition, SkillsCache } from '../../src/shared/domainTypes'
import { getProjectSkillsDir, getUserSkillsDir } from './skillPaths'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { scanSkills } from './skillScanner'

let cache: SkillsCache | null = null

function dirSignature(dir: string | null): string {
  if (!dir || !fs.existsSync(dir)) return ''
  let maxMtime = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name)
      const st = fs.statSync(full)
      maxMtime = Math.max(maxMtime, st.mtimeMs)
      if (ent.isDirectory()) stack.push(full)
    }
  }
  return `${dir}:${maxMtime}`
}

function isCacheValid(userDataPath: string, workDir: string): boolean {
  if (!cache) return false
  if (cache.workDir !== workDir) return false
  const userSig = dirSignature(getUserSkillsDir(userDataPath))
  const projectSig = dirSignature(getProjectSkillsDir(workDir))
  const expected = `${userSig}|${projectSig}|${workDir}`
  return (cache as SkillsCache & { signature?: string }).signature === expected
}

export function getCachedSkills(userDataPath: string, workDir: string): SkillDefinition[] {
  if (isCacheValid(userDataPath, workDir)) return cache!.skills
  const skills = scanSkills(userDataPath, workDir)
  const userSig = dirSignature(getUserSkillsDir(userDataPath))
  const projectSig = dirSignature(getProjectSkillsDir(workDir))
  const scannedAt = Date.now()
  cache = {
    skills,
    scannedAt,
    workDir,
    signature: `${userSig}|${projectSig}|${workDir}`
  } as SkillsCache & { signature: string }
  logAgentEvent('info', 'skills.load', {
    workDir,
    skillCount: skills.length,
    skillNames: skills.map((s) => s.meta.name),
    scannedAt,
    cacheHit: false
  })
  return skills
}

export function invalidateSkillsCache(): void {
  cache = null
}
