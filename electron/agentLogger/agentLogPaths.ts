import path from 'path'

export function formatAgentLogDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

export function formatAgentLogFileName(date: Date): string {
  return `Agent-${formatAgentLogDateKey(date)}.log`
}

export function resolveDevAgentLogDir(mainDirname: string): string {
  return path.resolve(mainDirname, '..', '..', 'logs')
}

/** 发布态：日志写入工作目录；开发态：日志写入项目代码目录下的 logs/ */
export function isAgentLogProductionMode(isPackaged: boolean): boolean {
  return isPackaged
}

export function resolveAgentLogDir(isPackaged: boolean, workDir: string, mainDirname: string): string {
  if (isPackaged) {
    return path.join(workDir, '.agent', 'logs')
  }
  return resolveDevAgentLogDir(mainDirname)
}
