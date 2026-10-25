import {it,expect,vi} from 'vitest'
import {createMemoryAppDb} from '../database/testHelpers'
import {createSession,appendMessage} from '../database/operations'
import {getDbConnection} from '../database/sqliteStore'
import {SqliteAgentHistory} from '../runtime/sqliteAgentHistory'
import {createSessionQueries} from './queries'
import {readProjectionSourceIdentity} from './infrastructure/sqlite/projectionSourceIdentity'
import type {PreparedChatBodyView} from './public/model'
it('rejects when an already visited source changes during a later session await',async()=>{
 const db=createMemoryAppDb()
 try{
  const conn=getDbConnection(db),a=createSession(db,{name:'A'}),b=createSession(db,{name:'B'})
  for(const [s,id,ts] of [[a,'a',20],[b,'b',10]] as const){
   appendMessage(db,{id,sessionId:s.id,role:'user',content:'needle old',timestamp:ts,status:'sent'})
   const h=new SqliteAgentHistory(conn,1,Date.now,s.id)
   await h.appendBatch([{invocationId:id+'-inv',turnId:id+'-turn',sequence:1,schemaVersion:1,eventId:id+'-event',idempotencyKey:id+'-event',kind:'invocation-context-committed',payload:{messages:[{id,role:'user',content:'needle old',timestamp:ts}]}}],0)
   conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(s.id)
   conn.prepare("UPDATE messages SET content='',content_storage_state='canonical-backed-only' WHERE session_id=?").run(s.id)
  }
  const source=(id:string,generation:string)=>readProjectionSourceIdentity(conn,id,generation)??undefined
  const views=new Map([a,b].map(s=>[s.id,{sessionId:s.id,sessionGeneration:s.generation,sourceIdentityJson:source(s.id,s.generation)} as PreparedChatBodyView]))
  const queries=createSessionQueries(db,{currentSourceIdentity:source,readBodies:vi.fn(),invalidate:vi.fn(),searchBodies:async view=>({workerThreadId:1,messages:[{id:view.sessionId===a.id?'a':'b',role:'user',timestamp:view.sessionId===a.id?20:10,content:view.sessionId===a.id?'needle old':'needle BNEW'}]})})
  let changed=false
  const prepareSession=async(id:string)=>{
   if(id===b.id){
    const h=new SqliteAgentHistory(conn,1,Date.now,a.id)
    await h.appendBatch([{invocationId:'new-inv',turnId:'new-turn',sequence:1,schemaVersion:1,eventId:'new-event',idempotencyKey:'new-event',kind:'invocation-context-committed',payload:{messages:[{id:'a',role:'user',content:'needle NEW',timestamp:20}]}}],0)
    changed=source(a.id,a.generation)!==views.get(a.id)!.sourceIdentityJson
    await new SqliteAgentHistory(conn,1,Date.now,b.id).appendBatch([{invocationId:'new-b-inv',turnId:'new-b-turn',sequence:1,schemaVersion:1,eventId:'new-b-event',idempotencyKey:'new-b-event',kind:'invocation-context-committed',payload:{messages:[{id:'b',role:'user',content:'needle BNEW',timestamp:10}]}}],0)
    views.set(b.id,{...views.get(b.id)!,sourceIdentityJson:source(b.id,b.generation)!})
   }
   return views.get(id)
  }
  let failure:string|undefined
  try{const hits=await queries.searchPreparedMessages!({query:'needle',activeProfileId:'',limit:2,prepareSession});console.info('mixed snapshot contents',hits.map(hit=>hit.content))}catch(error){failure=(error as Error).message}
  expect(changed).toBe(true)
  expect(failure).toBe('GLOBAL_SEARCH_SOURCE_CHANGED')
 }finally{db.close()}
})
