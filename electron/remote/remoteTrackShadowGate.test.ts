import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { readRemoteTrackShadowGateReport, REMOTE_TRACK_SHADOW_WINDOW_MS } from './remoteTrackShadowGate'

function seedReviewedWindow(db: ReturnType<typeof createMemoryAppDb>, now: number): void {
  const conn = getDbConnection(db)
  const insert = conn.prepare(`INSERT INTO remote_track_attribution_observations(
    observation_id,channel,identity_key,owner_id,authorization_epoch,platform_message_id,classifier_version,decision_kind,reason_code,
    candidate_snapshot_json,latency_ms,created_at,classifier_invoked,provider_call_made,estimated_cost_usd,review_outcome,reviewed_at,
    pricing_source_url,pricing_effective_at,pricing_verified_at,pricing_verified_by
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (let index = 0; index < 500; index += 1) {
    const createdAt = now - REMOTE_TRACK_SHADOW_WINDOW_MS + Math.floor(index * REMOTE_TRACK_SHADOW_WINDOW_MS / 499)
    insert.run(`observation-${index}`, index % 2 === 0 ? 'wechat' : 'feishu', `user-${index}`, 'owner', 1, `message-${index}`,
      'classifier-v1', 'continuation', 'semantic-unique-above-threshold', '{}', 1_200, createdAt, 1, 1, 0.0005, 'correct', now,
      'https://provider.example.test/pricing', '2026-10-01', '2026-10-10', 'reviewer-1')
  }
}

describe('remote Track shadow activation gate', () => {
  it('opens only after continuous reviewed samples, per-channel volume, latency, and measured cost satisfy v1 limits', () => {
    const db = createMemoryAppDb()
    try {
      const now = REMOTE_TRACK_SHADOW_WINDOW_MS * 2
      seedReviewedWindow(db, now)
      const report = readRemoteTrackShadowGateReport(db, now)
      expect(report).toMatchObject({ ready: true, observations: 500,
        channelObservations: { wechat: 250, feishu: 250 }, reviewedObservations: 500, wrongAttributions: 0,
        p95LatencyMs: 1_200, providerCalls: 500, unpricedProviderCalls: 0 })
      expect(report.costUsdPerThousandCalls).toBeCloseTo(0.5)
    } finally { db.close() }
  })

  it('keeps the gate closed for any reported misattribution or unknown provider cost', () => {
    const db = createMemoryAppDb()
    try {
      const now = REMOTE_TRACK_SHADOW_WINDOW_MS * 2
      seedReviewedWindow(db, now)
      const conn = getDbConnection(db)
      conn.prepare("UPDATE remote_track_attribution_observations SET review_outcome='wrong' WHERE observation_id='observation-0'").run()
      conn.prepare('UPDATE remote_track_attribution_observations SET estimated_cost_usd=NULL WHERE observation_id=?').run('observation-1')
      expect(readRemoteTrackShadowGateReport(db, now)).toMatchObject({ ready: false, wrongAttributions: 1, unpricedProviderCalls: 1,
        blockers: ['wrong-attribution-reported', 'classifier-cost-unavailable-or-over-limit'] })
    } finally { db.close() }
  })

  it('does not accept numeric costs without row-level pricing source and review evidence', () => {
    const db = createMemoryAppDb()
    try {
      const now = REMOTE_TRACK_SHADOW_WINDOW_MS * 2
      seedReviewedWindow(db, now)
      getDbConnection(db).prepare(`UPDATE remote_track_attribution_observations
        SET pricing_source_url=NULL,pricing_effective_at=NULL,pricing_verified_at=NULL,pricing_verified_by=NULL
        WHERE observation_id='observation-0'`).run()
      expect(readRemoteTrackShadowGateReport(db, now)).toMatchObject({ ready: false, unpricedProviderCalls: 1,
        costUsdPerThousandCalls: null, blockers: ['classifier-cost-unavailable-or-over-limit'] })
    } finally { db.close() }
  })

  it('does not count observations without a classifier call toward evaluable volume or coverage', () => {
    const db = createMemoryAppDb()
    try {
      const now = REMOTE_TRACK_SHADOW_WINDOW_MS * 2
      seedReviewedWindow(db, now)
      const conn = getDbConnection(db)
      conn.prepare('UPDATE remote_track_attribution_observations SET classifier_invoked=0,provider_call_made=NULL,estimated_cost_usd=NULL').run()
      conn.prepare('UPDATE remote_track_attribution_observations SET classifier_invoked=1,provider_call_made=1,estimated_cost_usd=0.0005 WHERE observation_id IN (?,?)')
        .run('observation-0', 'observation-1')
      conn.prepare("UPDATE remote_track_attribution_observations SET review_outcome='wrong' WHERE observation_id=?").run('observation-2')

      const report = readRemoteTrackShadowGateReport(db, now)

      expect(report).toMatchObject({ ready: false, observations: 500, channelObservations: { wechat: 250, feishu: 250 },
        evaluatedObservations: 2, evaluatedChannelObservations: { wechat: 1, feishu: 1 }, providerCalls: 2, wrongAttributions: 1 })
      expect(report.blockers).toContain('evaluable-sample-count-insufficient')
      expect(report.blockers).toContain('evaluable-wechat-sample-count-insufficient')
      expect(report.blockers).toContain('evaluable-feishu-sample-count-insufficient')
      expect(report.blockers).toContain('classifier-window-coverage-insufficient')
      expect(report.blockers).toContain('wrong-attribution-reported')
    } finally { db.close() }
  })

  it('counts only actual provider requests as evaluated samples and p95 latency', () => {
    const db = createMemoryAppDb()
    try {
      const now = REMOTE_TRACK_SHADOW_WINDOW_MS * 2
      seedReviewedWindow(db, now)
      const conn = getDbConnection(db)
      conn.prepare('UPDATE remote_track_attribution_observations SET provider_call_made=0,estimated_cost_usd=NULL,latency_ms=1').run()
      conn.prepare('UPDATE remote_track_attribution_observations SET provider_call_made=1,estimated_cost_usd=0.0005,latency_ms=3000 WHERE observation_id=?')
        .run('observation-0')

      const report = readRemoteTrackShadowGateReport(db, now)

      expect(report).toMatchObject({ ready: false, evaluatedObservations: 1,
        evaluatedChannelObservations: { wechat: 1, feishu: 0 }, providerCalls: 1, p95LatencyMs: 3_000 })
      expect(report.blockers).toContain('evaluable-sample-count-insufficient')
      expect(report.blockers).toContain('classifier-p95-unavailable-or-over-limit')
    } finally { db.close() }
  })

  it('treats unreviewed samples and gaps in the 14-day observation window as blockers', () => {
    const db = createMemoryAppDb()
    try {
      const now = REMOTE_TRACK_SHADOW_WINDOW_MS * 2
      seedReviewedWindow(db, now)
      const conn = getDbConnection(db)
      conn.prepare('UPDATE remote_track_attribution_observations SET review_outcome=NULL WHERE observation_id=?').run('observation-2')
      conn.prepare('DELETE FROM remote_track_attribution_observations WHERE observation_id=?').run('observation-250')
      expect(readRemoteTrackShadowGateReport(db, now)).toMatchObject({ ready: false })
      expect(readRemoteTrackShadowGateReport(db, now).blockers).toContain('independent-review-incomplete')
      expect(readRemoteTrackShadowGateReport(db, now).blockers).not.toContain('classifier-window-coverage-insufficient')
      conn.prepare('DELETE FROM remote_track_attribution_observations WHERE created_at>? AND created_at<?')
        .run(now - REMOTE_TRACK_SHADOW_WINDOW_MS + REMOTE_TRACK_SHADOW_WINDOW_MS * 0.2,
          now - REMOTE_TRACK_SHADOW_WINDOW_MS + REMOTE_TRACK_SHADOW_WINDOW_MS * 0.8)
      expect(readRemoteTrackShadowGateReport(db, now).blockers).toContain('classifier-window-coverage-insufficient')
    } finally { db.close() }
  })
})
