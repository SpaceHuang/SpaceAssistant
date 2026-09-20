import { augmentShellPathEnv, pickSafeNodeOptions } from './shell/shellSpawnEnv'

/** 运行 shell 命令时的子进程环境：剔除 API Key 等敏感变量。 */
export function buildShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const denyKey = (k: string) =>
    /API_KEY/i.test(k) ||
    k.startsWith('ANTHROPIC_') ||
    k.startsWith('OPENAI_') ||
    k.startsWith('ELECTRON_') ||
    k === 'NODE_OPTIONS'

  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || denyKey(k)) continue
    if (k === 'NODE_OPTIONS') continue
    if (process.platform === 'win32' && (k === 'Path' || k === 'PATH' || k === 'path')) continue
    env[k] = v
  }
  const pathValue = augmentShellPathEnv(base)
  if (process.platform === 'win32') {
    env.Path = pathValue
    env.PATH = pathValue
    // 取到有效值才写（P0-0b 纵深防御）：空串与缺键同样导致宿主初始化失败（0x8009001D），
    // 不再主动注入空值制造"看起来有值"的假象；上游过滤恰好删掉某键时从 process.env 兜底拿回。
    const systemRoot = base.SystemRoot || process.env.SystemRoot
    if (systemRoot) env.SystemRoot = systemRoot
    const userProfile = base.USERPROFILE || process.env.USERPROFILE
    if (userProfile) env.USERPROFILE = userProfile
    const localAppData = base.LOCALAPPDATA || process.env.LOCALAPPDATA
    if (localAppData) env.LOCALAPPDATA = localAppData
    const comSpec = base.ComSpec || process.env.ComSpec
    env.ComSpec = comSpec || 'cmd.exe'
  } else {
    env.PATH = pathValue
    env.HOME = base.HOME ?? ''
    env.LANG = base.LANG ?? 'C.UTF-8'
    env.LC_ALL = base.LC_ALL ?? env.LANG
  }
  const nodeOptions = pickSafeNodeOptions(base)
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions
  return env
}

/** 运行 Python 脚本时的子进程环境：对齐 Shell 密钥过滤，并强制 UTF-8 IO。 */
export function buildPythonScriptEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = buildShellEnv(base)
  env.PYTHONIOENCODING = 'utf-8'
  if (process.platform === 'win32') {
    env.PYTHONUTF8 = '1'
  }
  return env
}
