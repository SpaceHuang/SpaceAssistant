import { openDatabase, setConfigValue } from '../electron/database'
import { listRemoteTrackAttributionReviewSamples, reviewRemoteTrackAttributionObservation } from '../electron/database/remoteTrackAttributionObservationStore'
import { parseRemoteTrackClassifierPricingConfig, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY } from '../electron/remote/remoteTrackClassifierPricing'
import { readRemoteTrackShadowGateReport } from '../electron/remote/remoteTrackShadowGate'
import { readRemoteTrackOperationalMetrics } from '../electron/database/remoteTrackOperationalMetrics'
import { applyRemoteTrackGateConfiguration, parseRemoteTrackRolloutChannels, REMOTE_TRACK_ROLLOUT_CHANNELS_CONFIG_KEY } from '../electron/remote/remoteTrackFeatureGates'

function usage(): never {
  throw new Error(`Usage:
  node --import tsx scripts/remote-track-shadow-review.ts <database-path> report [now-ms]
  node --import tsx scripts/remote-track-shadow-review.ts <database-path> metrics <from-ms> <to-ms>
  node --import tsx scripts/remote-track-shadow-review.ts <database-path> list <from-ms> <to-ms> [limit]
  node --import tsx scripts/remote-track-shadow-review.ts <database-path> review <observation-id> <correct|wrong|uncertain> <reviewed-at-ms>
  node --import tsx scripts/remote-track-shadow-review.ts <database-path> rates <versioned-json>
  node --import tsx scripts/remote-track-shadow-review.ts <database-path> channels <["wechat","feishu"]>
  node --import tsx scripts/remote-track-shadow-review.ts <database-path> gates <versioned-json>`)
}

function integer(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${label}`)
  return parsed
}

function run(args: string[]): void {
  const [databasePath, command, ...rest] = args
  if (!databasePath?.trim() || !command) usage()
  const db = openDatabase(databasePath)
  try {
    if (command === 'report') {
      const now = rest[0] === undefined ? Date.now() : integer(rest[0], 'now-ms')
      process.stdout.write(`${JSON.stringify(readRemoteTrackShadowGateReport(db, now), null, 2)}\n`)
      return
    }
    if (command === 'metrics') {
      const [from, to] = rest
      process.stdout.write(`${JSON.stringify(readRemoteTrackOperationalMetrics(db, {
        from: integer(from, 'from-ms'), to: integer(to, 'to-ms')
      }), null, 2)}\n`)
      return
    }
    if (command === 'list') {
      const [from, to, limit] = rest
      process.stdout.write(`${JSON.stringify(listRemoteTrackAttributionReviewSamples(db, {
        from: integer(from, 'from-ms'), to: integer(to, 'to-ms'), ...(limit ? { limit: integer(limit, 'limit') } : {})
      }), null, 2)}\n`)
      return
    }
    if (command === 'review') {
      const [observationId, outcome, reviewedAt] = rest
      if (!observationId || !['correct', 'wrong', 'uncertain'].includes(outcome ?? '')) usage()
      const result = reviewRemoteTrackAttributionObservation(db, { observationId,
        outcome: outcome as 'correct' | 'wrong' | 'uncertain', reviewedAt: integer(reviewedAt, 'reviewed-at-ms') })
      process.stdout.write(`${result}\n`)
      return
    }
    if (command === 'rates') {
      const [raw] = rest
      if (!raw) usage()
      const parsed: unknown = JSON.parse(raw)
      const config = parseRemoteTrackClassifierPricingConfig(parsed)
      if (!config) throw new Error('pricing must be valid version 2 rate-card JSON')
      setConfigValue(db, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY, JSON.stringify(config))
      process.stdout.write('pricing-configured\n')
      return
    }
    if (command === 'channels') {
      const raw = rest[0]
      if (raw === undefined) usage()
      const channels = parseRemoteTrackRolloutChannels(raw)
      if (!channels) throw new Error('rollout channels must be a unique JSON array containing only wechat and/or feishu')
      setConfigValue(db, REMOTE_TRACK_ROLLOUT_CHANNELS_CONFIG_KEY, JSON.stringify(channels))
      process.stdout.write(`rollout-channels-configured:${channels.join(',') || 'none'}\n`)
      return
    }
    if (command === 'gates') {
      const [raw] = rest
      if (!raw) usage()
      const config = applyRemoteTrackGateConfiguration(db, JSON.parse(raw))
      process.stdout.write(`${JSON.stringify({ gates: config.gates, rolloutChannels: config.rolloutChannels }, null, 2)}\n`)
      return
    }
    usage()
  } finally {
    db.close()
  }
}

try {
  run(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
