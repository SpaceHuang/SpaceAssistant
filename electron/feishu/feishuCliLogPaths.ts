import { formatAgentLogDateKey, resolveAgentLogDir } from '../agentLogger/agentLogPaths'

export function formatFeishuCliLogFileName(date: Date): string {
  return `FeishuCli-${formatAgentLogDateKey(date)}.log`
}

export function resolveFeishuCliLogDir(isPackaged: boolean, workDir: string, mainDirname: string): string {
  return resolveAgentLogDir(isPackaged, workDir, mainDirname)
}
