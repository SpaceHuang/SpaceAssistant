import type { Message, Session } from '../src/shared/domainTypes'
import { SessionBackupManager } from './sessionBackupManager'

/** 与流式 patch 对齐的备份防抖间隔（毫秒） */
export const SESSION_BACKUP_DEBOUNCE_MS = 3000

export class DebouncedSessionBackupManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pending = new Set<string>()

  constructor(private readonly inner: SessionBackupManager) {}

  async backupImmediate(session: Session, messages: Message[]): Promise<void> {
    this.cancel(session.id)
    await this.inner.backupSession(session, messages)
  }

  schedule(
    sessionId: string,
    loadSessionAndMessages: () => Promise<{ session: Session; messages: Message[] } | null>
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
        return this.inner.backupSession(data.session, data.messages)
      })
    }, SESSION_BACKUP_DEBOUNCE_MS)
    this.timers.set(sessionId, timer)
  }

  async flush(
    sessionId: string,
    loadSessionAndMessages: () => Promise<{ session: Session; messages: Message[] } | null>
  ): Promise<void> {
    const timer = this.timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
    }
    this.pending.delete(sessionId)
    const data = await loadSessionAndMessages()
    if (!data) return
    await this.inner.backupSession(data.session, data.messages)
  }

  async flushAll(
    sessionIds: string[],
    loadSessionAndMessages: (sessionId: string) => Promise<{ session: Session; messages: Message[] } | null>
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
