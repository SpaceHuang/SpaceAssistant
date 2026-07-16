import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Message, Session } from '../src/shared/domainTypes'
import { CURRENT_SCHEMA_VERSION } from '../src/shared/domainTypes'
import { writeAllBytes } from './safeAtomicWrite'

export interface MessagesPage {
  messages: Message[]
  /** 下一页应从此游标（含）开始读取；页为空时等于传入的 fromCursor，供调用方判定翻页结束 */
  nextSequence: number
}

/**
 * 按游标分页读取消息；游标语义由调用方决定（DB 场景为 sequence，内存数组场景为已消费条数），
 * 但两者均以 0 为起始游标、以「下一页起始游标」为续读位置，因此可互换使用。
 */
export type MessagePageReader = (
  fromCursor: number,
  pageSize: number
) => Promise<MessagesPage> | MessagesPage

export const DEFAULT_BACKUP_PAGE_SIZE = 2000

/** 将一次性加载好的消息数组包装为分页读取器，供空会话/测试等无需真实分页的场景使用 */
export function arrayMessagePageReader(messages: Message[]): MessagePageReader {
  return (fromCursor, pageSize) => {
    const page = messages.slice(fromCursor, fromCursor + pageSize)
    return { messages: page, nextSequence: fromCursor + page.length }
  }
}

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

  /**
   * 分页读取消息并以流式方式写出 `messages.json`（边读边写，不在内存中累积全量 Message[]）。
   * 任一页读取或写入失败都会删除临时文件并向上抛出，保证既有 `messages.json` 不被替换为不完整内容。
   */
  async backupSession(
    session: Session,
    readPage: MessagePageReader,
    pageSize: number = DEFAULT_BACKUP_PAGE_SIZE
  ): Promise<void> {
    const sessionDir = this.dirFor(session)
    await fs.mkdir(sessionDir, { recursive: true })

    const sessionJsonPath = path.join(sessionDir, 'session.json')
    await fs.writeFile(
      sessionJsonPath,
      JSON.stringify({ ...session, schemaVersion: session.schemaVersion }, null, 2)
    )

    const messagesJsonPath = path.join(sessionDir, 'messages.json')
    await this.streamMessagesJsonAtomic(messagesJsonPath, session.id, readPage, pageSize)
  }

  /** 临时文件 + 完整写入循环 + fsync + 原子 rename；任一步失败都清理临时文件并保留旧备份 */
  private async streamMessagesJsonAtomic(
    finalPath: string,
    sessionId: string,
    readPage: MessagePageReader,
    pageSize: number
  ): Promise<void> {
    const dir = path.dirname(finalPath)
    const tempPath = path.join(dir, `.messages-${randomUUID()}.tmp.json`)

    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(tempPath, 'wx')
      await writeAllBytes(
        handle,
        `{"sessionId":${JSON.stringify(sessionId)},"exportedAt":${Date.now()},"schemaVersion":${CURRENT_SCHEMA_VERSION},"messages":[`
      )

      let cursor = 0
      let written = 0
      for (;;) {
        const page = await readPage(cursor, pageSize)
        if (page.messages.length === 0) break
        for (const message of page.messages) {
          const chunk = (written === 0 ? '' : ',') + JSON.stringify(message)
          await writeAllBytes(handle, chunk)
          written += 1
        }
        cursor = page.nextSequence
      }

      await writeAllBytes(handle, ']}')
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(tempPath, finalPath)
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {})
      }
      await fs.rm(tempPath, { force: true }).catch(() => {})
      throw err
    }
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
