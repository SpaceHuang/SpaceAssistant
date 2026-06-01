import { isLarkCliWriteOperation, redactLarkCliArgsForDisplay } from '../../src/shared/larkCliDisplay'

export { isLarkCliWriteOperation, redactLarkCliArgsForDisplay }

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
