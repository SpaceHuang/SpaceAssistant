import { randomBytes } from 'crypto'
import { getDefaultAgentRuntime } from '../runtime/agentRuntime'

/**
 * confirmId 一次性消费空间(A2,偏差 18):状态随 ConfirmIdSpace 实例走,
 * 一个进程可多实例并存(经 createAgentRuntime);旧全局函数为兼容转发。
 */

/** Crockford Base32 alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export class ConfirmIdSpace {
  private readonly ids = new Set<string>()

  allocate(maxAttempts = 32): string {
    for (let i = 0; i < maxAttempts; i++) {
      const buf = randomBytes(3)
      let id = ''
      // 4 chars from 20 bits
      let n = ((buf[0]! << 16) | (buf[1]! << 8) | buf[2]!) >>> 0
      for (let c = 0; c < 4; c++) {
        id = CROCKFORD[n & 31]! + id
        n >>>= 5
      }
      const upper = id.toUpperCase()
      if (!this.ids.has(upper)) {
        this.ids.add(upper)
        return upper
      }
    }
    throw new Error('confirmId collision exhausted')
  }

  release(id: string): void {
    this.ids.delete(id.toUpperCase())
  }

  isInUse(id: string): boolean {
    return this.ids.has(id.toUpperCase())
  }

  clear(): void {
    this.ids.clear()
  }
}

/** @deprecated 兼容转发(偏差 18,一个发布周期,P8 评估删除):经默认 runtime 的 confirmIds 实例。 */
export function allocateConfirmId(maxAttempts = 32): string {
  return getDefaultAgentRuntime().confirmIds.allocate(maxAttempts)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function releaseConfirmId(id: string): void {
  getDefaultAgentRuntime().confirmIds.release(id)
}

/** @deprecated 兼容转发(偏差 18)。 */
export function clearConfirmIdSpace(): void {
  getDefaultAgentRuntime().confirmIds.clear()
}

/** @deprecated 兼容转发(偏差 18)。 */
export function isConfirmIdInUse(id: string): boolean {
  return getDefaultAgentRuntime().confirmIds.isInUse(id)
}
