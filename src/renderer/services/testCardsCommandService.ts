export type TestCardsCommandResult =
  | { type: 'chat'; text: string }
  | { type: 'command'; hint: string }
  | { type: 'run' }

export function parseTestCardsCommand(text: string): TestCardsCommandResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/test-cards')) return { type: 'chat', text }

  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = parts[1]?.toLowerCase()

  if (sub === 'help') {
    return {
      type: 'command',
      hint: '[Dev] /test-cards — 在当前会话依次展示所有交互卡片及各状态 mock，用于 UI 样式测试。\n仅开发模式可用。'
    }
  }

  if (!import.meta.env.DEV) {
    return { type: 'command', hint: '[Dev] /test-cards 仅在开发模式下可用' }
  }

  return { type: 'run' }
}
