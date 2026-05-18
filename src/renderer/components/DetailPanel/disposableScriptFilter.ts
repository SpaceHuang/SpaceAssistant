/** 判断文件路径是否为 Agent 生成的一次性脚本 */
const DISPOSABLE_SCRIPT_PATTERNS: RegExp[] = [
  // 规则 1：临时目录
  /^(tmp|temp|\.tmp)\//,
  // 规则 2：临时前缀
  /(?:^|\/)(tmp|temp)_[\w-]+\.\w+$/,
  // 规则 3：Agent 一次性脚本命名
  /(?:^|\/)(script|run|fix|patch|migrate|convert|process|generate|setup)_[\w-]+\.\w+$/,
  // 规则 4：根/一级目录下的简短 Python 脚本
  /^[^/]+\/?[\w-]{1,32}\.py$/,
]

const PROJECT_ENTRY_FILES = new Set([
  'app.py', 'main.py', 'server.py', 'manage.py',
  'wsgi.py', 'asgi.py', 'conftest.py', 'setup.py',
  '__init__.py', '__main__.py',
])

export function isDisposableScript(filePath: string): boolean {
  // 规则 4 的白名单排除：若文件名在项目入口白名单中，则跳过规则 4
  const fileName = filePath.includes('/')
    ? filePath.slice(filePath.lastIndexOf('/') + 1)
    : filePath

  for (let i = 0; i < DISPOSABLE_SCRIPT_PATTERNS.length; i++) {
    if (i === 3 && PROJECT_ENTRY_FILES.has(fileName)) continue
    if (DISPOSABLE_SCRIPT_PATTERNS[i].test(filePath)) return true
  }
  return false
}