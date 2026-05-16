import type { SessionSkillsState, SkillDefinition, SkillsConfig } from '../../src/shared/domainTypes'
import { logAgentEvent } from '../agentLogger/agentLogger'

export const DESCRIPTION_MATCH_THRESHOLD = 0.4

type ScoredSkill = SkillDefinition & { score: number; matchSource: 'alwaysLoad' | 'manual' | 'keyword' | 'description' }

function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const split = lower
    .split(/[\s,，。！？；：、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  const cjk = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  return [...new Set([...split, ...cjk])]
}

function descriptionSimilarity(userInput: string, description: string): number {
  const inputLower = userInput.toLowerCase()
  const inputTokens = tokenize(userInput)
  const descTokens = tokenize(description)
  if (inputTokens.length === 0 || descTokens.length === 0) return 0

  let overlap = 0
  for (const dt of descTokens) {
    const dl = dt.toLowerCase()
    if (inputLower.includes(dl)) {
      overlap++
      continue
    }
    for (const it of inputTokens) {
      const il = it.toLowerCase()
      if (il.length >= 2 && (dl.includes(il) || il.includes(dl))) {
        overlap++
        break
      }
    }
  }

  const union = new Set([...inputTokens, ...descTokens]).size
  return union === 0 ? 0 : overlap / union
}

function keywordMatch(userInput: string, triggers: string[]): boolean {
  const lower = userInput.toLowerCase()
  return triggers.some((t) => t.length > 0 && lower.includes(t.toLowerCase()))
}

export function matchSkills(args: {
  userInput: string
  skills: SkillDefinition[]
  config: SkillsConfig
  sessionState: SessionSkillsState
}): SkillDefinition[] {
  const { userInput, skills, config, sessionState } = args
  const excluded = new Set([...config.disabled, ...sessionState.manualDisabled])
  const available = skills.filter((s) => !excluded.has(s.meta.name))

  const scored = new Map<string, ScoredSkill>()

  const upsert = (skill: SkillDefinition, score: number, matchSource: ScoredSkill['matchSource']) => {
    const cur = scored.get(skill.meta.name)
    const scopeBonus = skill.scope === 'project' ? 0.01 : 0
    const nextScore = score + scopeBonus
    if (!cur || nextScore > cur.score) {
      scored.set(skill.meta.name, { ...skill, score: nextScore, matchSource })
    }
  }

  for (const name of config.alwaysLoad) {
    const skill = available.find((s) => s.meta.name === name)
    if (skill) upsert(skill, 1.0, 'alwaysLoad')
  }

  for (const name of sessionState.manualActivated) {
    const skill = available.find((s) => s.meta.name === name)
    if (skill) upsert(skill, 0.95, 'manual')
  }

  if (config.autoDetect && userInput.trim()) {
    for (const skill of available) {
      if (keywordMatch(userInput, skill.meta.triggers)) {
        upsert(skill, 0.8, 'keyword')
      } else {
        const sim = descriptionSimilarity(userInput, skill.meta.description)
        if (sim >= DESCRIPTION_MATCH_THRESHOLD) {
          upsert(skill, sim, 'description')
        }
      }
    }
  }

  const sorted = [...scored.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
    return a.meta.name.localeCompare(b.meta.name)
  })

  const matched = sorted.slice(0, Math.max(1, config.maxConcurrent))
  logAgentEvent('info', 'skills.match', {
    userInput,
    matched: matched.map((s) => ({
      name: s.meta.name,
      score: s.score,
      matchSource: s.matchSource,
      scope: s.scope
    })),
    excludedCount: skills.length - available.length
  })

  return matched.map(({ meta, content, scope, directoryPath, filePath, lastModified }) => ({
    meta,
    content,
    scope,
    directoryPath,
    filePath,
    lastModified
  }))
}
