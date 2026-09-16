/**
 * Agent 边界的自由文本脱敏（事实驱动，不做路径猜测）。
 *
 * 只做两类有把握的替换：
 * 1. 主目录前缀折叠：应用确切知道 os.homedir()，把文本中主目录绝对路径的已知
 *    前缀精确替换为 `~`（覆盖原生、正斜杠、JSON 转义反斜杠，以及 Git Bash 的
 *    /c/...、WSL 的 /mnt/c/...、Cygwin 的 /cygdrive/c/... 形态），移除路径中唯一
 *    真正敏感的信息（用户名），其余部分保持可读可用。
 *    精确前缀匹配不会误伤散文（“输入 / 输出” 之类的斜杠永远不命中已知前缀）。
 * 2. 秘密脱敏：PEM 块、KEY/TOKEN/... 赋值、Bearer token，结构明确。
 *
 * 旧版基于正则猜测“疑似路径”的机制（<path:redacted> / ambiguous_path）会吞掉
 * 文档正文，已移除；历史数据中已落盘的旧标记原样保留，新结果不再产生。
 */

export interface SanitizedAgentText {
  text: string
  redacted: boolean
  redactionReason?: 'secret'
}

interface HomePrefixRule {
  re: RegExp
}

let homeRules: HomePrefixRule[] = []

/**
 * 注入已知主目录，主进程启动时调用一次；不注入时只做秘密脱敏。
 * 渲染进程不注入（历史里已落盘的标记原样展示），测试可显式设置/重置。
 */
export function setKnownHomeDir(home: string | undefined): void {
  homeRules = buildHomeRules(home)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// String.raw 保证反斜杠按正则字面量语义书写，避免字符串转义坍缩（review D1 教训：
// '...\\/-]' 传入 RegExp 后 \\ 坍缩成 \/，字符类里实际丢失反斜杠）。
// 前导与后界刻意不对称（review v2 B1）：前导只防 ASCII 标识符/URL 粘连
// （x/Users/alice）——CJK 文字紧贴路径是中文行文的常态，若一并阻断会让最常见的
// 无空格形态漏折叠、用户名外泄；后界保留 \p{L}\p{N}，非 ASCII 用户名
// （如 张三 vs 张三丰）不会被截断误折叠（review O1），CJK 标点仍可作后界。
const LEADING_BOUNDARY = String.raw`(?<![A-Za-z0-9_.\\/-])`
const TRAILING_BOUNDARY = String.raw`(?![\p{L}\p{N}_.~-])`
// 分隔符按 双反斜杠（JSON 转义）→ 单反斜杠/正斜杠 顺序尝试。
const SEG_SEP = String.raw`(?:\\{2}|[\\/])`

function buildHomeRules(home: string | undefined): HomePrefixRule[] {
  if (!home) return []
  const segments = home.split(/[\\/]+/).filter(Boolean)
  // 至少两级目录（如 /Users/alice、C:\Users\alice），防止把盘符/根目录当主目录。
  if (segments.length < 2) return []
  const caseInsensitive = typeof process !== 'undefined' && process.platform === 'win32'
  // u 标志是 \p{...} Unicode 属性类所必需。
  const flags = caseInsensitive ? 'giu' : 'gu'
  const rules: HomePrefixRule[] = []
  // 前导分隔符必须参与匹配：否则 /Users/alice 会在 /Users/alice/x 里匹配出 “/~/x”。
  // UNC 用 2+ 反斜杠：同时命中原生 \\NAS\... 与 JSON 转义 \\\\NAS\... 的反斜杠串。
  const leading = /^\\\\/.test(home) ? String.raw`\\{2,}` : /^[\\/]/.test(home) ? '/' : ''
  rules.push({
    re: new RegExp(LEADING_BOUNDARY + leading + segments.map(escapeRe).join(SEG_SEP) + TRAILING_BOUNDARY, flags)
  })
  const drive = segments[0]!.match(/^([A-Za-z]):$/)
  if (drive) {
    // 盘符形态主目录在各 POSIX 化 shell 里的投影：Git Bash(/c/...)、WSL(/mnt/c/...)、
    // Cygwin(/cygdrive/c/...)。已知限制（接受）：8.3 短名（如 SPACE~1）需 Win32
    // GetShortPathNameW 才能折叠；//c/... 双斜杠变体被前导边界守卫阻断。
    const driveLower = drive[1]!.toLowerCase()
    const rest = segments.slice(1).map(escapeRe).join('/')
    for (const prefix of ['/', '/mnt/', '/cygdrive/']) {
      rules.push({
        re: new RegExp(LEADING_BOUNDARY + prefix + driveLower + '/' + rest + TRAILING_BOUNDARY, flags)
      })
    }
  }
  return rules
}

// 次序有意为之：先做赋值/Bearer 替换，最后整块替换 PEM——若先替换 PEM，
// 产出的 `<secret:redacted>` 标记里的 “SECRET:” 会被赋值模式二次命中。
const SECRET_REDACTIONS: Array<[RegExp, string]> = [
  [/((?:API[_-]?KEY|TOKEN|SECRET|COOKIE|PASSWORD|PASSWD)\s*[=:]\s*)[^\s,;]+/gi, '$1<secret:redacted>'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<secret:redacted>'],
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, '<secret:redacted>']
]

/** 对进入 Agent、日志或历史的自由文本执行统一脱敏。 */
export function sanitizeAgentText(input: string): SanitizedAgentText {
  let text = input
  for (const { re } of homeRules) text = text.replace(re, '~')
  const afterHomeCollapse = text
  for (const [re, replacement] of SECRET_REDACTIONS) text = text.replace(re, replacement)
  if (text === input) return { text, redacted: false }
  return {
    text,
    redacted: true,
    ...(text !== afterHomeCollapse ? { redactionReason: 'secret' as const } : {})
  }
}
