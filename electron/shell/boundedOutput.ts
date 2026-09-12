export interface RawByteSnapshot {
  /** 前 headLimitBytes 个原始字节 */
  head: Buffer
  /** 后 tailLimitBytes 个原始字节（与 head 不相交） */
  tail: Buffer
  /** 该流的总原始字节数（含被省略的） */
  totalBytes: number
  /** head + tail 的字节数 */
  retainedBytes: number
  /** 被省略的字节数（截断窗口之间） */
  omittedBytes: number
  truncated: boolean
}

/** 文本投影中的截断标记：纯 ASCII，在任何候选编码下解码一致，不会污染判定。 */
export const TRUNCATION_MARKER = '\n[… output truncated …]\n'

/**
 * 原始字节 head/tail 环形缓冲（§9.2/§9.3）。
 *
 * 只保存「事实」（原始字节）：字节数、截断、artifact 一律以它为准；
 * 文本是「投影」，由快照 + 锁定编码解码得到，不再参与截断计算。
 */
export class RawByteBuffer {
  private readonly headChunks: Buffer[] = []
  private readonly tailChunks: Buffer[] = []
  private headBytes = 0
  private tailBytes = 0
  private totalBytesWritten = 0
  private didTruncate = false

  constructor(
    private readonly headLimitBytes: number,
    private readonly tailLimitBytes: number = Math.floor(headLimitBytes / 2)
  ) {
    if (!Number.isSafeInteger(headLimitBytes) || headLimitBytes <= 0) {
      throw new Error('headLimitBytes must be positive')
    }
    if (!Number.isSafeInteger(tailLimitBytes) || tailLimitBytes < 0 || tailLimitBytes > headLimitBytes) {
      throw new Error('tailLimitBytes must be within headLimitBytes')
    }
  }

  /** 累计写入的原始字节数（不构造快照、不拷贝），用于逐 chunk 的上限判定。 */
  get totalBytes(): number {
    return this.totalBytesWritten
  }

  appendBytes(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.totalBytesWritten += chunk.length
    let offset = 0
    if (this.headBytes < this.headLimitBytes) {
      const take = Math.min(this.headLimitBytes - this.headBytes, chunk.length)
      this.headChunks.push(Buffer.from(chunk.subarray(0, take)))
      this.headBytes += take
      offset = take
      if (offset >= chunk.length) return
      this.didTruncate = true
    } else {
      this.didTruncate = true
    }
    if (this.tailLimitBytes === 0) return
    const rest = chunk.subarray(offset)
    this.tailChunks.push(Buffer.from(rest))
    this.tailBytes += rest.length
    let excess = this.tailBytes - this.tailLimitBytes
    while (excess > 0) {
      const first = this.tailChunks[0]
      if (first === undefined) break
      if (first.length <= excess) {
        this.tailChunks.shift()
        this.tailBytes -= first.length
        excess -= first.length
      } else {
        this.tailChunks[0] = Buffer.from(first.subarray(excess))
        this.tailBytes -= excess
        excess = 0
      }
    }
  }

  snapshotBytes(): RawByteSnapshot {
    const head = Buffer.concat(this.headChunks)
    const tail = Buffer.concat(this.tailChunks)
    const retainedBytes = head.length + tail.length
    const omittedBytes = Math.max(0, this.totalBytesWritten - retainedBytes)
    return {
      head,
      tail,
      totalBytes: this.totalBytesWritten,
      retainedBytes,
      omittedBytes,
      truncated: omittedBytes > 0 || this.didTruncate
    }
  }
}

/** §9.2 命名：BoundedOutputBuffer 现在只处理原始字节（appendBytes / snapshotBytes）。 */
export class BoundedOutputBuffer extends RawByteBuffer {}

/** head + tail 连续时（未省略任何字节）可直接拼接成完整流。 */
export function rawSnapshotBuffer(snapshot: RawByteSnapshot): Buffer | undefined {
  if (snapshot.omittedBytes > 0) return undefined
  if (snapshot.tail.length === 0) return snapshot.head
  return Buffer.concat([snapshot.head, snapshot.tail])
}
