import { CURRENT_SCHEMA_VERSION, type Message, type SkillHintRecord } from './domainTypes'

export function createSkillHintRecord(text: string, shownAt = Date.now()): SkillHintRecord {
  return { id: crypto.randomUUID(), text, shownAt }
}

export function appendSkillHintRecord(
  hints: SkillHintRecord[] | undefined,
  text: string,
  shownAt = Date.now()
): SkillHintRecord[] {
  return [...(hints ?? []), createSkillHintRecord(text, shownAt)]
}

/** 仅承载 Skill 提示的系统消息（如 /skill 命令反馈） */
export function createSkillHintSystemMessage(sessionId: string, text: string, shownAt = Date.now()): Message {
  const hint = createSkillHintRecord(text, shownAt)
  return {
    id: crypto.randomUUID(),
    sessionId,
    role: 'system',
    content: '',
    skillHints: [hint],
    timestamp: shownAt,
    status: 'completed',
    schemaVersion: CURRENT_SCHEMA_VERSION
  }
}
