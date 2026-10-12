import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { createDeferredEnvelopeStore } from '../confirmation/deferredEnvelopeStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import type { RemoteTrackContext } from '../../src/shared/remoteTrack'

export function readDeferredCompletionWake(db: AppDatabase, todoId: string) {
  const conn = getDbConnection(db)
  const todo = conn.prepare(`SELECT t.todo_id,t.invocation_id,t.channel,t.identity_key,t.owner_id,t.origin_session_id,t.workflow_id,t.task_id,t.step_id,t.plan_revision,t.state,
      t.track_id,t.authorization_epoch,i.checkpoint_id FROM deferred_todos t LEFT JOIN security_action_intents i ON i.invocation_id=t.invocation_id WHERE t.todo_id=?`).get(todoId) as {
    todo_id: string; invocation_id: string; channel: 'feishu' | 'wechat'; identity_key: string; owner_id: string
    origin_session_id: string; workflow_id: string; task_id: string; step_id: string; plan_revision: number; state: string; checkpoint_id: string | null
    track_id: string | null; authorization_epoch: number
  } | undefined
  if (!todo) return null
  const execution = createDeferredExecutionResultStore(db).getByTodo(todoId)
  const completion = createDeferredExecutionResultStore(db).listCompletionOutbox(todoId).find(({ state }) => state === 'pending' || state === 'delivered')
  const envelope = createDeferredEnvelopeStore(db).get(todo.invocation_id)
  if (!execution || !completion || !envelope || execution.invocationId !== todo.invocation_id ||
    execution.dispatchKey !== completion.dispatchKey || execution.state === 'outcome_unknown' || execution.state === 'dispatching') return null
  const trackId = todo.track_id
  const trackContext = trackId ? readDeferredCompletionTrackContext(db, { ...todo, track_id: trackId }, envelope.executionContext) : undefined
  if (todo.track_id && !trackContext) return null
  return { todo, execution, completion, envelope, ...(trackContext ? { trackContext } : {}) }
}

function readDeferredCompletionTrackContext(
  db: AppDatabase,
  todo: { todo_id: string; track_id: string; channel: 'feishu' | 'wechat'; identity_key: string; owner_id: string;
    authorization_epoch: number; origin_session_id: string },
  executionContext: Record<string, unknown>
): RemoteTrackContext | null {
  const sourceMessageId = executionContext.currentUserMessageId
  const platformMessageId = executionContext.messageId
  if (typeof sourceMessageId !== 'string' || !sourceMessageId.trim() ||
    typeof platformMessageId !== 'string' || !platformMessageId.trim()) return null
  const conn = getDbConnection(db)
  const source = conn.prepare(`SELECT channel,platform_message_id,track_id,track_event_id FROM im_inbox_message_context WHERE message_id=?`)
    .get(sourceMessageId) as { channel: string; platform_message_id: string; track_id: string | null; track_event_id: string | null } | undefined
  if (!source || source.channel !== todo.channel || source.platform_message_id !== platformMessageId ||
    source.track_id !== todo.track_id || !source.track_event_id) return null
  const row = conn.prepare(`SELECT track.root_message_id,track.parent_track_id,track.origin_session_id,track.channel,track.identity_key,
      track.owner_id,track.authorization_epoch,authorization.epoch AS current_epoch,event.message_id AS event_message_id
    FROM remote_tracks track JOIN remote_authorization_epochs authorization ON authorization.channel=track.channel
    JOIN remote_track_events event ON event.event_id=? AND event.track_id=track.track_id
    WHERE track.track_id=?`).get(source.track_event_id, todo.track_id) as {
      root_message_id: string; parent_track_id: string | null; origin_session_id: string | null; channel: string; identity_key: string;
      owner_id: string; authorization_epoch: number; current_epoch: number; event_message_id: string | null
    } | undefined
  if (!row || row.origin_session_id !== todo.origin_session_id || row.channel !== todo.channel ||
    row.identity_key !== todo.identity_key || row.owner_id !== todo.owner_id ||
    row.authorization_epoch !== todo.authorization_epoch || row.current_epoch !== todo.authorization_epoch ||
    row.event_message_id !== platformMessageId) return null
  return { trackId: todo.track_id, channel: todo.channel, identityKey: todo.identity_key, ownerId: todo.owner_id,
    authorizationEpoch: todo.authorization_epoch, rootMessageId: row.root_message_id,
    ...(row.parent_track_id ? { parentTrackId: row.parent_track_id } : {}),
    ...(row.origin_session_id ? { originSessionId: row.origin_session_id } : {}), attributionEventId: source.track_event_id }
}

export function markDeferredCompletionWakeDelivered(db: AppDatabase, todoId: string, now?: number): boolean {
  return createDeferredExecutionResultStore(db).markCompletionDelivered(todoId, now)
}
