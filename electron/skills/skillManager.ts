import type {
  SessionSkillsState,
  SkillDefinition,
  SkillRouteRecentMessage,
  SkillRouteResult,
  SkillsConfig,
  WikiConfig
} from '../../src/shared/domainTypes'
import { buildSystemPromptFromSkills, truncateSystemPrompt } from '../../src/shared/skillPrompt'
import { getCachedSkills, invalidateSkillsCache } from './skillCache'
import { matchSkills } from './skillMatcher'
import { routeSkills } from './skillRouter'
import { getSkillByName } from './skillScanner'
import {
  deleteUserSkill,
  detectInstallConflict,
  exportSkill,
  installSkillToUserDir,
  type InstallConflict
} from './skillInstall'
import { installSkillsFromGithub } from './skillGithubInstall'
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

    async route(args: {
      userInput: string
      sessionState: SessionSkillsState
      sessionMetadata?: Record<string, unknown>
      recentMessages?: SkillRouteRecentMessage[]
      model: string
      baseUrl?: string
      getApiKey: () => Promise<string | null>
      sessionId?: string
    }): Promise<SkillRouteResult> {
      const skills = getCachedSkills(ctx.getUserDataPath(), ctx.getWorkDir())
      let config = ctx.getSkillsConfig()
      const wikiConfig = ctx.getWikiConfig?.()

      if (wikiConfig && !wikiConfig.enabled) {
        config = {
          ...config,
          alwaysLoad: config.alwaysLoad.filter((n) => n !== 'llm-wiki')
        }
      }

      if (config.routing.mode === 'legacy') {
        const matched = matchSkills({
          userInput: args.userInput,
          skills,
          config,
          sessionState: args.sessionState,
          sessionMetadata: args.sessionMetadata
        })
        let filtered = matched
        if (wikiConfig && !wikiConfig.enabled) {
          filtered = matched.filter((s) => s.meta.name !== 'llm-wiki')
        }
        return {
          skills: filtered,
          meta: {
            sources: Object.fromEntries(filtered.map((s) => [s.meta.name, 'legacy' as const])),
            durationMs: 0
          }
        }
      }

      const result = await routeSkills({
        userInput: args.userInput,
        skills,
        config,
        sessionState: args.sessionState,
        sessionMetadata: args.sessionMetadata,
        recentMessages: args.recentMessages,
        model: args.model,
        baseUrl: args.baseUrl,
        getApiKey: args.getApiKey,
        sessionId: args.sessionId
      })

      if (wikiConfig && !wikiConfig.enabled) {
        const filtered = result.skills.filter((s) => s.meta.name !== 'llm-wiki')
        const sources = Object.fromEntries(
          filtered.map((s) => [s.meta.name, result.meta.sources[s.meta.name]]).filter(([, src]) => src)
        )
        return { ...result, skills: filtered, meta: { ...result.meta, sources } }
      }

      return result
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

    async installFromUrl(
      sourceUrl: string,
      options: { subPath?: string; installAll?: boolean; overwrite?: boolean } = {}
    ): Promise<SkillDefinition[]> {
      const skills = await installSkillsFromGithub(ctx.getUserDataPath(), sourceUrl, options)
      invalidateSkillsCache()
      return skills
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
