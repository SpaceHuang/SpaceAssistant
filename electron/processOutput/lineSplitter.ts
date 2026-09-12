import type { DecodedStreamMeta } from '../../src/shared/outputEncoding'
import { createChildStreamDecoder, type CreateChildStreamDecoderOptions } from './decodeChildOutput'

export interface LineSplitter {
  write(chunk: Buffer): string[]
  end(): string[]
  readonly meta: DecodedStreamMeta
  readonly rawBytes: number
}

/**
 * 基于流式解码器的「按行切分」（§10.1），供 MCP stderr、lark 事件流等行协议复用。
 * 取代各处 `buffer += chunk.toString('utf8')`：跨 chunk 的多字节字符不会被打断。
 */
export function createLineSplitter(options: CreateChildStreamDecoderOptions): LineSplitter {
  const decoder = createChildStreamDecoder(options)
  let buffer = ''

  const drain = (): string[] => {
    if (buffer.length === 0) return []
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  }

  return {
    write(chunk: Buffer): string[] {
      buffer += decoder.write(chunk)
      return drain()
    },
    end(): string[] {
      buffer += decoder.end()
      const lines = drain()
      if (buffer.length > 0) {
        lines.push(buffer)
        buffer = ''
      }
      return lines
    },
    get meta(): DecodedStreamMeta {
      return decoder.meta
    },
    get rawBytes(): number {
      return decoder.rawBytes
    }
  }
}
