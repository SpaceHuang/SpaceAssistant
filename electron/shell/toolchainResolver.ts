import path from 'path'

export interface ToolchainResolution {
  pathEntries: string[]
  sources: string[]
}

/**
 * path 语义必须跟随目标 platform，而不是宿主机：
 * 在非 Windows 主机上解析 Windows fixture 时，宿主机 path.join/delimiter 会产出错误的分隔符。
 */
function pathForPlatform(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * 统一发现 GUI 启动时常见的 Node 工具链目录。
 * 这里只解析已有环境变量/显式目录，不执行 shell profile，也不猜测用户命令。
 */
export function resolveNodeToolchainPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): ToolchainResolution {
  const pathApi = pathForPlatform(platform)
  const delimiter = pathApi.delimiter
  const existing = [env.PATH, env.Path, env.path]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(delimiter).filter(Boolean))
  const candidates: Array<[string, string | undefined]> = [
    ['nvm', env.NVM_BIN],
    ['fnm', env.FNM_MULTISHELL_PATH],
    ['volta', env.VOLTA_HOME ? pathApi.join(env.VOLTA_HOME, 'bin') : undefined],
    ['windows-node', platform === 'win32' && env.ProgramFiles ? pathApi.join(env.ProgramFiles, 'nodejs') : undefined],
    ['windows-node-x86', platform === 'win32' && env['ProgramFiles(x86)'] ? pathApi.join(env['ProgramFiles(x86)'], 'nodejs') : undefined],
    ['windows-node-local', platform === 'win32' && env.LOCALAPPDATA ? pathApi.join(env.LOCALAPPDATA, 'Programs', 'nodejs') : undefined],
    ['windows-npm', platform === 'win32' && env.APPDATA ? pathApi.join(env.APPDATA, 'npm') : undefined]
  ]
  const pathEntries: string[] = []
  const sources: string[] = []
  for (const [source, value] of candidates) {
    if (!value || pathEntries.includes(value)) continue
    pathEntries.push(value)
    sources.push(source)
  }
  for (const entry of existing) {
    if (!pathEntries.includes(entry)) pathEntries.push(entry)
  }
  return { pathEntries, sources }
}
