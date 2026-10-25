import { it, expect, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { appendMessage, createSession } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { createSessionQueries } from './queries'
import type { PreparedChatBodyView } from './public/model'
it('does not inspect a broken canonical session after a full legacy result page', async () => {
 const db=createMemoryAppDb()
 try {
  const good=createSession(db,{name:'good'}), bad=createSession(db,{name:'bad'})
  appendMessage(db,{id:'good-hit',sessionId:good.id,role:'user',content:'needle',timestamp:100,status:'sent'})
  appendMessage(db,{id:'bad-old',sessionId:bad.id,role:'user',content:'',timestamp:1,status:'sent'})
  const conn=getDbConnection(db)
  conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(bad.id)
  conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id='bad-old'").run()
  const view={sessionId:bad.id,sessionGeneration:bad.generation,sourceIdentityJson:'source'} as PreparedChatBodyView
  const visited:string[]=[]
  const queries=createSessionQueries(db,{currentSourceIdentity:()=> 'source',readBodies:vi.fn(),searchBodies:vi.fn(async()=>{throw new Error('PROJECTION_CHAT_BODY_CACHE_DIGEST_MISMATCH')}),invalidate:vi.fn()})
  await expect(queries.searchPreparedMessages!({query:'needle',activeProfileId:'',limit:1,prepareSession:async (sessionId) => {visited.push(sessionId); return view}})).resolves.toMatchObject([{messageId:'good-hit'}])
  expect(visited).toEqual([])
 } finally {db.close()}
})

it('still fails when a broken canonical candidate is inside the global result window', async () => {
 const db=createMemoryAppDb()
 try {
  const broken=createSession(db,{name:'broken'})
  appendMessage(db,{id:'broken-hit',sessionId:broken.id,role:'user',content:'',timestamp:100,status:'sent'})
  const conn=getDbConnection(db)
  conn.prepare("UPDATE session_message_content_cutover SET write_mode='canonical' WHERE session_id=?").run(broken.id)
  conn.prepare("UPDATE messages SET content_storage_state='canonical-backed-only' WHERE id='broken-hit'").run()
  const view={sessionId:broken.id,sessionGeneration:broken.generation,sourceIdentityJson:'source'} as PreparedChatBodyView
  const queries=createSessionQueries(db,{currentSourceIdentity:()=> 'source',readBodies:vi.fn(),searchBodies:vi.fn(async()=>{throw new Error('PROJECTION_CHAT_BODY_CACHE_DIGEST_MISMATCH')}),invalidate:vi.fn()})
  await expect(queries.searchPreparedMessages!({query:'needle',activeProfileId:'',limit:1,prepareSession:async () => view})).rejects.toThrow('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
 } finally {db.close()}
})
