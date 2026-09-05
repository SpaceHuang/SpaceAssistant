import { createHash, randomUUID } from 'crypto'

export interface MemoryWritePermitSubject {
  invocationId: string
  requestId: string
  toolUseId: string
  sessionId: string
  planDigest: string
  factsDigest: string
  revision: string
}

export interface MemoryWritePermit {
  readonly permitId: string
  readonly subject: Readonly<MemoryWritePermitSubject>
  readonly expiresAt: number
}

export type PermitInvalidationReason =
  | 'cancelled'
  | 'timeout'
  | 'rejected'
  | 'settled'
  | 'stale'
  | 'replanned'

export interface MemoryWritePermitInput extends MemoryWritePermitSubject {
  ttlMs?: number
  now?: number
}

function digest(subject: MemoryWritePermitSubject): string {
  return createHash('sha256').update(JSON.stringify(subject, Object.keys(subject).sort())).digest('hex')
}

function cloneSubject(subject: MemoryWritePermitSubject): Readonly<MemoryWritePermitSubject> {
  return Object.freeze({ ...subject })
}

/**
 * 进程内的一次性确认记忆授权注册表。
 * permit 只代表“这一次确认允许写入”，不携带缓存 key，也不能被普通工具链路自行伪造。
 */
export class ConfirmationAuthorizationRegistry {
  private readonly permits = new Map<string, { permit: MemoryWritePermit; subjectDigest: string }>()

  issue(input: MemoryWritePermitInput): MemoryWritePermit {
    const now = input.now ?? Date.now()
    const ttlMs = Math.max(1, input.ttlMs ?? 5 * 60 * 1000)
    const { ttlMs: _ttl, now: _now, ...subject } = input
    const permit = Object.freeze({
      permitId: randomUUID(),
      subject: cloneSubject(subject),
      expiresAt: now + ttlMs
    })
    this.permits.set(permit.permitId, { permit, subjectDigest: digest(permit.subject) })
    return permit
  }

  invalidate(permitId: string, _reason: PermitInvalidationReason): void {
    this.permits.delete(permitId)
  }

  consume(
    permit: MemoryWritePermit,
    expected: MemoryWritePermitSubject,
    now = Date.now()
  ): MemoryWritePermitSubject {
    const record = this.permits.get(permit.permitId)
    if (!record) throw new Error('MEMORY_WRITE_PERMIT_INVALID')
    if (now >= record.permit.expiresAt) {
      this.permits.delete(permit.permitId)
      throw new Error('MEMORY_WRITE_PERMIT_EXPIRED')
    }
    if (record.subjectDigest !== digest(permit.subject) || digest(permit.subject) !== digest(expected)) {
      throw new Error('MEMORY_WRITE_PERMIT_MISMATCH')
    }
    this.permits.delete(permit.permitId)
    return { ...record.permit.subject }
  }

  size(): number {
    return this.permits.size
  }
}
