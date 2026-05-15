import type { SessionSkillsState, SkillDefinition } from '../../shared/domainTypes'
import { normalizeSessionSkillsState } from '../../shared/domainTypes'

export type SkillCommandResult =
  | { type: 'chat'; text: string }
  | { type: 'command'; hint: string; skillsState?: SessionSkillsState }

function formatSkillList(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '[Skill] 当前没有可用 Skill'
  const lines = skills.map(
    (s) => `- ${s.meta.name} (${s.scope === 'project' ? '项目级' : '用户级'}) v${s.meta.version}: ${s.meta.description}`
  )
  return `[Skill] 可用 Skill 列表：\n${lines.join('\n')}`
}

export async function parseSkillCommand(
  text: string,
  sessionState: SessionSkillsState
): Promise<SkillCommandResult> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/skill')) return { type: 'chat', text }

  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = parts[1]?.toLowerCase()

  if (!sub || sub === 'help') {
    return {
      type: 'command',
      hint: '[Skill] 命令：/skill list | use <name> | disable <name> | status'
    }
  }

  const state = normalizeSessionSkillsState(sessionState)

  if (sub === 'list') {
    const skills = await window.api.skillList()
    return { type: 'command', hint: formatSkillList(skills) }
  }

  if (sub === 'status') {
    const activated = state.manualActivated.length ? state.manualActivated.join('、') : '无'
    const disabled = state.manualDisabled.length ? state.manualDisabled.join('、') : '无'
    return { type: 'command', hint: `[Skill] 手动激活: ${activated}\n[Skill] 会话禁用: ${disabled}` }
  }

  const arg = parts[2]
  if (!arg) {
    return { type: 'command', hint: `[Skill] 缺少 Skill 名称，用法: /skill ${sub} <name>` }
  }

  if (sub === 'use') {
    const skill = await window.api.skillGet({ name: arg })
    if (!skill) return { type: 'command', hint: `[Skill] 未找到 Skill「${arg}」` }
    const manualActivated = [...new Set([...state.manualActivated, arg])]
    const manualDisabled = state.manualDisabled.filter((n) => n !== arg)
    return {
      type: 'command',
      hint: `[Skill] 已手动激活: ${arg}（${skill.scope === 'project' ? '项目级' : '用户级'}）`,
      skillsState: { manualActivated, manualDisabled }
    }
  }

  if (sub === 'disable') {
    const skill = await window.api.skillGet({ name: arg })
    if (!skill) return { type: 'command', hint: `[Skill] 未找到 Skill「${arg}」` }
    const manualDisabled = [...new Set([...state.manualDisabled, arg])]
    const manualActivated = state.manualActivated.filter((n) => n !== arg)
    return {
      type: 'command',
      hint: `[Skill] 本次会话已禁用: ${arg}`,
      skillsState: { manualActivated, manualDisabled }
    }
  }

  return { type: 'command', hint: `[Skill] 未知命令「${sub}」，输入 /skill help 查看帮助` }
}
