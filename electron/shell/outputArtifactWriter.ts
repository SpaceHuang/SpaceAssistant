import fs from 'fs/promises'
import { createHash, Hash } from 'crypto'
import path from 'path'

export class OutputArtifactWriter {
  private handle: fs.FileHandle | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private bytes = 0
  private readonly hash: Hash = createHash('sha256')
  private closedResult: { path: string; bytes: number; sha256: string } | undefined
  private closePromise: Promise<{ path: string; bytes: number; sha256: string }> | undefined
  private pending: Buffer[] = []
  private openPromise: Promise<void> | undefined

  constructor(private readonly filePath: string, private readonly maxBytes: number) {}

  async open(): Promise<void> {
    if (!this.openPromise) {
      this.openPromise = (async () => {
        if (this.handle) return
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        this.handle = await fs.open(this.filePath, 'w')
        const pending = this.pending
        this.pending = []
        for (const data of pending) {
          this.writeChain = this.writeChain.then(() => this.handle!.write(data).then(() => undefined))
        }
      })()
    }
    await this.openPromise
  }

  /** 原始字节直存（§9.2）：artifact 的字节数与 sha256 都以此为准。 */
  appendBytes(buf: Buffer): void {
    if (buf.length === 0 || this.bytes >= this.maxBytes) return
    const remaining = this.maxBytes - this.bytes
    const data = Buffer.from(buf.subarray(0, remaining))
    this.bytes += data.length
    this.hash.update(data)
    if (this.handle) {
      this.writeChain = this.writeChain.then(() => this.handle!.write(data).then(() => undefined))
    } else {
      this.pending.push(data)
    }
  }

  /** 文本路径（非原始字节）：仅供仍持有解码后文本的调用方使用。 */
  append(text: string): void {
    if (!text) return
    this.appendBytes(Buffer.from(text, 'utf8'))
  }

  async close(): Promise<{ path: string; bytes: number; sha256: string }> {
    if (this.closedResult) return this.closedResult
    if (!this.closePromise) {
      this.closePromise = (async () => {
        try {
          if (this.openPromise) await this.openPromise
          await this.writeChain
          this.closedResult = { path: this.filePath, bytes: this.bytes, sha256: this.hash.digest('hex') }
          return this.closedResult
        } finally {
          // 即使 queued write 失败，也必须关闭 fd；否则 executor 的 artifact close 异常会泄漏句柄。
          const handle = this.handle
          if (handle) await handle.close().catch(() => undefined)
          this.handle = undefined
        }
      })()
    }
    return this.closePromise
  }
}
