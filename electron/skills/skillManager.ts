import type { SessionSkillsState, SkillDefinition, SkillsConfig, WikiConfig } from '../../src/shared/domainTypes'
import { buildSystemPromptFromSkills, truncateSystemPrompt } from '../../src/shared/skillPrompt'
import { getCachedSkills, invalidateSkillsCache } from './skillCache'
import { matchSkills } from './skillMatcher'
import { getSkillByName } from './skillScanner'
import {
  deleteUserSkill,
  detectInstallConflict,
  exportSkill,
  installSkillToUserDir,
  type InstallConflict
} from './skillInstall'
import { validateSkillSourceDir } from './skillParser'
import { ensureSkillsDirs } from './skillPaths'

export type SkillManagerContext = {
  getUserDataPath: () => string
  getWorkDir: () => string
  getSkillsConfig: () => SkillsConfig
  getWikiConfig?: () => WikiConfig
}

export function createSkillManager(ctx: SkillManagerContext) {
  return {
    list(refresh = false): SkillDefinition[] {
      if (refresh) invalidateSkillsCache()
      ensureSkillsDirs(ctx.getUserDataPath(), ctx.getWorkDir())
      return getCachedSkills(ctx.getUserDataPath(), ctx.getWorkDir())
    },

    get(name: string): SkillDefinition | null {
      return getSkillByName(ctx.getUserDataPath(), ctx.getWorkDir(), name)
    },

    match(userInput: string, sessionState: SessionSkillsState, sessionMetadata?: Record<string, unknown>): SkillDefinition[] {
      const skills = getCachedSkills(ctx.getUserDataPath(), ctx.getWorkDir())
      let config = ctx.getSkillsConfig()
      const wikiConfig = ctx.getWikiConfig?.()
      if (wikiConfig && !wikiConfig.enabled) {
        config = {
          ...config,
          alwaysLoad: config.alwaysLoad.filter((n) => n !== 'llm-wiki')
        }
      }
      const matched = matchSkills({ userInput, skills, config, sessionState, sessionMetadata })
      if (wikiConfig && !wikiConfig.enabled) {
        return matched.filter((s) => s.meta.name !== 'llm-wiki')
      }
      return matched
    },

    buildSystemPrompt(skills: SkillDefinition[], maxChars?: number): string {
      const raw = buildSystemPromptFromSkills(skills)
      if (maxChars && maxChars > 0) return truncateSystemPrompt(raw, maxChars)
      return raw
    },

    detectConflict(sourcePath: string): InstallConflict | null {
      const validated = validateSkillSourceDir(sourcePath)
      const incoming: SkillDefinition = {
        meta: validated.meta,
        content: validated.content,
        scope: 'user',
        directoryPath: sourcePath,
        filePath: `${sourcePath}/SKILL.md`,
        lastModified: Date.now()
      }
      return detectInstallConflict(ctx.getUserDataPath(), ctx.getWorkDir(), incoming)
    },

    async install(sourcePath: string, overwrite = false): Promise<SkillDefinition> {
      const skill = await installSkillToUserDir(ctx.getUserDataPath(), sourcePath, overwrite)
      invalidateSkillsCache()
      return skill
    },

    delete(name: string): void {
      const skill = getSkillByName(ctx.getUserDataPath(), ctx.getWorkDir(), name)
      if (!skill) throw new Error(`Skill「${name}」不存在`)
      if (skill.scope === 'project') throw new Error('无法删除项目级 Skill')
      deleteUserSkill(ctx.getUserDataPath(), name)
      invalidateSkillsCache()
    },

    async exportSkill(name: string, destPath: string): Promise<void> {
      const skill = getSkillByName(ctx.getUserDataPath(), ctx.getWorkDir(), name)
      if (!skill) throw new Error(`Skill「${name}」不存在`)
      await exportSkill(skill.directoryPath, destPath)
    },

    invalidateCache(): void {
      invalidateSkillsCache()
    }
  }
}

export type SkillManager = ReturnType<typeof createSkillManager>
