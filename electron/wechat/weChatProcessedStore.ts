import fs from 'fs/promises'
import path from 'path'
import { logWeChatCliEvent } from './weChatCliLogger'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

interface WeChatProcessedStoreData {
  entries: Array<{ messageId: string; processedAt: number }>
}

export class WeChatProcessedStore {
  private data: WeChatProcessedStoreData = { entries: [] }
  private filePath: string
  private loaded = false

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'wechat-processed-messages.json')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      this.data = JSON.parse(raw) as WeChatProcessedStoreData
    } catch {
      this.data = { entries: [] }
    }
    this.purgeExpired()
    this.loaded = true
  }

  purgeExpired(now = Date.now()): void {
    const cutoff = now - RETENTION_MS
    this.data.entries = this.data.entries.filter((e) => e.processedAt >= cutoff)
  }

  async has(messageId: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.data.entries.some((e) => e.messageId === messageId)
  }

  async mark(messageId: string, now = Date.now()): Promise<void> {
    await this.ensureLoaded()
    if (this.data.entries.some((e) => e.messageId === messageId)) return
    this.data.entries.push({ messageId, processedAt: now })
    this.purgeExpired(now)
    logWeChatCliEvent('info', 'wechat.processed.mark', { messageId })
    await this.save()
  }

  private async save(): Promise<void> {
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
