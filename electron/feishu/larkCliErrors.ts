export interface ParsedLarkCliError {
  message: string
  hint?: string
}

const ERROR_PATTERNS: Array<{ re: RegExp; message: string; hint?: string }> = [
  {
    re: /command not found|不是内部或外部命令|is not recognized as an internal or external command/i,
    message: '请先安装 lark-cli',
    hint: '设置 → 飞书 → 安装 CLI'
  },
  { re: /not configured|config init/i, message: '请完成飞书应用配置', hint: '设置 → 飞书 → 配置飞书应用' },
  {
    re: /scope|permission/i,
    message: '飞书权限不足',
    hint: '设置 → 飞书 → 补充授权（lark-cli auth login --scope）'
  },
  { re: /authorization|token expired|unauthorized/i, message: '飞书授权已过期', hint: '请重新登录飞书账号' },
  { re: /99991662/, message: '飞书 API 权限被拒绝', hint: '请检查开放平台应用权限与发布状态' }
]

export function parseLarkCliError(stderr: string): ParsedLarkCliError {
  const text = stderr.trim()
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(text)) {
      return { message: p.message, hint: p.hint }
    }
  }
  return { message: text || 'lark-cli 执行失败' }
}
