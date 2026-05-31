import type Anthropic from '@anthropic-ai/sdk'
import { createAnthropicClient } from '../anthropicClientFactory'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { normalizeToolLoopMaxTokens } from '../../src/shared/llm/toolLoopMaxTokens'
import type {
  SessionSkillsState,
  SkillActivationSource,
  SkillDefinition,
  SkillRouteRecentMessage,
  SkillRouteResult,
  SkillsConfig
} from '../../src/shared/domainTypes'
import { isLlmRoutingExcludedSkill } from '../../src/shared/domainTypes'
import {
  ROUTING_SYSTEM_PROMPT,
  buildRecentContext,
  buildRoutingUserMessage,
  buildSkillsCatalog,
  parseRoutingResponse
} from './skillRoutingPrompt'

const SOURCE_SCORE: Record<SkillActivationSource, number> = {
  manual: 1.0,
  alwaysLoad: 0.95,
  feishu: 0.95,
  llm: 0.9,
  legacy: 0.85
}

type ScoredSkill = {
  skill: SkillDefinition
  score: number
  source: SkillActivationSource
  llmOrder: number
}

const inFlightBySession = new Map<string, AbortController>()

export function getAvailableSkills(
  skills: SkillDefinition[],
  config: SkillsConfig,
  sessionState: SessionSkillsState
): SkillDefinition[] {
  const excluded = new Set([...config.disabled, ...sessionState.manualDisabled])
  return skills.filter((s) => !excluded.has(s.meta.name))
}

export function collectHardRuleSkills(args: {
  available: SkillDefinition[]
  config: SkillsConfig
  sessionState: SessionSkillsState
  sessionMetadata?: Record<string, unknown>
}): Map<string, ScoredSkill> {
  const { available, config, sessionState, sessionMetadata } = args
  const scored = new Map<string, ScoredSkill>()

  const upsert = (skill: SkillDefinition, source: SkillActivationSource) => {
    const scopeBonus = skill.scope === 'project' ? 0.01 : 0
    const next: ScoredSkill = {
      skill,
      score: SOURCE_SCORE[source] + scopeBonus,
      source,
      llmOrder: Number.MAX_SAFE_INTEGER
    }
    const cur = scored.get(skill.meta.name)
    if (!cur || next.score > cur.score) scored.set(skill.meta.name, next)
  }

  for (const name of config.alwaysLoad) {
    const skill = available.find((s) => s.meta.name === name)
    if (skill) upsert(skill, 'alwaysLoad')
  }

  for (const name of sessionState.manualActivated) {
    const skill = available.find((s) => s.meta.name === name)
    if (skill) upsert(skill, 'manual')
  }

  if (sessionMetadata?.source === 'feishu') {
    const feishuSkill = available.find(
      (s) => /lark|feishu|飞书/i.test(s.meta.name) || /lark|feishu|飞书/i.test(s.meta.description)
    )
    if (feishuSkill) upsert(feishuSkill, 'feishu')
  }

  return scored
}

export function mergeRouteSkills(
  scored: Map<string, ScoredSkill>,
  maxConcurrent: number
): { skills: SkillDefinition[]; sources: Record<string, SkillActivationSource> } {
  const sorted = [...scored.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.llmOrder !== b.llmOrder) return a.llmOrder - b.llmOrder
    if (a.skill.scope !== b.skill.scope) return a.skill.scope === 'project' ? -1 : 1
    return a.skill.meta.name.localeCompare(b.skill.meta.name)
  })

  const limited = sorted.slice(0, Math.max(0, maxConcurrent))
  const sources: Record<string, SkillActivationSource> = {}
  const skills = limited.map(({ skill, source }) => {
    sources[skill.meta.name] = source
    return skill
  })
  return { skills, sources }
}

export function applyLlmRecommendations(args: {
  scored: Map<string, ScoredSkill>
  llmRecommended: string[]
  available: SkillDefinition[]
  excluded: Set<string>
}): void {
  const { scored, llmRecommended, available, excluded } = args
  const availableNames = new Set(available.map((s) => s.meta.name))

  llmRecommended.forEach((name, index) => {
    if (!availableNames.has(name) || excluded.has(name) || isLlmRoutingExcludedSkill(name)) return
    const skill = available.find((s) => s.meta.name === name)
    if (!skill) return
    const scopeBonus = skill.scope === 'project' ? 0.01 : 0
    const next: ScoredSkill = {
      skill,
      score: SOURCE_SCORE.llm + scopeBonus,
      source: 'llm',
      llmOrder: index
    }
    const cur = scored.get(name)
    if (!cur || next.score > cur.score || (next.score === cur.score && next.llmOrder < cur.llmOrder)) {
      scored.set(name, next)
    } else if (cur && cur.source === 'llm' && cur.llmOrder === Number.MAX_SAFE_INTEGER) {
      scored.set(name, { ...cur, llmOrder: index })
    }
  })
}

async function callRoutingLlm(args: {
  client: Anthropic
  model: string
  userMessage: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<string> {
  const { client, model, userMessage, timeoutMs, signal } = args
  const res = (await client.messages.create(
    {
      model,
      max_tokens: normalizeToolLoopMaxTokens(256),
      temperature: 0,
      system: ROUTING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      stream: false
    },
    { signal }
  )) as { content?: unknown[] }

  const blocks = Array.isArray(res?.content) ? res.content : []
  const textBlock = blocks.find(
    (b: unknown) => b && typeof b === 'object' && (b as { type?: string }).type === 'text'
  ) as { type: 'text'; text: string } | undefined
  return typeof textBlock?.text === 'string' ? textBlock.text : ''
}

export async function routeSkills(args: {
  userInput: string
  skills: SkillDefinition[]
  config: SkillsConfig
  sessionState: SessionSkillsState
  sessionMetadata?: Record<string, unknown>
  recentMessages?: SkillRouteRecentMessage[]
  model: string
  baseUrl?: string
  getApiKey: () => Promise<string | null>
  sessionId?: string
}): Promise<SkillRouteResult> {
  const start = Date.now()
  const routingRequestId = crypto.randomUUID()
  const {
    userInput,
    skills,
    config,
    sessionState,
    sessionMetadata,
    recentMessages = [],
    model,
    baseUrl,
    getApiKey,
    sessionId
  } = args

  const routing = config.routing
  const available = getAvailableSkills(skills, config, sessionState)
  const scored = collectHardRuleSkills({ available, config, sessionState, sessionMetadata })

  const shouldCallLlm =
    config.autoDetect &&
    routing.mode === 'llm' &&
    routing.enabled !== false &&
    userInput.trim().length > 0 &&
    available.length > 0

  let llmRecommended: string[] | undefined
  let routingFailed = false
  let routingError: string | undefined

  if (shouldCallLlm) {
    const catalogSkills = available.filter((s) => !isLlmRoutingExcludedSkill(s.meta.name))
    const catalog = buildSkillsCatalog(catalogSkills, routing.includeTriggersInCatalog === true)
    const recentContext = buildRecentContext(userInput, recentMessages, routing)
    const userMessage = buildRoutingUserMessage({ userInput, catalog, recentContext })

    logAgentEvent('info', 'skills.route.start', {
      sessionId,
      routingRequestId,
      skillCount: catalogSkills.length,
      userInputLength: userInput.length
    })

    const apiKey = await getApiKey()
    if (!apiKey) {
      routingFailed = true
      routingError = 'missing_api_key'
      logAgentEvent('warn', 'skills.route.error', { sessionId, routingRequestId, error: routingError, fallback: true })
    } else {
      const sessionKey = sessionId ?? routingRequestId
      const prev = inFlightBySession.get(sessionKey)
      prev?.abort()

      const controller = new AbortController()
      inFlightBySession.set(sessionKey, controller)
      const timeoutMs = routing.timeoutMs ?? 15000
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const client = createAnthropicClient(apiKey, baseUrl)
        const routeModel = routing.model?.trim() || model
        const raw = await callRoutingLlm({
          client,
          model: routeModel,
          userMessage,
          timeoutMs,
          signal: controller.signal
        })
        const parsed = parseRoutingResponse(raw)
        if (!parsed) {
          routingFailed = true
          routingError = 'invalid_json'
          logAgentEvent('warn', 'skills.route.error', {
            sessionId,
            routingRequestId,
            error: routingError,
            fallback: true
          })
        } else {
          llmRecommended = parsed.skills
          const excluded = new Set([...config.disabled, ...sessionState.manualDisabled])
          applyLlmRecommendations({ scored, llmRecommended, available, excluded })
        }
      } catch (e) {
        routingFailed = true
        routingError = e instanceof Error ? e.name === 'AbortError' ? 'timeout' : e.message : String(e)
        logAgentEvent('warn', 'skills.route.error', {
          sessionId,
          routingRequestId,
          error: routingError,
          fallback: true
        })
      } finally {
        clearTimeout(timer)
        if (inFlightBySession.get(sessionKey) === controller) inFlightBySession.delete(sessionKey)
      }
    }
  }

  const { skills: finalSkills, sources } = mergeRouteSkills(scored, config.maxConcurrent)
  const durationMs = Date.now() - start

  logAgentEvent('info', 'skills.route.done', {
    sessionId,
    routingRequestId,
    recommended: llmRecommended ?? [],
    final: finalSkills.map((s) => s.meta.name),
    durationMs,
    failed: routingFailed
  })

  return {
    skills: finalSkills,
    meta: {
      sources,
      llmRecommended,
      routingFailed: routingFailed || undefined,
      routingError,
      durationMs,
      routingRequestId
    }
  }
}
