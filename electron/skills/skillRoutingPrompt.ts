import type { SkillDefinition, SkillRouteRecentMessage, SkillsRoutingConfig } from '../../src/shared/domainTypes'

export const ROUTING_SYSTEM_PROMPT = `你是 SpaceAssistant 的 Skill 路由助手。你的唯一任务是：根据「用户当前请求」，从「可用 Skill 列表」中选出**确实需要加载**的 Skill。

判断依据：
- 仅根据每个 Skill 的 description 判断是否与当前任务相关。
- 宁可少选，不可误选：不确定时不选。
- 不要猜测用户未表达的需求。
- 输出必须是合法 JSON，不要 markdown 代码块，不要解释。

输出格式：
{"skills":["skill-name-1","skill-name-2"]}

若无合适 Skill，输出：{"skills":[]}`

export function buildSkillsCatalog(skills: SkillDefinition[], includeTriggers: boolean): string {
  return skills
    .map((s) => {
      let line = `- ${s.meta.name}：${s.meta.description}`
      if (includeTriggers && s.meta.triggers.length > 0) {
        const triggers = s.meta.triggers.filter((t) => t.length > 0 && t.toLowerCase() !== 'none').join('、')
        if (triggers) line += `（触发词：${triggers}）`
      }
      return line
    })
    .join('\n')
}

function trimContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(text.length - maxChars)
}

export function buildRecentContext(
  userInput: string,
  recentMessages: SkillRouteRecentMessage[],
  routing: SkillsRoutingConfig
): string {
  const strategy = routing.context ?? 'last_user_turn'
  if (strategy === 'none') return ''

  const maxChars = routing.contextMaxChars ?? 2000
  const completed = recentMessages.filter((m) => m.content.trim().length > 0)

  if (strategy === 'last_user_turn') {
    const priorUsers = completed.filter((m) => m.role === 'user' && m.content.trim() !== userInput.trim())
    const lastUser = priorUsers[priorUsers.length - 1]
    if (!lastUser) return ''
    const block = `上一条用户消息：${lastUser.content}\n当前用户消息：${userInput}`
    return trimContextText(block, maxChars)
  }

  const turns = Math.max(1, routing.contextTurns ?? 2)
  const lines: string[] = []
  let turnCount = 0
  for (let i = completed.length - 1; i >= 0 && turnCount < turns; i--) {
    const msg = completed[i]
    const label = msg.role === 'user' ? '用户' : '助手'
    lines.unshift(`${label}：${msg.content}`)
    if (msg.role === 'user') turnCount++
  }
  if (lines.length === 0) return ''
  return trimContextText(lines.join('\n'), maxChars)
}

export function buildRoutingUserMessage(args: {
  userInput: string
  catalog: string
  recentContext: string
}): string {
  const { userInput, catalog, recentContext } = args
  let body = `## 用户当前请求\n${userInput}\n\n## 可用 Skill 列表\n${catalog || '（无）'}`
  if (recentContext.trim()) {
    body += `\n\n## 会话上下文（可选）\n${recentContext}`
  }
  return body
}

export function parseRoutingResponse(raw: string): { skills: string[] } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let jsonText = trimmed
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch?.[1]) jsonText = fenceMatch[1].trim()

  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const skills = (parsed as { skills?: unknown }).skills
    if (!Array.isArray(skills)) return null
    const names = skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    return { skills: names }
  } catch {
    return null
  }
}
