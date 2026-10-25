import {it,expect} from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createTempDatabase} from '../database/testHelpers'
import {openDatabase} from '../database'
import {createSession,appendMessage} from '../database/operations'
import {getDbConnection} from '../database/sqliteStore'
import {SqliteAgentHistory} from '../runtime/sqliteAgentHistory'
import {advanceProcessGeneration} from '../database/processGeneration'
import {createSqliteProjectionBuildTask,createSqliteSessionStorageHost} from './sqliteSessionStorage'
import {readChatMessagesAfterPreparation} from './public/readMessages'
import {readSessionTranscriptProjection} from './infrastructure/sqlite/sessionTranscriptProjection'
it('rejects a prepared chat read when its canonical source spill has disappeared',async()=>{
 const temp=createTempDatabase('audit-source-spill-');let host:ReturnType<typeof createSqliteSessionStorageHost>|undefined
 try{
  const db=temp.db,conn=getDbConnection(db),session=createSession(db,{name:'audit spill'})
  const body='canonical source '.repeat(5000)
  appendMessage(db,{id:'audit-user',sessionId:session.id,role:'user',content:body,timestamp:1,status:'sent'})
  const history=new SqliteAgentHistory(conn,1,Date.now,session.id)
  await history.appendBatch([{invocationId:'audit-inv',turnId:'audit-turn',sequence:1,schemaVersion:1,eventId:'audit-event',idempotencyKey:'audit-event',kind:'invocation-context-committed',payload:{messages:[{id:'audit-user',role:'user',content:body,timestamp:1}]}}],0)
  const stored=JSON.parse(conn.prepare("SELECT payload_json FROM agent_history_events WHERE event_id='audit-event'").get()!.payload_json as string)
  const locator=stored.messages[0].content.__spaceassistant_spill_v1.locator
  conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation')
    WHERE owner_table='agent_history_events'`).run()
  conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
  conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
  const generation=advanceProcessGeneration(conn),blobRoot=path.join(path.dirname(temp.dbPath),'projection-blobs')
  const task=createSqliteProjectionBuildTask({db,dbPath:temp.dbPath,blobRoot,processGeneration:()=>generation,connectionEpoch:()=>generation,now:Date.now})
  host=createSqliteSessionStorageHost(db,{storage:{projectionBlobRoot:blobRoot},startup:{recoverHistory:async()=>({interruptedCount:0,repairFailureCount:0}),recoverSessionLedgers:async()=>({repairFailureCount:0})},maintenanceTasks:[task]})
  expect((await readChatMessagesAfterPreparation(host.storage,{sessionId:session.id}))[0]?.content).toBe(body)
  await fs.rm(path.join(path.dirname(temp.dbPath),'spill',locator))
  expect(()=>readSessionTranscriptProjection(db,session.id)).toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  let failure:string|undefined
  try{await readChatMessagesAfterPreparation(host.storage,{sessionId:session.id})}catch(error){failure=(error as Error).message}
  expect(failure).toBe('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
 }finally{await host?.lifecycle.stop({deadlineMs:5000});temp.cleanup()}
})

it('rejects a prepared chat read when its canonical source spill digest no longer matches',async()=>{
 const temp=createTempDatabase('audit-source-spill-tamper-');let host:ReturnType<typeof createSqliteSessionStorageHost>|undefined
 try{
  const db=temp.db,conn=getDbConnection(db),session=createSession(db,{name:'audit spill tamper'}),body='canonical source '.repeat(5000)
  appendMessage(db,{id:'audit-user-tamper',sessionId:session.id,role:'user',content:body,timestamp:1,status:'sent'})
  await new SqliteAgentHistory(conn,1,Date.now,session.id).appendBatch([{invocationId:'audit-inv-tamper',turnId:'audit-turn-tamper',sequence:1,schemaVersion:1,
    eventId:'audit-event-tamper',idempotencyKey:'audit-event-tamper',kind:'invocation-context-committed',payload:{messages:[{id:'audit-user-tamper',role:'user',content:body,timestamp:1}]}}],0)
  const payload=JSON.parse(conn.prepare("SELECT payload_json FROM agent_history_events WHERE event_id='audit-event-tamper'").get()!.payload_json as string)
  const descriptor=payload.messages[0].content.__spaceassistant_spill_v1
  conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation')
    WHERE owner_table='agent_history_events'`).run()
  conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
  conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
  const generation=advanceProcessGeneration(conn),blobRoot=path.join(path.dirname(temp.dbPath),'projection-blobs')
  const task=createSqliteProjectionBuildTask({db,dbPath:temp.dbPath,blobRoot,processGeneration:()=>generation,connectionEpoch:()=>generation,now:Date.now})
  host=createSqliteSessionStorageHost(db,{storage:{projectionBlobRoot:blobRoot},startup:{recoverHistory:async()=>({interruptedCount:0,repairFailureCount:0}),recoverSessionLedgers:async()=>({repairFailureCount:0})},maintenanceTasks:[task]})
  expect((await readChatMessagesAfterPreparation(host.storage,{sessionId:session.id}))[0]?.content).toBe(body)
  const spillPath=path.join(path.dirname(temp.dbPath),'spill',descriptor.locator),bytes=await fs.readFile(spillPath)
  bytes[0]=bytes[0]===0?1:0
  await fs.writeFile(spillPath,bytes)
  await expect(readChatMessagesAfterPreparation(host.storage,{sessionId:session.id})).rejects.toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
 }finally{await host?.lifecycle.stop({deadlineMs:5000});temp.cleanup()}
})

it('falls back to intact History when only the derived projection blob has disappeared',async()=>{
 const temp=createTempDatabase('audit-derived-blob-');let host:ReturnType<typeof createSqliteSessionStorageHost>|undefined
 try{
  const db=temp.db,conn=getDbConnection(db),session=createSession(db,{name:'audit derived blob'}),body='canonical large body '.repeat(15000)
  appendMessage(db,{id:'audit-user-derived',sessionId:session.id,role:'user',content:body,timestamp:1,status:'sent'})
  await new SqliteAgentHistory(conn,1,Date.now,session.id).appendBatch([{invocationId:'audit-inv-derived',turnId:'audit-turn-derived',sequence:1,schemaVersion:1,
    eventId:'audit-event-derived',idempotencyKey:'audit-event-derived',kind:'invocation-context-committed',payload:{messages:[{id:'audit-user-derived',role:'user',content:body,timestamp:1}]}}],0)
  conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation')
    WHERE owner_table='agent_history_events'`).run()
  conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
  conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
  const generation=advanceProcessGeneration(conn),blobRoot=path.join(path.dirname(temp.dbPath),'projection-blobs')
  const task=createSqliteProjectionBuildTask({db,dbPath:temp.dbPath,blobRoot,processGeneration:()=>generation,connectionEpoch:()=>generation,now:Date.now})
  host=createSqliteSessionStorageHost(db,{storage:{projectionBlobRoot:blobRoot},startup:{recoverHistory:async()=>({interruptedCount:0,repairFailureCount:0}),recoverSessionLedgers:async()=>({repairFailureCount:0})},maintenanceTasks:[task]})
  expect((await readChatMessagesAfterPreparation(host.storage,{sessionId:session.id}))[0]?.content).toBe(body)
  const blobs=(await fs.readdir(blobRoot)).filter(name=>name.endsWith('.blob'))
  expect(blobs.length).toBeGreaterThan(0)
  for(const blob of blobs)await fs.rm(path.join(blobRoot,blob))
  await expect(readChatMessagesAfterPreparation(host.storage,{sessionId:session.id})).resolves.toMatchObject([{id:'audit-user-derived',content:body}])
 }finally{await host?.lifecycle.stop({deadlineMs:5000});temp.cleanup()}
})

it('rechecks canonical source spills after reopening the SQLite connection',async()=>{
 const temp=createTempDatabase('audit-source-spill-reopen-');let host:ReturnType<typeof createSqliteSessionStorageHost>|undefined
 let reopenedDb:ReturnType<typeof openDatabase>|undefined
 try{
  const session=createSession(temp.db,{name:'audit spill reopen'}),body='canonical source '.repeat(5000)
  appendMessage(temp.db,{id:'audit-user-reopen',sessionId:session.id,role:'user',content:body,timestamp:1,status:'sent'})
  await new SqliteAgentHistory(getDbConnection(temp.db),1,Date.now,session.id).appendBatch([{invocationId:'audit-inv-reopen',turnId:'audit-turn-reopen',sequence:1,schemaVersion:1,
    eventId:'audit-event-reopen',idempotencyKey:'audit-event-reopen',kind:'invocation-context-committed',payload:{messages:[{id:'audit-user-reopen',role:'user',content:body,timestamp:1}]}}],0)
  const conn=getDbConnection(temp.db),payload=JSON.parse(conn.prepare("SELECT payload_json FROM agent_history_events WHERE event_id='audit-event-reopen'").get()!.payload_json as string)
  const descriptor=payload.messages[0].content.__spaceassistant_spill_v1
  conn.prepare(`UPDATE spill_reference_backfill_state SET status='complete',verified_generation=(SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation') WHERE owner_table='agent_history_events'`).run()
  conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
  conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
  const generation=advanceProcessGeneration(conn),blobRoot=path.join(path.dirname(temp.dbPath),'projection-blobs')
  const task=createSqliteProjectionBuildTask({db:temp.db,dbPath:temp.dbPath,blobRoot,processGeneration:()=>generation,connectionEpoch:()=>generation,now:Date.now})
  host=createSqliteSessionStorageHost(temp.db,{storage:{projectionBlobRoot:blobRoot},startup:{recoverHistory:async()=>({interruptedCount:0,repairFailureCount:0}),recoverSessionLedgers:async()=>({repairFailureCount:0})},maintenanceTasks:[task]})
  expect((await readChatMessagesAfterPreparation(host.storage,{sessionId:session.id}))[0]?.content).toBe(body)
  await host.lifecycle.stop({deadlineMs:5000});host=undefined
  temp.db.close()
  reopenedDb=openDatabase(temp.dbPath)
  const reopenedGeneration=advanceProcessGeneration(getDbConnection(reopenedDb))
  const reopenedTask=createSqliteProjectionBuildTask({db:reopenedDb,dbPath:temp.dbPath,blobRoot,processGeneration:()=>reopenedGeneration,connectionEpoch:()=>reopenedGeneration,now:Date.now})
  host=createSqliteSessionStorageHost(reopenedDb,{storage:{projectionBlobRoot:blobRoot},startup:{recoverHistory:async()=>({interruptedCount:0,repairFailureCount:0}),recoverSessionLedgers:async()=>({repairFailureCount:0})},maintenanceTasks:[reopenedTask]})
  await fs.rm(path.join(path.dirname(temp.dbPath),'spill',descriptor.locator))
  await expect(readChatMessagesAfterPreparation(host.storage,{sessionId:session.id})).rejects.toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
 }finally{await host?.lifecycle.stop({deadlineMs:5000});reopenedDb?.close();temp.cleanup()}
})
