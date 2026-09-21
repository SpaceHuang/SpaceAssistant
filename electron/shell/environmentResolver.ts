import crypto from 'crypto'

const BASE_KEYS = new Set([
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'NODE_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
])
const SECRET_NAME = /(api[_-]?key|token|secret|password|passwd|authorization|private[_-]?key)/i

export interface ResolvedEnvironment {
  env: NodeJS.ProcessEnv
  fingerprint: string
  removedKeys: string[]
}

/**
 * 白名单键名归一化（仅 win32）：Windows 环境变量键名大小写随启动源而异
 * （Explorer/快捷方式下发混合大小写 SystemRoot，Git Bash/MSYS 下发全大写 SYSTEMROOT），
 * 精确匹配会把 SystemRoot/ComSpec 剔除，导致子进程 SystemRoot=''、
 * powershell 托管宿主初始化失败（0x8009001D / 0xFFFF0000）。
 *
 * POSIX 键名大小写敏感（PATH 与 path 是不同的键），无条件归一化会意外放行
 * path/home 等小写变体、改变白名单语义，因此归一化只在 win32 生效。
 */
function keyNormalizerFor(platform: NodeJS.Platform): (key: string) => string {
  return platform === 'win32' ? (key) => key.toUpperCase() : (key) => key
}

export function resolveShellEnvironment(
  source: NodeJS.ProcessEnv,
  explicitKeys: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): ResolvedEnvironment {
  const normalizeKey = keyNormalizerFor(platform)
  const allowed = new Set([...BASE_KEYS, ...explicitKeys].map(normalizeKey))
  const env: NodeJS.ProcessEnv = {}
  const removedKeys: string[] = []
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!allowed.has(normalizeKey(key)) || SECRET_NAME.test(key)) {
      removedKeys.push(key)
      continue
    }
    env[key] = value
  }
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(Object.keys(env).sort().map((key) => [key, env[key]])))
    .digest('hex')
  return { env, fingerprint, removedKeys: removedKeys.sort() }
}
