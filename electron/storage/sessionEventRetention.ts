import fs from 'fs/promises'
import path from 'node:path'
import { logAgentEvent } from '../agentLogger/agentLogger'
import type { SessionRecoveryFailure } from '../sessionEvents'
import { resolveRetentionPolicyFromDb, type RetentionPolicy } from './retentionPolicy'
import type { AppDatabase } from '../database'

/**
 * 会话事件台账保留期(S3,偏差 24):自 sessionEvents.ts(Core 文件)归位 Storage。
 * - 保留语义:台账目录(sessions/)最多保留 maxSessions 个(按 events.index.json 的 lastAt 保留最新);
 * - 策略参数经 storage/retentionPolicy.ts 解析(可配、显式默认),调用方只触发、不持参数;
 * - 删除留痕:removed > 0 时落 retention.sessionEvents.cleaned(删了什么、多少个、依据哪条策略)。
 */

export type SessionRetentionSummary = { removed: number; failures: SessionRecoveryFailure[] }

export async function enforceSessionEventRetention(workDir: string, maxSessions: number): Promise<number> {
  return (await enforceSessionEventRetentionDetailed(workDir, maxSessions)).removed
}

export async function enforceSessionEventRetentionDetailed(workDir: string, maxSessions: number): Promise<SessionRetentionSummary> {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('maxSessions must be positive')
  const root = path.join(workDir, 'sessions')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates: Array<{ name: string; lastAt: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const index = JSON.parse(await fs.readFile(path.join(root, entry.name, 'events.index.json'), 'utf8')) as { lastAt?: number }
      candidates.push({ name: entry.name, lastAt: typeof index.lastAt === 'number' ? index.lastAt : 0 })
    } catch { /* no event stream, leave ordinary backups untouched */ }
  }
  candidates.sort((a, b) => b.lastAt - a.lastAt)
  const removed = candidates.slice(maxSessions)
  const failures: SessionRecoveryFailure[] = []
  const removedSessions: string[] = []
  let count = 0
  for (const entry of removed) {
    try {
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true })
      count += 1
      removedSessions.push(entry.name)
    } catch (error) {
      failures.push({ sessionName: entry.name, phase: 'retention-delete', error, jsonlCommitted: false })
    }
  }
  if (count > 0) {
    logAgentEvent('info', 'retention.sessionEvents.cleaned', {
      strategy: 'maxSessions',
      maxSessions,
      removed: count,
      removedSessions
    })
  }
  return { removed: count, failures }
}

/**
 * 启动维护入口(S3,偏差 24):解析统一保留策略并执行台账保留清理。
 * 调用方(main.ts 启动流程)只触发——不持策略参数、不直接依赖 enforce 实现符号,
 * 策略参数从本模块(Storage)持有并解析。
 */
export async function runSessionEventRetentionMaintenance(db: AppDatabase, workDir: string): Promise<{
  policy: RetentionPolicy
  summary: SessionRetentionSummary
}> {
  const policy = resolveRetentionPolicyFromDb(db)
  const summary = await enforceSessionEventRetentionDetailed(workDir, policy.sessionEventMaxSessions)
  return { policy, summary }
}
