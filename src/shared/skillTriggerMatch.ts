/**
 * Skill 触发词匹配（两端共用）：lowercase 子串包含。
 * 由 electron/skills/skillMatcher（legacy/autoDetect 匹配）与
 * electron/skills/skillRouter（W1-a llm-wiki 确定性激活）共享，避免循环依赖。
 */
export function keywordMatch(userInput: string, triggers: string[]): boolean {
  const lower = userInput.toLowerCase()
  return triggers.some((t) => t.length > 0 && lower.includes(t.toLowerCase()))
}
