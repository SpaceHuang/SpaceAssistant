import path from 'path'

export interface ToolchainResolution {
  pathEntries: string[]
  sources: string[]
}

/**
 * 统一发现 GUI 启动时常见的 Node 工具链目录。
 * 这里只解析已有环境变量/显式目录，不执行 shell profile，也不猜测用户命令。
 */
export function resolveNodeToolchainPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): ToolchainResolution {
  const delimiter = platform === 'win32' ? ';' : path.delimiter
  const existing = [env.PATH, env.Path, env.path]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(delimiter).filter(Boolean))
  const candidates: Array<[string, string | undefined]> = [
    ['nvm', env.NVM_BIN],
    ['fnm', env.FNM_MULTISHELL_PATH],
    ['volta', env.VOLTA_HOME ? path.join(env.VOLTA_HOME, 'bin') : undefined],
    ['windows-node', platform === 'win32' && env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs') : undefined],
    ['windows-node-x86', platform === 'win32' && env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'nodejs') : undefined],
    ['windows-node-local', platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'nodejs') : undefined],
    ['windows-npm', platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'npm') : undefined]
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
