import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { readRemoteTrackOperationalMetrics } from './remoteTrackOperationalMetrics'
import { recordRemoteTrackDiagnosticEvent } from './remoteTrackDiagnosticStore'
import { createRemoteTrack } from './remoteTrackStore'

describe('remote Track operational metrics', () => {
  it('aggregates clarification, work, context, join, attribution and terminal facts in a half-open window', () => {
    const db = createMemoryAppDb()
    try {
      createRemoteTrack(db, { trackId: 'metric-track', eventId: 'metric-root', idempotencyKey: 'metric-root', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'root-message', occurredAt: 1 })
      const conn = getDbConnection(db)
      conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,idempotency_key,request_id,turn_id,tool_use_id,confirmation_id,payload_json,occurred_at)
        VALUES('event-join','metric-track','track.turn.bound','event-join','request-1','turn-1',NULL,NULL,'{}',10)`).run()
      conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,idempotency_key,request_id,turn_id,payload_json,occurred_at)
        VALUES('event-confirmation-join','metric-track','track.confirmation.created','event-confirmation-join','request-1','turn-1','{}',12)`).run()
      conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,idempotency_key,payload_json,occurred_at)
        VALUES('event-rejected','metric-track','track.lifecycle.rejected_transition','event-rejected','{}',11)`).run()
      conn.prepare(`INSERT INTO remote_track_attribution_observations(observation_id,channel,identity_key,owner_id,authorization_epoch,
        platform_message_id,classifier_version,decision_kind,reason_code,candidate_snapshot_json,latency_ms,created_at,classifier_invoked,
        provider_call_made,estimated_cost_usd,review_outcome) VALUES('obs','wechat','user','owner',1,'m','v1','continuation','semantic','{}',10,10,1,1,0.001,'wrong')`).run()
      conn.prepare(`INSERT INTO remote_clarifications(clarification_id,channel,identity_key,owner_id,authorization_epoch,source_message_id,
        parked_input_ref,state,current_version,expires_at,created_at,updated_at) VALUES('clar','wechat','user','owner',1,'source','parked','resolved',1,100,10,18)`).run()
      conn.prepare(`INSERT INTO remote_clarification_versions(clarification_id,version,handle,candidate_snapshot_json,snapshot_hash,state,created_at)
        VALUES('clar',1,'ABCDEFGHJK345','[]','hash','current',10)`).run()
      conn.prepare(`INSERT INTO remote_clarification_send_attempts(send_attempt_id,clarification_id,version,state,started_at,finished_at)
        VALUES('attempt','clar',1,'send-rejected',12,15)`).run()
      conn.prepare(`INSERT INTO remote_track_work_queue(work_id,source_key,track_id,source_message_id,state,attempt_count,created_at,updated_at)
        VALUES('work','work','metric-track','m','needs-reconciliation',3,10,19)`).run()
      conn.prepare(`INSERT INTO remote_track_events(event_id,track_id,event_kind,idempotency_key,message_id,turn_id,payload_json,occurred_at)
        VALUES('model-event','metric-track','track.model.message','model','missing-message','turn-1','{}',13)`).run()
      conn.prepare(`UPDATE remote_tracks SET state='completed',updated_at=18 WHERE track_id='metric-track'`).run()
      recordRemoteTrackDiagnosticEvent(db, { channel: 'wechat', platformMessageId: 'stale-reply', eventKind: 'clarification.reply',
        reasonCode: 'stale', occurredAt: 14 })
      recordRemoteTrackDiagnosticEvent(db, { channel: 'wechat', platformMessageId: 'legacy-option', eventKind: 'clarification.reply',
        reasonCode: 'invalid', occurredAt: 15 })
      conn.prepare(`INSERT INTO remote_track_runtime_diagnostics(diagnostic_id,channel,platform_message_id,event_kind,reason_code,occurred_at)
        VALUES('runtime-missing-context','wechat','runtime-message','untracked-runtime-invocation','track-context-missing',15)`).run()

      const report = readRemoteTrackOperationalMetrics(db, { from: 10, to: 20 })
      expect(report.window).toEqual({ from: 10, to: 20 })
      expect(report.metrics['remote_track_wrong_attribution_report_total'].value.byChannel.wechat).toBe(1)
      expect(report.metrics['remote_track_join_completeness'].value.missingRequiredRefs).toBeGreaterThan(0)
      expect(report.metrics['remote_clarification_delivery_total'].value.byResult['send-rejected']).toBe(1)
      expect(report.metrics['remote_clarification_resolution_latency'].value.byChannel.wechat.p50Ms).toBe(8)
      expect(report.metrics['remote_clarification_stale_reply_total'].value.byReason.stale).toBe(1)
      expect(report.metrics['remote_track_work_recovery_total'].value.byState['needs-reconciliation']).toBe(1)
      expect(report.metrics['remote_track_context_completeness'].value.byStatus.partial).toBeGreaterThan(0)
      expect(report.metrics['remote_track_context_completeness']).toMatchObject({ available: false, missingReason: 'view-snapshots-not-persisted' })
      expect(report.metrics['remote_track_terminal_transition_rejected_total'].value.total).toBe(1)
      expect(report.alerts.map(({ code }) => code)).toContain('wrong-attribution-reported')
      expect(report.metrics['remote_track_wrong_attribution_report_total'].value.semanticContinuationMustPause).toBe(true)
      expect(report.alerts.map(({ code }) => code)).toContain('untracked-runtime-invocation')
      expect(report.alerts.map(({ code }) => code)).toContain('invalid-clarification-control-reply')
    } finally { db.close() }
  })

  it('marks unavailable source metrics with missing reasons instead of reporting false zeroes', () => {
    const db = createMemoryAppDb()
    try {
      const report = readRemoteTrackOperationalMetrics(db, { from: 10, to: 20 })
      expect(report.metrics['remote_clarification_resolution_latency']).toMatchObject({ available: false, missingReason: 'no-resolved-clarifications' })
      expect(report.metrics['remote_track_work_recovery_total']).toMatchObject({ available: false, missingReason: 'no-work-events' })
      expect(report.metrics['remote_track_join_completeness']).toMatchObject({ available: false, missingReason: 'no-track-events' })
    } finally { db.close() }
  })

  it('raises bounded alerts for parked clarification, resolved work, and processing Track that exceed their deadlines', () => {
    const db = createMemoryAppDb()
    try {
      const conn = getDbConnection(db)
      createRemoteTrack(db, { trackId: 'stuck-track', eventId: 'stuck-root', idempotencyKey: 'stuck-root', channel: 'wechat',
        identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1, rootMessageId: 'stuck-message', occurredAt: 1 })
      conn.prepare(`UPDATE remote_tracks SET state='processing',updated_at=1 WHERE track_id='stuck-track'`).run()
      conn.prepare(`INSERT INTO remote_clarifications(clarification_id,channel,identity_key,owner_id,authorization_epoch,source_message_id,
        parked_input_ref,state,current_version,expires_at,created_at,updated_at) VALUES('expired-clar','wechat','user','owner',1,'parked-source','parked','pending',1,100,1,1)`).run()
      conn.prepare(`INSERT INTO remote_clarifications(clarification_id,channel,identity_key,owner_id,authorization_epoch,source_message_id,
        parked_input_ref,state,current_version,expires_at,created_at,updated_at) VALUES('resolved-clar','wechat','user','owner',1,'resolved-source','parked','resolved',1,100,1,1)`).run()

      const report = readRemoteTrackOperationalMetrics(db, { from: 0, to: 40 * 60_000 })
      expect(report.alerts).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'clarification-parked-over-ttl', count: 1 }),
        expect.objectContaining({ code: 'clarification-resolved-work-incomplete', count: 1 }),
        expect.objectContaining({ code: 'track-processing-over-window', count: 1 })
      ]))
    } finally { db.close() }
  })

  it('rejects invalid metric windows', () => {
    const db = createMemoryAppDb()
    try { expect(() => readRemoteTrackOperationalMetrics(db, { from: 20, to: 20 })).toThrow('REMOTE_TRACK_OPERATIONAL_METRICS_RANGE_INVALID') }
    finally { db.close() }
  })
})
