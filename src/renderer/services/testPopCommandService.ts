export type TestPopCommandResult =
  | { type: 'chat'; text: string }
  | { type: 'command'; hint: string }
  | { type: 'run' }

export function parseTestPopCommand(text: string): TestPopCommandResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/test-pop')) return { type: 'chat', text }

  const parts = trimmed.split(/\s+/).filter(Boolean)
  const sub = parts[1]?.toLowerCase()

  if (sub === 'help') {
    return {
      type: 'command',
      hint: '[Dev] /test-pop — 在桌面右下角弹出浮动通知窗口（模拟待确认项），用于 UI 样式测试。\n仅开发模式可用。'
    }
  }

  if (!import.meta.env.DEV) {
    return { type: 'command', hint: '[Dev] /test-pop 仅在开发模式下可用' }
  }

  return { type: 'run' }
}
