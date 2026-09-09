import { createHash } from 'node:crypto'
import { canonicalQueueInput, type QueueInputFingerprintInput } from '../src/shared/queueInputFingerprint'

export function queueInputFingerprint(input: QueueInputFingerprintInput): string {
  return createHash('sha256').update(canonicalQueueInput(input), 'utf8').digest('hex')
}
