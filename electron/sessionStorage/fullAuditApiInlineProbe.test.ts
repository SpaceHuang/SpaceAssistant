import {it,expect} from 'vitest'
import {createMemoryAppDb} from '../database/testHelpers'
import {createSession,appendMessage} from '../database/operations'
import {getDbConnection} from '../database/sqliteStore'
import {SqliteAgentHistory} from '../runtime/sqliteAgentHistory'
import {certifyCanonicalSessionApiRead} from './certification'
it('keeps API and route projection inline publication within the 256 KiB budget',async()=>{
 const db=createMemoryAppDb()
 try{
  const session=createSession(db,{name:'large API certification'}),conn=getDbConnection(db),body='x'.repeat(300*1024)
  appendMessage(db,{id:'api-big',sessionId:session.id,role:'user',content:body,timestamp:1,status:'sent'})
  await new SqliteAgentHistory(conn,1,Date.now,session.id).appendBatch([{invocationId:'api-inv',turnId:'api-turn',sequence:1,schemaVersion:1,eventId:'api-event',idempotencyKey:'api-event',kind:'invocation-context-committed',payload:{messages:[{id:'api-big',role:'user',content:body,timestamp:1}]}}],0)
  expect(certifyCanonicalSessionApiRead(db,session.id).status).toBe('eligible')
  const rows=conn.prepare('SELECT length(CAST(inline_payload AS BLOB)) AS bytes FROM session_projection_cache WHERE session_id=?').all(session.id) as Array<{bytes:number}>
  console.info('published inline payload byte lengths', rows.map(row=>row.bytes))
  expect(rows.every(row=>row.bytes<=256*1024)).toBe(true)
 }finally{db.close()}
})
