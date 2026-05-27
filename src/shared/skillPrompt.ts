import type { SkillDefinition, SkillActivationSource } from './domainTypes'

export function buildSystemPromptFromSkills(skills: SkillDefinition[]): string {
  if (skills.length === 0) return ''

  const parts = skills.map((skill) => {
    const version = skill.meta.version || '1.0.0'
    return `--- Skill: ${skill.meta.name} (v${version}) ---\n${skill.content.trim()}`
  })

  return `以下是由用户激活的 Skill 规范，请在生成回复时严格遵循：\n\n${parts.join('\n\n')}\n\n---`
}

export function formatSkillHint(skills: SkillDefinition[], prefix: string): string {
  if (skills.length === 0) return ''
  const names = skills.map((s) => `${s.meta.name}（${s.scope === 'project' ? '项目级' : '用户级'}）`).join('、')
  return `[Skill] ${prefix}: ${names}`
}

const SOURCE_HINT_LABEL: Record<SkillActivationSource, string> = {
  llm: 'AI 匹配',
  manual: '手动激活',
  alwaysLoad: '始终加载',
  feishu: '飞书',
  legacy: '本地匹配'
}

export function formatSkillRouteHint(
  skills: SkillDefinition[],
  sources: Record<string, SkillActivationSource>
): string {
  if (skills.length === 0) return ''
  const parts = skills.map((s) => {
    const scope = s.scope === 'project' ? '项目级' : '用户级'
    const src = sources[s.meta.name]
    const srcLabel = src ? SOURCE_HINT_LABEL[src] : ''
    return srcLabel ? `${s.meta.name}（${scope}，${srcLabel}）` : `${s.meta.name}（${scope}）`
  })
  return `[Skill] 已加载: ${parts.join('、')}`
}

export function truncateSystemPrompt(system: string, maxChars: number): string {
  if (maxChars <= 0 || system.length <= maxChars) return system
  const suffix = '\n\n---\n[Skill 内容已截断以适配上下文窗口]'
  const budget = Math.max(0, maxChars - suffix.length)
  return system.slice(0, budget) + suffix
}
