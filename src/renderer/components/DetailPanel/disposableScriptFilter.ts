/** 判断文件路径是否为 Agent 生成的临时文件（仅按目录/前缀识别，不误伤正式脚本） */
const DISPOSABLE_SCRIPT_PATTERNS: RegExp[] = [
  // 临时目录
  /^(tmp|temp|\.tmp)\//,
  // 临时前缀
  /(?:^|\/)(tmp|temp)_[\w-]+\.\w+$/,
]

export function isDisposableScript(filePath: string): boolean {
  return DISPOSABLE_SCRIPT_PATTERNS.some((pattern) => pattern.test(filePath))
}
