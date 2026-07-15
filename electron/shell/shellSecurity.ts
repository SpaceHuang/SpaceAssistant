import {
  extractCommandName,
  extractRmPathArguments,
  hasRmRecursiveFlag,
  isFatalRmTarget
} from './shellSecurityHelpers'
import type {
  ShellPathVerdict,
  ShellSecurityCheckResult,
  ShellSecurityContext,
  ShellSecurityDenyType,
  ShellSecurityVerdict
} from './shellTypes'

export type {
  ShellPathVerdict,
  ShellSecurityCheckResult,
  ShellSecurityContext,
  ShellSecurityDenyType,
  ShellSecurityVerdict
} from './shellTypes'

interface ShellSecurityValidator {
  id: string
  denyType?: ShellSecurityDenyType
  check(ctx: ShellSecurityContext): ShellSecurityVerdict | null
}

const PIPE_TO_SHELL_PATTERN =
  /\|\s*(sh|bash|zsh|ksh|dash|csh|tcsh|fish|pwsh|powershell|cmd|python|python3|node|perl|ruby|php|eval|iex|Invoke-Expression)\b/i

const DANGEROUS_FORMAT_CMDS = new Set([
  'mkfs',
  'mkfs.ext2',
  'mkfs.ext3',
  'mkfs.ext4',
  'mkfs.xfs',
  'mkdosfs',
  'mke2fs',
  'mkswap',
  'wipefs',
  'shred',
  'parted',
  'fdisk',
  'diskpart',
  'format'
])

const DANGEROUS_ENV_PATTERNS = [
  /\bIFS\s*=/,
  /\bLD_PRELOAD\s*=/,
  /\bLD_AUDIT\s*=/,
  /\bLD_LIBRARY_PATH\s*=/,
  /\bDYLD_INSERT_LIBRARIES\s*=/,
  /\bDYLD_FORCE_FLAT_NAMESPACE\s*=/,
  /\bDYLD_LIBRARY_PATH\s*=/,
  /\bDYLD_FALLBACK_LIBRARY_PATH\s*=/
]

/** multiline / command_substitution / redirection were removed (P1 remote-private-chat security). */
const VALIDATORS: ShellSecurityValidator[] = [
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
    id: 'pipe_to_shell',
    check(ctx) {
      if (PIPE_TO_SHELL_PATTERN.test(ctx.command)) return 'deny'
      return null
    }
  },
  {
    id: 'background_exec',
    check(ctx) {
      const cmd = ctx.command.trim()
      if (cmd.endsWith('&') && !cmd.endsWith('&&') && !cmd.endsWith('||')) {
        const lastTwoChars = cmd.slice(-2)
        if (lastTwoChars !== '>&' && lastTwoChars !== '2>') {
          return 'deny'
        }
      }
      return null
    }
  },
  {
    id: 'dangerous_rm',
    denyType: 'weak',
    check(ctx) {
      if (!hasRmRecursiveFlag(ctx.command)) return null
      const pathArgs = extractRmPathArguments(ctx.command)
      for (const pathArg of pathArgs) {
        if (isFatalRmTarget(pathArg, ctx.platform)) return 'deny'
      }
      return 'ask'
    }
  },
  {
    id: 'disk_format',
    check(ctx) {
      for (const segment of ctx.segments.length ? ctx.segments : [ctx.command]) {
        const cmdName = extractCommandName(segment)
        if (DANGEROUS_FORMAT_CMDS.has(cmdName)) return 'deny'
      }
      return null
    }
  },
  {
    id: 'disk_wipe',
    check(ctx) {
      const lower = ctx.command.toLowerCase()
      const wipePatterns = [
        /\bdd\b.*\bof=\/dev\//,
        /\bdd\b.*\bif=\/dev\/zero\b/,
        /\bdd\b.*\bif=\/dev\/random\b/,
        /\bdd\b.*\bif=\/dev\/urandom\b/
      ]
      if (wipePatterns.some((pattern) => pattern.test(lower))) return 'deny'
      return null
    }
  },
  {
    id: 'dangerous_env',
    check(ctx) {
      for (const pattern of DANGEROUS_ENV_PATTERNS) {
        if (pattern.test(ctx.command)) return 'deny'
      }
      return null
    }
  },
  {
    id: 'dangerous_git',
    denyType: 'weak',
    check(ctx) {
      const lower = ctx.command.toLowerCase()
      const dangerousPatterns = [
        /\bgit\s+push\s+.*--force\b/,
        /\bgit\s+push\s+.*-f\b/,
        /\bgit\s+reset\s+.*--hard\b/,
        /\bgit\s+clean\s+.*-fdx?\b/
      ]
      if (dangerousPatterns.some((pattern) => pattern.test(lower))) return 'ask'
      return null
    }
  },
  {
    id: 'npm_publish',
    denyType: 'weak',
    check(ctx) {
      const lower = ctx.command.toLowerCase()
      if (/\b(npm|yarn|pnpm)\s+publish\b/.test(lower)) return 'ask'
      return null
    }
  }
]

export function getShellSecurityDenyMessage(validatorId: string): string {
  switch (validatorId) {
    case 'privilege':
      return '禁止提权命令（sudo/doas）'
    case 'lark_cli':
      return '请使用 run_lark_cli 工具操作飞书，而非 shell 调用 lark-cli'
    case 'interactive_shell':
      return '不支持交互式 shell'
    case 'pipe_to_shell':
      return (
        '检测到危险的远程脚本执行\n\n' +
        '这个命令会从网络下载脚本并直接运行。如果网址被劫持或下载内容被篡改，可能造成损失。\n\n' +
        '建议：先用 curl … -o script.sh 下载到本地，查看内容后再执行。'
      )
    case 'background_exec':
      return (
        '不支持后台执行命令\n\n' +
        '命令末尾的 & 会让进程在后台运行，但 Agent 无法跟踪其状态和日志，也无法正确清理。\n\n' +
        '建议：去掉末尾的 & 直接执行，或使用专用的后台任务工具。'
      )
    case 'dangerous_rm':
      return (
        '检测到致命的删除操作\n\n' +
        '尝试删除根目录 /、用户主目录 ~ 或其他系统级目录，这会导致数据完全丢失。\n\n' +
        '建议：请确认目标路径是否正确，如需删除项目内目录（如 node_modules），系统会在确认后执行。'
      )
    case 'disk_format':
      return (
        '禁止磁盘格式化命令\n\n' +
        'mkfs、format 等命令会完全清除磁盘上的所有数据，且无法恢复。\n\n' +
        '建议：如需格式化磁盘，请使用操作系统提供的工具手动操作。'
      )
    case 'disk_wipe':
      return (
        '检测到磁盘擦除风险\n\n' +
        'dd if=/dev/zero of=/dev/… 会用零覆盖整个磁盘，导致所有数据永久丢失。\n\n' +
        '建议：请确认命令参数是否正确，如需备份磁盘镜像，请使用专用备份工具。'
      )
    case 'dangerous_env':
      return (
        '检测到动态库劫持风险\n\n' +
        'LD_PRELOAD、DYLD_* 等环境变量可用于注入恶意代码，绕过安全检查。\n\n' +
        '建议：请移除这些环境变量后再执行命令。'
      )
    case 'dangerous_git':
      return (
        '警告：此操作可能导致数据丢失\n\n' +
        'git push -f、git reset --hard 或 git clean -fdx 会永久删除未提交的修改或覆盖远程分支。\n\n' +
        '确认执行？'
      )
    case 'npm_publish':
      return (
        '警告：即将发布到公开仓库\n\n' +
        'npm publish 会将当前包发布到 npm 公开仓库，所有人都可以下载。\n\n' +
        '确认执行？'
      )
    default:
      return '命令未通过安全检查，已拒绝执行'
  }
}

export function getShellSecurityWarningMessage(validatorId: string): string {
  switch (validatorId) {
    case 'dangerous_rm':
      return (
        '警告：此操作将递归删除目录\n\n' +
        'rm -rf 会永久删除目标目录及其所有内容，且无法恢复。\n\n' +
        '确认执行？'
      )
    case 'dangerous_git':
    case 'npm_publish':
      return getShellSecurityDenyMessage(validatorId)
    default:
      return getShellSecurityDenyMessage(validatorId)
  }
}

export function runShellSecurityValidators(ctx: ShellSecurityContext): ShellSecurityCheckResult {
  for (const v of VALIDATORS) {
    const r = v.check(ctx)
    if (r === 'deny') {
      return { verdict: 'deny', validatorId: v.id, denyType: 'strong' }
    }
    if (r === 'ask') {
      return { verdict: 'ask', validatorId: v.id, denyType: v.denyType ?? 'weak' }
    }
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
