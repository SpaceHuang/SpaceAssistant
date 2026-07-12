import { formatAgentLogDateKey, resolveAgentLogDir } from '../agentLogger/agentLogPaths'

export function formatWeChatCliLogFileName(date: Date): string {
  return `WeChatCli-${formatAgentLogDateKey(date)}.log`
}

export function resolveWeChatCliLogDir(isPackaged: boolean, workDir: string, mainDirname: string): string {
  return resolveAgentLogDir(isPackaged, workDir, mainDirname)
}
