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
  const names = skills
    .map((s) => {
      const scope =
        s.scope === 'project' ? '项目级' : s.scope === 'builtin' ? '内置' : '用户级'
      return `${s.meta.name}（${scope}）`
    })
    .join('、')
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
    const scope =
      s.scope === 'project' ? '项目级' : s.scope === 'builtin' ? '内置' : '用户级'
    const src = sources[s.meta.name]
    const srcLabel = src ? SOURCE_HINT_LABEL[src] : ''
    return srcLabel ? `${s.meta.name}（${scope}，${srcLabel}）` : `${s.meta.name}（${scope}）`
  })
  return `[Skill] 已加载: ${parts.join('、')}`
}

/** 用于判断本轮 Skill 路由结果是否与上一轮相同，避免重复 Hint */
export function buildSkillRouteSignature(
  skills: SkillDefinition[],
  sources: Record<string, SkillActivationSource>
): string {
  return [...skills]
    .map((s) => `${s.meta.name}@${sources[s.meta.name] ?? 'unknown'}`)
    .sort()
    .join('|')
}

/** 注入当前会话实际可用的内置工具列表，避免 Skill 引用未启用的工具（如 run_shell） */
export function buildAvailableToolsHint(toolNames: string[]): string {
  if (toolNames.length === 0) return ''
  const list = toolNames.join(', ')
  const shellNote = toolNames.includes('run_shell')
    ? 'run_shell 可在工作目录执行 shell 命令（执行前会弹出确认卡片）。'
    : 'run_shell 当前未启用：不得调用 run_shell；需要执行 shell 时请按 Skill 的 fallback（口述步骤或引导用户在终端执行）。'
  return [
    '## 当前可用工具',
    `仅可调用以下工具名称：${list}`,
    '',
    '注意：run_shell（shell 命令）与 run_script（Python 脚本）是完全不同的工具，不可互相替代。',
    shellNote
  ].join('\n')
}

export function appendAvailableToolsHint(system: string | undefined, toolNames: string[]): string | undefined {
  const hint = buildAvailableToolsHint(toolNames)
  if (!hint) return system
  if (!system || system.trim().length === 0) return hint
  return `${system}\n\n${hint}`
}

export function truncateSystemPrompt(system: string, maxChars: number): string {
  if (maxChars <= 0 || system.length <= maxChars) return system
  const suffix = '\n\n---\n[Skill 内容已截断以适配上下文窗口]'
  const budget = Math.max(0, maxChars - suffix.length)
  return system.slice(0, budget) + suffix
}
