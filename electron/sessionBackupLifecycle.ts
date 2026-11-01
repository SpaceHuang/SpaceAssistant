import type { Session } from '../src/shared/domainTypes'
import type { MessagePageReader, SessionBackupManager } from './sessionBackupManager'

/** Coordinates explicitly requested writes with the session deletion cleanup. */
export class SessionBackupLifecycle {
  private readonly operationChains = new Map<string, Promise<void>>()
  private readonly inFlightBackups = new Map<string, Promise<void>>()

  constructor(private readonly inner: SessionBackupManager) {}

  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operationChains.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.operationChains.set(sessionId, current)
    void current.then(() => {
      if (this.operationChains.get(sessionId) === current) this.operationChains.delete(sessionId)
    }, () => {
      if (this.operationChains.get(sessionId) === current) this.operationChains.delete(sessionId)
    })
    return current
  }

  /** Bottom-level explicit export capability. No application lifecycle calls it automatically. */
  async backupImmediate(session: Session, readPage: MessagePageReader): Promise<void> {
    const operation = this.enqueue(session.id, () => this.inner.backupSession(session, readPage))
    this.inFlightBackups.set(session.id, operation)
    try {
      await operation
    } finally {
      if (this.inFlightBackups.get(session.id) === operation) this.inFlightBackups.delete(session.id)
    }
  }

  async deleteBackup(session: Session): Promise<void> {
    await this.inFlightBackups.get(session.id)
    await this.enqueue(session.id, () => this.inner.deleteBackup(session))
  }

  deleteBackupWithRetry(session: Session, attempts = 3, onError?: (error: unknown) => void): void {
    const run = async (attempt: number): Promise<void> => {
      try {
        await this.deleteBackup(session)
      } catch (error) {
        if (attempt >= attempts) {
          onError?.(error)
          return
        }
        setTimeout(() => { void run(attempt + 1) }, 250 * attempt)
      }
    }
    void run(1)
  }
}
