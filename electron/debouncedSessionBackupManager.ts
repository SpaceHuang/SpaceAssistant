import type { Session } from '../src/shared/domainTypes'
import { arrayMessagePageReader, type MessagePageReader, type SessionBackupManager } from './sessionBackupManager'

/** 与流式 patch 对齐的备份防抖间隔（毫秒） */
export const SESSION_BACKUP_DEBOUNCE_MS = 3000

export type SessionBackupSource = { session: Session; readPage: MessagePageReader }

export class DebouncedSessionBackupManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pending = new Set<string>()

  constructor(private readonly inner: SessionBackupManager) {}

  async backupImmediate(session: Session, readPage: MessagePageReader): Promise<void> {
    this.cancel(session.id)
    await this.inner.backupSession(session, readPage)
  }

  schedule(
    sessionId: string,
    loadSessionAndMessages: () => Promise<SessionBackupSource | null>
  ): void {
    this.pending.add(sessionId)
    const existing = this.timers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      if (!this.pending.has(sessionId)) return
      this.pending.delete(sessionId)
      void loadSessionAndMessages().then((data) => {
        if (!data) return
        return this.inner.backupSession(data.session, data.readPage)
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
    await this.inner.backupSession(data.session, data.readPage)
  }

  async flushAll(
    sessionIds: string[],
    loadSessionAndMessages: (sessionId: string) => Promise<SessionBackupSource | null>
  ): Promise<void> {
    await Promise.all(sessionIds.map((id) => this.flush(id, () => loadSessionAndMessages(id))))
  }

  cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.timers.delete(sessionId)
    this.pending.delete(sessionId)
  }

  async deleteBackup(session: Session): Promise<void> {
    this.cancel(session.id)
    await this.inner.deleteBackup(session)
  }
}

export { arrayMessagePageReader }
