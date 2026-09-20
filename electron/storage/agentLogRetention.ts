import fs from 'fs/promises'
import path from 'node:path'
import { logAgentEvent } from '../agentLogger/agentLogger'
import { formatAgentLogDateKey, formatAgentLogFileName } from '../agentLogger/agentLogPaths'

/**
 * Agent 日志保留期清理(S3,偏差 14):日志按日文件天然轮转(Agent-YYYYMMDD.log),
 * 此处补「超保留期删除」,挂接 storage/retentionPolicy.ts 的统一保留策略(agentLogRetentionDays);
 * 删除留痕:removed > 0 时落 retention.agentLogs.cleaned。
 * 仅匹配按日命名规范的 Agent 日志文件,其他文件不触碰。
 */

const AGENT_LOG_FILE_PATTERN = /^Agent-(\d{8})\.log$/

export interface AgentLogPruneResult {
  removed: number
  removedFiles: string[]
}

function isBeforeRetentionCutoff(fileName: string, cutoffDayKey: string): boolean {
  const match = AGENT_LOG_FILE_PATTERN.exec(fileName)
  if (!match) return false
  return match[1] < cutoffDayKey
}

export async function pruneAgentLogs(options: {
  logDir: string
  retentionDays: number
  now?: Date
}): Promise<AgentLogPruneResult> {
  const { logDir, retentionDays, now = new Date() } = options
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    return { removed: 0, removedFiles: [] }
  }
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - (retentionDays - 1))
  const cutoffDayKey = formatAgentLogDateKey(cutoff)

  const entries = await fs.readdir(logDir).catch(() => [])
  const removedFiles: string[] = []
  for (const fileName of entries) {
    if (!isBeforeRetentionCutoff(fileName, cutoffDayKey)) continue
    try {
      await fs.rm(path.join(logDir, fileName), { force: true })
      removedFiles.push(fileName)
    } catch {
      // 单文件删除失败不阻断清理;下次触发重试
    }
  }
  if (removedFiles.length > 0) {
    logAgentEvent('info', 'retention.agentLogs.cleaned', {
      strategy: 'retentionDays',
      retentionDays,
      cutoffDayKey,
      removed: removedFiles.length,
      removedFiles
    })
  }
  return { removed: removedFiles.length, removedFiles }
}
