export interface BoundedOutputSnapshot {
  text: string
  bytes: number
  truncated: boolean
}

/**
 * 保留输出首段和尾段，避免执行期间按完整输出增长内存。
 * `limitBytes` 是 UTF-8 字节上限；返回文本可能略少于上限，但不会超过它。
 */
export class BoundedOutputBuffer {
  private readonly head: Buffer[] = []
  private readonly tail: Buffer[] = []
  private headBytes = 0
  private tailBytes = 0
  private totalBytes = 0
  private didTruncate = false

  constructor(
    private readonly limitBytes: number,
    private readonly tailBytesLimit = Math.floor(limitBytes / 2)
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error('limitBytes must be positive')
    if (!Number.isSafeInteger(tailBytesLimit) || tailBytesLimit < 0 || tailBytesLimit > limitBytes) {
      throw new Error('tailBytesLimit must be within limitBytes')
    }
  }

  append(chunk: string | Buffer): void {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, 'utf8')
    this.totalBytes += bytes.length
    if (this.headBytes + bytes.length <= this.limitBytes && !this.didTruncate) {
      this.head.push(bytes)
      this.headBytes += bytes.length
      return
    }

    this.didTruncate = true
    const tail = Buffer.concat([...this.tail, bytes])
    const kept = tail.subarray(Math.max(0, tail.length - this.tailBytesLimit))
    this.tail.length = 0
    if (kept.length) this.tail.push(Buffer.from(kept))
    this.tailBytes = kept.length
  }

  snapshot(): BoundedOutputSnapshot {
    const allHead = Buffer.concat(this.head)
    const tail = Buffer.concat(this.tail)
    const marker = this.didTruncate && allHead.length && tail.length ? Buffer.from('\n[… output truncated …]\n') : Buffer.alloc(0)
    const separator = marker.length + tail.length < this.limitBytes ? marker : Buffer.alloc(0)
    const headLimit = this.didTruncate ? Math.max(0, this.limitBytes - separator.length - tail.length) : this.limitBytes
    const head = allHead.subarray(0, headLimit)
    const content = Buffer.concat([head, separator, tail]).subarray(0, this.limitBytes)
    return { text: content.toString('utf8'), bytes: this.totalBytes, truncated: this.didTruncate }
  }
}
