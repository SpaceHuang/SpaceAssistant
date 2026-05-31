import type { ShellPathVerdict, ShellSecurityContext, ShellSecurityVerdict } from './shellTypes'

export type { ShellPathVerdict, ShellSecurityContext, ShellSecurityVerdict } from './shellTypes'

interface ShellSecurityValidator {
  id: string
  check(ctx: ShellSecurityContext): ShellSecurityVerdict | null
}

const VALIDATORS: ShellSecurityValidator[] = [
  {
    id: 'multiline',
    check(ctx) {
      if (/[\n\r\u2028\u2029]/.test(ctx.command)) return 'deny'
      return null
    }
  },
  {
    id: 'command_substitution',
    check(ctx) {
      if (/\$\(|`|\$\{/.test(ctx.command)) return 'deny'
      return null
    }
  },
  {
    id: 'redirection',
    check(ctx) {
      if (/>>|<<|[<>]/.test(ctx.command)) return 'deny'
      return null
    }
  },
  {
    id: 'privilege',
    check(ctx) {
      const lower = ctx.command.toLowerCase()
      if (/\b(sudo|doas|runas)\b/.test(lower)) return 'deny'
      return null
    }
  },
  {
    id: 'lark_cli',
    check(ctx) {
      if (/\blark-cli\b/i.test(ctx.command)) return 'deny'
      return null
    }
  },
  {
    id: 'interactive_shell',
    check(ctx) {
      if (/\b(bash|sh)\s+-i\b/i.test(ctx.command)) return 'deny'
      return null
    }
  },
  {
    id: 'dangerous_env',
    check(ctx) {
      if (/\b(IFS|LD_PRELOAD|LD_LIBRARY_PATH)\s*=/.test(ctx.command)) return 'deny'
      return null
    }
  }
]

export function getShellSecurityDenyMessage(validatorId: string): string {
  switch (validatorId) {
    case 'multiline':
      return '不支持多行命令'
    case 'command_substitution':
      return '检测到命令替换（$() 或反引号），已拒绝执行'
    case 'redirection':
      return '不支持输入/输出重定向，请改用专用文件工具'
    case 'privilege':
      return '禁止提权命令（sudo/doas）'
    case 'lark_cli':
      return '请使用 run_lark_cli 工具操作飞书，而非 shell 调用 lark-cli'
    case 'interactive_shell':
      return '不支持交互式 shell'
    case 'dangerous_env':
      return '检测到危险环境变量注入，已拒绝执行'
    default:
      return '命令未通过安全检查，已拒绝执行'
  }
}

export function runShellSecurityValidators(ctx: ShellSecurityContext): { verdict: ShellSecurityVerdict; validatorId?: string } {
  for (const v of VALIDATORS) {
    const r = v.check(ctx)
    if (r === 'deny') return { verdict: 'deny', validatorId: v.id }
  }
  if (ctx.pathVerdict.decision === 'deny') return { verdict: 'deny' }
  return { verdict: 'ask' }
}

export function buildSecurityContext(
  command: string,
  platform: NodeJS.Platform,
  workDir: string,
  segments: string[],
  pathVerdict: ShellPathVerdict,
  pathLiterals: ShellSecurityContext['pathLiterals']
): ShellSecurityContext {
  return { command, platform, workDir, segments, pathLiterals, pathVerdict }
}
