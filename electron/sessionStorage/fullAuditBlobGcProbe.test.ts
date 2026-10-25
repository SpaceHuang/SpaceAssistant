import {it,expect,vi} from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createTempDatabase} from '../database/testHelpers'
import {createSession,appendMessage} from '../database/operations'
import {getDbConnection} from '../database/sqliteStore'
import {SqliteAgentHistory} from '../runtime/sqliteAgentHistory'
import {advanceProcessGeneration} from '../database/processGeneration'
import {createSqliteProjectionBuildTask,createSqliteSessionStorageHost} from './sqliteSessionStorage'
import {readChatMessagesAfterPreparation} from './public/readMessages'

it('reclaims projection blob files when clearing projection caches',async()=>{
 const temp=createTempDatabase('audit-source-spill-');let host:ReturnType<typeof createSqliteSessionStorageHost>|undefined
 try{
  const db=temp.db,conn=getDbConnection(db),session=createSession(db,{name:'audit spill'})
  const body='canonical source '.repeat(5000)
  appendMessage(db,{id:'audit-user',sessionId:session.id,role:'user',content:body,timestamp:1,status:'sent'})
  const history=new SqliteAgentHistory(conn,1,Date.now,session.id)
  await history.appendBatch([{invocationId:'audit-inv',turnId:'audit-turn',sequence:1,schemaVersion:1,eventId:'audit-event',idempotencyKey:'audit-event',kind:'invocation-context-committed',payload:{messages:[{id:'audit-user',role:'user',content:body,timestamp:1}]}}],0)
  const stored=JSON.parse(conn.prepare("SELECT payload_json FROM agent_history_events WHERE event_id='audit-event'").get()!.payload_json as string)
  const locator=stored.messages[0].content.__spaceassistant_spill_v1.locator
  conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(session.id)
  conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(session.id)
  const generation=advanceProcessGeneration(conn),blobRoot=path.join(path.dirname(temp.dbPath),'projection-blobs')
  const task=createSqliteProjectionBuildTask({db,dbPath:temp.dbPath,blobRoot,processGeneration:()=>generation,connectionEpoch:()=>generation,now:Date.now})
  host=createSqliteSessionStorageHost(db,{storage:{projectionBlobRoot:blobRoot},startup:{recoverHistory:async()=>({interruptedCount:0,repairFailureCount:0}),recoverSessionLedgers:async()=>({repairFailureCount:0})},maintenanceTasks:[task]})
  expect((await readChatMessagesAfterPreparation(host.storage,{sessionId:session.id}))[0]?.content).toBe(body)
  expect((await fs.readdir(blobRoot)).filter(name=>name.endsWith('.blob')).length).toBeGreaterThan(0)
  host.lifecycle.allowBackgroundWork()
  await host.storage.clearProjectionCaches!()
  await vi.waitFor(async()=>expect((await fs.readdir(blobRoot)).filter(name=>name.endsWith('.blob')).length).toBe(0),{timeout:5000})
 }finally{await host?.lifecycle.stop({deadlineMs:5000});temp.cleanup()}
})
