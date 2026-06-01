const WRITE_PAIRS: Array<[string, string?]> = [
  ['message', 'send'],
  ['message', 'reply'],
  ['doc', 'create'],
  ['doc', 'update'],
  ['calendar', 'create'],
  ['calendar', 'update'],
  ['mail', 'send'],
  ['mail', 'reply'],
  ['task', 'create'],
  ['task', 'update']
]

const BITABLE_READ_SUBS = new Set(['list', 'read', 'get'])

export function normalizeLarkCliArgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

export function isLarkCliWriteOperation(args: string[]): boolean {
  const [cmd, sub] = args
  if (cmd === 'api') {
    const method = (sub ?? '').toUpperCase()
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  }
  if (WRITE_PAIRS.some(([a, b]) => cmd === a && (b === undefined || sub === b))) return true
  if (cmd === 'bitable' && sub && !BITABLE_READ_SUBS.has(sub)) return true
  return false
}

export function redactLarkCliArgsForDisplay(args: string[]): string {
  const parts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const prev = i > 0 ? args[i - 1] : ''
    if (prev === '--secret' || /--token/i.test(prev) || /--secret/i.test(a)) {
      parts.push('***')
      continue
    }
    parts.push(a)
  }
  const joined = `lark-cli ${parts.join(' ')}`
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined
}

export function formatLarkCliHeadline(args: string[]): string {
  if (args.length === 0) return '飞书 CLI'
  if (args.length === 1) return `飞书 ${args[0]}`
  return `飞书 ${args[0]} ${args[1]}`
}

export type LarkCliConfirmSummary = {
  headline: string
  command: string
  isWriteOperation: boolean
  hint: string
}

export function summarizeLarkCliConfirmInput(input: Record<string, unknown>): LarkCliConfirmSummary {
  const args = normalizeLarkCliArgs(input.args)
  const command = args.length > 0 ? redactLarkCliArgsForDisplay(args) : 'lark-cli (空)'
  const isWriteOperation = args.length > 0 && isLarkCliWriteOperation(args)
  return {
    headline: formatLarkCliHeadline(args),
    command,
    isWriteOperation,
    hint: isWriteOperation
      ? '此命令可能修改飞书数据，请确认后再执行。'
      : '仅执行 lark-cli 参数，不含 shell 管道与重定向。'
  }
}
