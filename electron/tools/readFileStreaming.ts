import fs from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { sliceFileLines, sliceFileTailLines } from '../../src/shared/readFileRange'
import { READ_FILE_MAX_CHARS, READ_FILE_MAX_LINE_LIMIT } from '../../src/shared/toolResultLimits'

/** Tail 分块读取大小 */
export const READ_FILE_TAIL_CHUNK_BYTES = 64 * 1024

/** 小于等于该字节数时可用一次读入 + 纯函数切片 */
export const READ_FILE_SMALL_FILE_BYTES = READ_FILE_MAX_CHARS

export function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export type TailReadResult = {
  content: string
  linesReturned: number
  hasMoreBefore: boolean
  /** 因扫描/字符上限截去窗口前部 */
  truncated: boolean
}

export type RangeReadResult = {
  content: string
  startLine: number
  endLine: number
  hasMore: boolean
  totalLines?: number
  /** 窗口文本因字符上限被截断 */
  truncated: boolean
}

async function readBinaryProbe(absPath: string, signal?: AbortSignal): Promise<boolean> {
  const fh = await fs.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(Math.min(8000, READ_FILE_TAIL_CHUNK_BYTES))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    if (signal?.aborted) throw new Error('aborted')
    return isBinaryBuffer(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}

/**
 * 从文件末尾分块读取，凑满 tail 行后按正序返回。
 * 内存有界：反向扫描字节数不超过 READ_FILE_MAX_CHARS，禁止整文件载入。
 */
export async function readFileTailFromDisk(
  absPath: string,
  tail: number,
  opts?: { signal?: AbortSignal; chunkBytes?: number; fileSize?: number }
): Promise<TailReadResult> {
  const n = Math.max(1, Math.floor(tail))
  const chunkBytes = opts?.chunkBytes ?? READ_FILE_TAIL_CHUNK_BYTES
  const stSize = opts?.fileSize ?? (await fs.stat(absPath)).size
  if (stSize === 0) {
    return { content: '', linesReturned: 0, hasMoreBefore: false, truncated: false }
  }

  if (stSize <= READ_FILE_SMALL_FILE_BYTES) {
    const buf = await fs.readFile(absPath, { signal: opts?.signal })
    if (isBinaryBuffer(buf)) throw new Error('BINARY')
    const sliced = sliceFileTailLines(buf.toString('utf8'), n)
    return {
      content: sliced.content,
      linesReturned: sliced.linesReturned,
      hasMoreBefore: sliced.hasMoreBefore,
      truncated: false
    }
  }

  if (await readBinaryProbe(absPath, opts?.signal)) throw new Error('BINARY')

  const fh = await fs.open(absPath, 'r')
  try {
    return await readTailChunks(fh, stSize, n, chunkBytes, opts?.signal)
  } finally {
    await fh.close()
  }
}

/**
 * 反向按块收集原始字节并统计换行（0x0A），凑满 tail 行或达到扫描上限即停。
 * 全程只做一次 UTF-8 解码，避免 carry 反复 decode/re-encode 的 O(n²)。
 */
async function readTailChunks(
  fh: FileHandle,
  fileSize: number,
  tail: number,
  chunkBytes: number,
  signal?: AbortSignal
): Promise<TailReadResult> {
  const scanByteCap = READ_FILE_MAX_CHARS // UTF-8 下字符数 ≤ 字节数，天然满足字符上限
  let pos = fileSize
  let scanned = 0
  let newlines = 0
  let capped = false
  const chunksReversed: Buffer[] = []

  while (pos > 0) {
    if (signal?.aborted) throw new Error('aborted')
    const remainingCap = scanByteCap - scanned
    if (remainingCap <= 0) {
      capped = true
      break
    }
    const size = Math.min(chunkBytes, pos, remainingCap)
    pos -= size
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fh.read(buf, 0, size, pos)
    const view = buf.subarray(0, bytesRead)
    chunksReversed.push(view)
    scanned += bytesRead
    for (let i = 0; i < view.length; i++) {
      if (view[i] === 0x0a) newlines += 1
    }
    // tail+1 个换行保证至少 tail 个完整行边界
    if (newlines > tail) break
  }

  const reachedHead = pos === 0
  const text = Buffer.concat(chunksReversed.reverse()).toString('utf8')
  const sliced = sliceFileTailLines(text, tail)
  // capped 且窗口内行数未超出 tail 时，窗口前部被扫描上限截去
  const truncated = capped && !sliced.hasMoreBefore
  return {
    content: sliced.content,
    linesReturned: sliced.linesReturned,
    hasMoreBefore: !reachedHead || sliced.hasMoreBefore,
    truncated
  }
}

/**
 * 按行窗口读取：小文件一次读入；大文件流式跳过至 offset 再读 limit 行。
 * 大文件省略 limit 时按 READ_FILE_MAX_LINE_LIMIT 封顶；累计字符达上限即早停。
 */
export async function readFileRangeFromDisk(
  absPath: string,
  offset: number,
  limit: number | undefined,
  opts?: { signal?: AbortSignal; fileSize?: number }
): Promise<RangeReadResult> {
  const startLine = Math.max(1, Math.floor(offset))
  const stSize = opts?.fileSize ?? (await fs.stat(absPath)).size
  // 大/小文件统一：省略 limit 时按 READ_FILE_MAX_LINE_LIMIT 封顶
  const effectiveLimit = limit !== undefined ? Math.max(1, Math.floor(limit)) : READ_FILE_MAX_LINE_LIMIT

  if (stSize <= READ_FILE_SMALL_FILE_BYTES) {
    const buf = await fs.readFile(absPath, { signal: opts?.signal })
    if (isBinaryBuffer(buf)) throw new Error('BINARY')
    const sliced = sliceFileLines(buf.toString('utf8'), { offset: startLine, limit: effectiveLimit })
    return {
      content: sliced.content,
      startLine: sliced.startLine,
      endLine: sliced.endLine,
      hasMore: sliced.hasMore,
      totalLines: sliced.totalLines,
      truncated: false
    }
  }

  if (await readBinaryProbe(absPath, opts?.signal)) throw new Error('BINARY')

  const fh = await fs.open(absPath, 'r')
  try {
    return await streamLineRange(fh, stSize, startLine, effectiveLimit, opts?.signal)
  } finally {
    await fh.close()
  }
}

async function streamLineRange(
  fh: FileHandle,
  fileSize: number,
  startLine: number,
  maxLines: number,
  signal?: AbortSignal
): Promise<RangeReadResult> {
  let pos = 0
  let lineNo = 0
  /** 当前未完成行的正文（不含行尾符） */
  let carry = ''
  /** 上一块以孤立 `\r` 结尾，等待下一块判断是否组成 `\r\n` */
  let pendingCr = false
  const collected: string[] = []
  let collectedChars = 0
  let truncated = false
  let hasMore = false
  let stop = false
  let outEol: '\r\n' | '\n' = '\n'
  let eolDetected = false
  const chunkBuf = Buffer.alloc(READ_FILE_TAIL_CHUNK_BYTES)
  // 跨块保留不完整 UTF-8 字节序列，避免多字节字符被解码成 U+FFFD
  const decoder = new StringDecoder('utf8')

  /** 返回 false 表示窗口已满或触及字符上限，应停止读取 */
  const pushLine = (line: string): boolean => {
    if (collected.length >= maxLines) {
      hasMore = true
      return false
    }
    const sepLen = collected.length > 0 ? outEol.length : 0
    if (collectedChars + sepLen + line.length > READ_FILE_MAX_CHARS) {
      const remain = READ_FILE_MAX_CHARS - collectedChars - sepLen
      if (remain > 0) {
        collected.push(line.slice(0, remain))
        collectedChars += sepLen + remain
      }
      truncated = true
      hasMore = true
      return false
    }
    collected.push(line)
    collectedChars += sepLen + line.length
    return true
  }

  const emitLine = (line: string): void => {
    lineNo += 1
    if (lineNo < startLine || stop) return
    if (!pushLine(line)) stop = true
  }

  /**
   * 逐字符解析行结束符。块尾孤立的 `\r` 不立即当成换行，留给下一块判断 CRLF。
   * @param isFinal 文件已读完：此时孤立 `\r` 视为独立换行
   */
  const consumeText = (text: string, isFinal: boolean): void => {
    if (!text && !pendingCr) return

    let s = text
    let idx = 0
    if (pendingCr) {
      pendingCr = false
      if (s.startsWith('\n')) {
        if (!eolDetected) {
          outEol = '\r\n'
          eolDetected = true
        }
        emitLine(carry)
        carry = ''
        idx = 1
      } else {
        // 裸 `\r` 换行（旧 Mac）
        if (!eolDetected) {
          outEol = '\n'
          eolDetected = true
        }
        emitLine(carry)
        carry = ''
      }
    }

    s = carry + s.slice(idx)
    carry = ''
    let start = 0
    for (let i = 0; i < s.length && !stop; i++) {
      const ch = s[i]!
      if (ch === '\r') {
        if (i + 1 < s.length) {
          if (s[i + 1] === '\n') {
            if (!eolDetected) {
              outEol = '\r\n'
              eolDetected = true
            }
            emitLine(s.slice(start, i))
            i += 1
            start = i + 1
          } else {
            if (!eolDetected) {
              outEol = '\n'
              eolDetected = true
            }
            emitLine(s.slice(start, i))
            start = i + 1
          }
        } else if (!isFinal) {
          // 块尾孤立 `\r`：正文进 carry，等下一块
          carry = s.slice(start, i)
          pendingCr = true
          return
        } else {
          if (!eolDetected) {
            outEol = '\n'
            eolDetected = true
          }
          emitLine(s.slice(start, i))
          start = i + 1
        }
      } else if (ch === '\n') {
        if (!eolDetected) {
          outEol = '\n'
          eolDetected = true
        }
        emitLine(s.slice(start, i))
        start = i + 1
      }
    }

    if (stop) return
    carry = s.slice(start)

    if (carry.length > READ_FILE_MAX_CHARS) {
      if (lineNo + 1 < startLine) {
        // 窗口前的超长行：丢弃正文，换行到来时仍正确计数
        carry = ''
        pendingCr = false
      } else {
        emitLine(carry)
        carry = ''
        pendingCr = false
        stop = true
      }
    }
  }

  while (pos < fileSize && !stop) {
    if (signal?.aborted) throw new Error('aborted')
    const toRead = Math.min(chunkBuf.length, fileSize - pos)
    const { bytesRead } = await fh.read(chunkBuf, 0, toRead, pos)
    pos += bytesRead
    consumeText(decoder.write(chunkBuf.subarray(0, bytesRead)), false)
  }

  if (!stop) {
    consumeText(decoder.end(), true)
    if (pendingCr) {
      // 文件以孤立 `\r` 结尾
      if (!eolDetected) {
        outEol = '\n'
        eolDetected = true
      }
      emitLine(carry)
      carry = ''
      pendingCr = false
    } else if (carry.length > 0) {
      emitLine(carry)
      carry = ''
    }
  } else {
    decoder.end()
  }

  if (collected.length === 0) {
    return {
      content: '',
      startLine,
      endLine: Math.max(startLine - 1, 0),
      hasMore: false,
      truncated
    }
  }

  return {
    content: collected.join(outEol),
    startLine,
    endLine: startLine + collected.length - 1,
    hasMore,
    truncated
  }
}

/** 对已选定窗口做字符上限截断；Tail 截断前部时 hasMoreBefore 须为 true */
export function applyReadCharLimit(
  content: string,
  opts: { isTail?: boolean; hasMoreBefore?: boolean }
): { content: string; truncated: boolean; hasMoreBefore: boolean } {
  if (content.length <= READ_FILE_MAX_CHARS) {
    return {
      content,
      truncated: false,
      hasMoreBefore: opts.hasMoreBefore ?? false
    }
  }
  if (opts.isTail) {
    // Tail 保留窗口尾部（最新内容）
    return {
      content: content.slice(content.length - READ_FILE_MAX_CHARS),
      truncated: true,
      hasMoreBefore: true
    }
  }
  return {
    content: content.slice(0, READ_FILE_MAX_CHARS),
    truncated: true,
    hasMoreBefore: opts.hasMoreBefore ?? false
  }
}
