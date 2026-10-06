import { openSqliteDatabaseReadOnly, getDbConnection } from '../electron/database/sqliteStore'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('Usage: node --import tsx scripts/session-projection-scope-profile-audit.ts <database-path>')
  process.exitCode = 2
} else {
  const db = openSqliteDatabaseReadOnly(dbPath)
  try {
    const conn = getDbConnection(db)
    const dataVersionBefore = Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
    const totalChangesBefore = Number((conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
    const schemaVersion = (conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value ?? null
    const scopeGroups = conn.prepare(`SELECT ownership,visibility,COUNT(*) AS sessionCount FROM sessions
      GROUP BY ownership,visibility ORDER BY ownership,visibility`).all() as Array<{
        ownership: string | null; visibility: string | null; sessionCount: number
      }>
    const historyByScope = conn.prepare(`WITH session_history AS (
      SELECT streams.session_id,COUNT(events.sequence) AS event_count FROM agent_history_streams streams
      LEFT JOIN agent_history_events events ON events.invocation_id=streams.invocation_id GROUP BY streams.session_id
    ) SELECT sessions.ownership,sessions.visibility,COUNT(*) AS sessionCount,
      SUM(CASE WHEN COALESCE(session_history.event_count,0)>0 THEN 1 ELSE 0 END) AS sessionsWithEvents,
      SUM(COALESCE(session_history.event_count,0)) AS events
      FROM sessions LEFT JOIN session_history ON session_history.session_id=sessions.id
      GROUP BY sessions.ownership,sessions.visibility ORDER BY sessions.ownership,sessions.visibility`).all()
    const userLegacyData = conn.prepare(`WITH session_history AS (
      SELECT streams.session_id,COUNT(events.sequence) AS event_count FROM agent_history_streams streams
      LEFT JOIN agent_history_events events ON events.invocation_id=streams.invocation_id GROUP BY streams.session_id
    ), message_facts AS (
      SELECT session_id,COUNT(*) AS message_count,
        SUM(CASE WHEN role NOT IN ('user','assistant') THEN 1 ELSE 0 END) AS noneligible_role_count,
        SUM(CASE WHEN COALESCE(tool_calls,'')<>'' THEN 1 ELSE 0 END) AS tool_calls_count,
        SUM(CASE WHEN COALESCE(thinking,'')<>'' THEN 1 ELSE 0 END) AS thinking_count,
        SUM(CASE WHEN COALESCE(content_segments,'')<>'' THEN 1 ELSE 0 END) AS content_segments_count,
        SUM(CASE WHEN COALESCE(skill_hints,'')<>'' THEN 1 ELSE 0 END) AS skill_hints_count,
        SUM(CASE WHEN COALESCE(attachments,'')<>'' THEN 1 ELSE 0 END) AS attachments_count
      FROM messages GROUP BY session_id
    ) SELECT COUNT(*) AS sessionCount,
      SUM(CASE WHEN COALESCE(session_history.event_count,0)>0 THEN 1 ELSE 0 END) AS withHistoryCount,
      SUM(CASE WHEN COALESCE(session_history.event_count,0)=0 AND COALESCE(message_facts.message_count,0)>0 THEN 1 ELSE 0 END) AS historyAbsentWithMessagesSessionCount,
      SUM(CASE WHEN COALESCE(session_history.event_count,0)=0 AND COALESCE(message_facts.message_count,0)>0 AND COALESCE(message_facts.noneligible_role_count,0)=0 THEN 1 ELSE 0 END) AS historyAbsentRoleEligibleSessionCount,
      SUM(CASE WHEN COALESCE(session_history.event_count,0)=0 AND COALESCE(message_facts.noneligible_role_count,0)>0 THEN 1 ELSE 0 END) AS historyAbsentRoleIneligibleSessionCount,
      SUM(COALESCE(message_facts.message_count,0)) AS messageCount,
      SUM(COALESCE(message_facts.noneligible_role_count,0)) AS noneligibleRoleMessageCount,
      SUM(COALESCE(message_facts.tool_calls_count,0)) AS toolCallsMessageCount,
      SUM(COALESCE(message_facts.thinking_count,0)) AS thinkingMessageCount,
      SUM(COALESCE(message_facts.content_segments_count,0)) AS contentSegmentsMessageCount,
      SUM(COALESCE(message_facts.skill_hints_count,0)) AS skillHintsMessageCount,
      SUM(COALESCE(message_facts.attachments_count,0)) AS attachmentMessageCount
      FROM sessions LEFT JOIN session_history ON session_history.session_id=sessions.id
      LEFT JOIN message_facts ON message_facts.session_id=sessions.id
      WHERE sessions.ownership IN ('user','remote','automation') AND sessions.visibility IN ('primary','section')`).get()
    const internalRawHistory = conn.prepare(`WITH stream_health AS (
      SELECT streams.session_id,streams.invocation_id,streams.version,COUNT(events.sequence) AS event_count,
        MIN(events.sequence) AS first_sequence,MAX(events.sequence) AS last_sequence,
        SUM(CASE WHEN events.sequence IS NOT NULL AND json_valid(events.payload_json)=0 THEN 1 ELSE 0 END) AS invalid_json
      FROM agent_history_streams streams LEFT JOIN agent_history_events events ON events.invocation_id=streams.invocation_id
      GROUP BY streams.session_id,streams.invocation_id,streams.version
    ), session_health AS (
      SELECT session_id,SUM(event_count) AS event_count,
        MAX(CASE WHEN version<>event_count OR (event_count>0 AND (first_sequence<>1 OR last_sequence<>event_count)) OR invalid_json>0 THEN 1 ELSE 0 END) AS unhealthy
      FROM stream_health GROUP BY session_id
    ) SELECT COUNT(*) AS sessionCount,
      SUM(CASE WHEN COALESCE(session_health.event_count,0)>0 THEN 1 ELSE 0 END) AS withHistoryCount,
      SUM(CASE WHEN COALESCE(session_health.event_count,0)>0 AND COALESCE(session_health.unhealthy,0)=0 THEN 1 ELSE 0 END) AS healthyCount,
      SUM(CASE WHEN COALESCE(session_health.event_count,0)>0 AND COALESCE(session_health.unhealthy,0)>0 THEN 1 ELSE 0 END) AS unhealthyCount,
      COALESCE(SUM(session_health.event_count),0) AS eventCount
      FROM sessions LEFT JOIN session_health ON session_health.session_id=sessions.id
      WHERE sessions.ownership='internal' AND sessions.visibility='hidden'`).get()
    const eventColumns = (conn.prepare('PRAGMA table_info(agent_history_events)').all() as Array<{ name: string }>).map(({ name }) => name)
    const migrationRunTablePresent = Boolean(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_projection_migration_runs'").get())
    const dataVersionAfter = Number((conn.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
    const totalChangesAfter = Number((conn.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
    const knownMigrationScopeCount = scopeGroups.filter(({ ownership, visibility }) =>
      ['user', 'remote', 'automation'].includes(ownership ?? '') && ['primary', 'section'].includes(visibility ?? ''))
      .reduce((count, row) => count + Number(row.sessionCount), 0)
    const excludedInternalHiddenSessionCount = scopeGroups.find(({ ownership, visibility }) =>
      ownership === 'internal' && visibility === 'hidden')?.sessionCount ?? 0
    const scopeAnomalyCount = scopeGroups.filter(({ ownership, visibility }) =>
      !(ownership === 'internal' && visibility === 'hidden') &&
      (!['user', 'remote', 'automation'].includes(ownership ?? '') || !['primary', 'section'].includes(visibility ?? '')))
      .reduce((count, row) => count + Number(row.sessionCount), 0)
    const report = {
      schemaVersion,
      databaseSessionCount: scopeGroups.reduce((count, row) => count + Number(row.sessionCount), 0),
      migrationSessionCount: knownMigrationScopeCount,
      excludedInternalHiddenSessionCount,
      scopeAnomalyCount,
      scopeGroups,
      historyByScope,
      userLegacyData,
      internalRawHistory,
      historyEventColumns: eventColumns,
      migrationRunTablePresent,
      readOnly: true,
      dataVersionBefore,
      dataVersionAfter,
      totalChangesBefore,
      totalChangesAfter,
      stableSnapshot: dataVersionBefore === dataVersionAfter && totalChangesBefore === totalChangesAfter
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.stableSnapshot) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    db.close()
  }
}
