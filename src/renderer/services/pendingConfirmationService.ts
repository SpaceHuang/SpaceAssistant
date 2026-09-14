import type { ConfirmationSnapshot } from '../../shared/turnDisplayProtocol'

export type ConfirmationKey = Pick<ConfirmationSnapshot, 'sessionId' | 'turnId' | 'requestId' | 'turnVersion' | 'toolCallId'>
export type ConfirmationState = { status: 'absent' } | { status: 'loading'; key: ConfirmationKey } | { status: 'ready'; snapshot: ConfirmationSnapshot } | { status: 'error'; key: ConfirmationKey; error: unknown }

const sameKey = (a: ConfirmationKey, b: ConfirmationKey): boolean => a.sessionId === b.sessionId && a.turnId === b.turnId && a.requestId === b.requestId && a.turnVersion === b.turnVersion && a.toolCallId === b.toolCallId

export class PendingConfirmationService {
  private state: ConfirmationState = { status: 'absent' }
  private inFlight?: { key: ConfirmationKey; promise: Promise<void> }
  constructor(private readonly read: (key: ConfirmationKey) => Promise<ConfirmationSnapshot | { status: 'not-awaiting' | 'stale' }>) {}
  getState(): ConfirmationState { return this.state }
  load(key: ConfirmationKey): Promise<void> {
    if (this.inFlight && sameKey(this.inFlight.key, key)) return this.inFlight.promise
    this.state = { status: 'loading', key }
    const promise = this.read(key).then((result) => {
      if (!this.inFlight || !sameKey(this.inFlight.key, key)) return
      if ('status' in result) this.state = { status: 'error', key, error: result.status }
      else this.state = { status: 'ready', snapshot: result }
    }).catch((error: unknown) => {
      if (this.inFlight && sameKey(this.inFlight.key, key)) this.state = { status: 'error', key, error }
    }).finally(() => {
      if (this.inFlight && sameKey(this.inFlight.key, key)) this.inFlight = undefined
    })
    this.inFlight = { key, promise }
    return promise
  }
  clear(_nextKey?: ConfirmationKey): void {
    this.inFlight = undefined
    this.state = { status: 'absent' }
  }
}
