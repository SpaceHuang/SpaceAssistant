import fs from 'fs/promises'
import path from 'path'
import type { Message, Session } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/domainTypes'

function sessionDirName(sessionId: string, createdAt: number): string {
  const dateStr = new Date(createdAt).toISOString().slice(0, 10).replace(/-/g, '')
  return `${sessionId}-${dateStr}`
}

export class SessionBackupManager {
  constructor(private readonly workDir: string) {}

  private sessionsRoot(): string {
    return path.join(this.workDir, 'sessions')
  }

  private dirFor(session: Session): string {
    return path.join(this.sessionsRoot(), sessionDirName(session.id, session.createdAt))
  }

  async backupSession(session: Session, messages: Message[]): Promise<void> {
    const sessionDir = this.dirFor(session)
    await fs.mkdir(sessionDir, { recursive: true })

    const sessionJsonPath = path.join(sessionDir, 'session.json')
    await fs.writeFile(sessionJsonPath, JSON.stringify({ ...session, schemaVersion: session.schemaVersion }, null, 2))

    const messagesExport = {
      sessionId: session.id,
      exportedAt: Date.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      messages
    }
    const messagesJsonPath = path.join(sessionDir, 'messages.json')
    await fs.writeFile(messagesJsonPath, JSON.stringify(messagesExport, null, 2))
  }

  async restoreSession(sessionId: string): Promise<{ session: Session; messages: Message[] } | null> {
    const dirs = await this.findSessionDirs(sessionId)
    if (dirs.length === 0) return null
    const latestDir = dirs[dirs.length - 1]!
    const sessionPath = path.join(latestDir, 'session.json')
    const messagesPath = path.join(latestDir, 'messages.json')
    const [sessionJson, messagesJson] = await Promise.all([
      fs.readFile(sessionPath, 'utf-8'),
      fs.readFile(messagesPath, 'utf-8')
    ])
    const session = JSON.parse(sessionJson) as Session
    const messagesExport = JSON.parse(messagesJson) as { messages: Message[] }
    return { session, messages: messagesExport.messages }
  }

  async deleteBackup(session: Session): Promise<void> {
    const dir = this.dirFor(session)
    await fs.rm(dir, { recursive: true, force: true })
  }

  private async findSessionDirs(sessionId: string): Promise<string[]> {
    const root = this.sessionsRoot()
    try {
      const dirs = await fs.readdir(root, { withFileTypes: true })
      return dirs
        .filter((d) => d.isDirectory() && d.name.startsWith(sessionId))
        .map((d) => path.join(root, d.name))
        .sort()
    } catch {
      return []
    }
  }
}
