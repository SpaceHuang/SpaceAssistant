import type { Session } from '../src/shared/domainTypes'
import { arrayMessagePageReader, type MessagePageReader, type SessionBackupManager } from './sessionBackupManager'

/** 与流式 patch 对齐的备份防抖间隔（毫秒） */
export const SESSION_BACKUP_DEBOUNCE_MS = 3000

export type SessionBackupSource = { session: Session; readPage: MessagePageReader }

export class DebouncedSessionBackupManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pending = new Set<string>()
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly generations = new Map<string, number>()
  private readonly inFlightBackups = new Map<string, Promise<void>>()
  /** 同一会话的写入与删除必须共用一条链，避免 rename 在 rm 之后重新创建目录。 */
  private readonly operationChains = new Map<string, Promise<void>>()

  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operationChains.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.operationChains.set(sessionId, current)
    void current.then(() => {
      if (this.operationChains.get(sessionId) === current) this.operationChains.delete(sessionId)
    }, () => {
      if (this.operationChains.get(sessionId) === current) this.operationChains.delete(sessionId)
    })
    return current
  }

  constructor(private readonly inner: SessionBackupManager) {}

  async backupImmediate(session: Session, readPage: MessagePageReader): Promise<void> {
    await this.enqueue(session.id, () => this.inner.backupSession(session, readPage))
  }

  async backupWithRetry(session: Session, readPage: MessagePageReader, attempts = 3): Promise<void> {
    const operation = this.enqueue(session.id, () => this.runBackupWithRetry(session, readPage, attempts))
    this.inFlightBackups.set(session.id, operation)
    try { await operation } finally {
      if (this.inFlightBackups.get(session.id) === operation) this.inFlightBackups.delete(session.id)
    }
  }

  private async runBackupWithRetry(session: Session, readPage: MessagePageReader, attempts: number): Promise<void> {
    let lastError: unknown
    const generation = this.generations.get(session.id) ?? 0
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if ((this.generations.get(session.id) ?? 0) !== generation) return
      try {
        await this.inner.backupSession(session, readPage)
        return
      } catch (error) {
        lastError = error
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw lastError
  }

  schedule(
    sessionId: string,
    loadSessionAndMessages: () => Promise<SessionBackupSource | null>
  ): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    this.pending.add(sessionId)
    const existing = this.timers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      if (!this.pending.has(sessionId)) return
      this.pending.delete(sessionId)
      void loadSessionAndMessages().then((data) => {
        if (!data) return
        return this.enqueue(sessionId, () => this.inner.backupSession(data.session, data.readPage))
      })
    }, SESSION_BACKUP_DEBOUNCE_MS)
    this.timers.set(sessionId, timer)
  }

  async flush(
    sessionId: string,
    loadSessionAndMessages: () => Promise<SessionBackupSource | null>
  ): Promise<void> {
    const timer = this.timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
    }
    this.pending.delete(sessionId)
    const data = await loadSessionAndMessages()
    if (!data) return
    await this.enqueue(sessionId, () => this.inner.backupSession(data.session, data.readPage))
  }

  async flushAll(
    sessionIds: string[],
    loadSessionAndMessages: (sessionId: string) => Promise<SessionBackupSource | null>
  ): Promise<void> {
    await Promise.all(sessionIds.map((id) => this.flush(id, () => loadSessionAndMessages(id))))
  }

  cancel(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    const timer = this.timers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.timers.delete(sessionId)
    this.pending.delete(sessionId)
  }

  async deleteBackup(session: Session): Promise<void> {
    this.cancel(session.id)
    const cleanupTimer = this.cleanupTimers.get(session.id)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    this.cleanupTimers.delete(session.id)
    await this.inner.deleteBackup(session)
  }

  cleanupOrphanedBackups(activeSessionIds: ReadonlySet<string>): Promise<number> {
    return this.inner.cleanupOrphanedBackups(activeSessionIds)
  }

  deleteBackupWithRetry(session: Session, attempts = 3, onError?: (error: unknown) => void): void {
    this.generations.set(session.id, (this.generations.get(session.id) ?? 0) + 1)
    this.cancel(session.id)
    const run = async (attempt: number): Promise<void> => {
      try {
        await this.inFlightBackups.get(session.id)
        await this.enqueue(session.id, () => this.inner.deleteBackup(session))
        this.cleanupTimers.delete(session.id)
      } catch (error) {
        if (attempt >= attempts) {
          this.cleanupTimers.delete(session.id)
          onError?.(error)
          return
        }
        const timer = setTimeout(() => {
          this.cleanupTimers.delete(session.id)
          void run(attempt + 1)
        }, 250 * attempt)
        this.cleanupTimers.set(session.id, timer)
      }
    }
    void run(1)
  }
}

export { arrayMessagePageReader }
