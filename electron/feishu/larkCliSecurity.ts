const SHELL_METACHAR_RE = /[;|&><`$(){}[\]\\]/

const ALLOWED_SUBCOMMANDS = new Set([
  'message',
  'doc',
  'calendar',
  'bitable',
  'mail',
  'task',
  'wiki',
  'contact',
  'search',
  'api',
  'auth',
  'config',
  'schema',
  'help',
  'meeting'
])

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

export function assertSafeLarkCliArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.length === 0) throw new Error('args 必须为非空数组')
  const normalized = args.map((a) => {
    if (typeof a !== 'string') throw new Error('args 元素必须为 string')
    if (SHELL_METACHAR_RE.test(a)) throw new Error('参数含非法 shell 字符')
    return a
  })
  if (!ALLOWED_SUBCOMMANDS.has(normalized[0])) {
    throw new Error(`不允许的 lark-cli 子命令: ${normalized[0]}`)
  }
  if (normalized[0] === 'event') throw new Error('event 子命令不可通过 Agent 工具调用')
  return normalized
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
