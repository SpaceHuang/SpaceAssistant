import {it,expect,vi} from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {createHash} from 'node:crypto'
import type {DatabaseSync} from 'node:sqlite'
import {createTempDatabase} from '../database/testHelpers'
import {createSession,appendMessage} from '../database/operations'
import * as sqlite from '../database/sqliteStore'
import {SqliteAgentHistory} from '../runtime/sqliteAgentHistory'
import {readProjectionSourceIdentity} from './infrastructure/sqlite/projectionSourceIdentity'
import {readProjectionHistoryChunk} from './infrastructure/sqlite/projectionHistoryChunkReader'
it('finishes the WAL read transaction before fsyncing staged projection files',async()=>{
 const temp=createTempDatabase('audit-wal-snapshot-')
 try{
  const db=temp.db,conn=sqlite.getDbConnection(db),s=createSession(db,{name:'snapshot lifetime'}),body='x'.repeat(40*1024)
  const messages=Array.from({length:10},(_,index)=>({id:`snapshot-user-${index}`,role:'user' as const,content:body,timestamp:index+1}))
  for(const message of messages)appendMessage(db,{...message,sessionId:s.id,status:'sent'})
  await new SqliteAgentHistory(conn,1,Date.now,s.id).appendBatch([{invocationId:'snapshot-inv',turnId:'snapshot-turn',sequence:1,schemaVersion:1,eventId:'snapshot-event',idempotencyKey:'snapshot-event',kind:'invocation-context-committed',payload:{messages}}],0)
  const root=path.join(path.dirname(temp.dbPath),'stage');fs.mkdirSync(root)
  const open=sqlite.openSqliteDatabaseReadOnly;let readConn:DatabaseSync|undefined
  vi.spyOn(sqlite,'openSqliteDatabaseReadOnly').mockImplementation(p=>{const r=open(p);readConn=sqlite.getDbConnection(r);return r})
  const nativeSync=fs.fsyncSync,observed:boolean[]=[]
  vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{observed.push(Boolean(readConn?.isTransaction));nativeSync(fd)})
  const nativeWrite=fs.writeSync,writeObserved:boolean[]=[]
  vi.spyOn(fs,'writeSync').mockImplementation(((...args:Parameters<typeof fs.writeSync>)=>{writeObserved.push(Boolean(readConn?.isTransaction));return nativeWrite(...args)}) as typeof fs.writeSync)
  const result=readProjectionHistoryChunk({dbPath:temp.dbPath,sessionId:s.id,sessionGeneration:s.generation,scopeKey:'scope',specVersion:1,sourceIdentityJson:readProjectionSourceIdentity(conn,s.id,s.generation)!,connectionEpoch:1,processGeneration:1,rebuildToken:'token'},
   {afterSessionSequence:0,maxRows:1,maxBytes:256*1024,staging:{root,tempLocator:`.projection-${randomUUID()}.tmp`,tempLocators:Array.from({length:15},()=>`.projection-${randomUUID()}.tmp`)}})
  expect(result.kind).toBe('staged-chunk')
  console.info('fsync observed active WAL transaction',observed)
  expect(observed.length).toBeGreaterThan(0)
  expect(observed.some(Boolean)).toBe(false)
  expect(writeObserved.length).toBeGreaterThan(0)
  expect(writeObserved.some(Boolean)).toBe(false)
  const spillRoot=path.join(path.dirname(temp.dbPath),'spill');fs.mkdirSync(spillRoot,{recursive:true})
  const locator=`${randomUUID()}.spill`,spillBody='spill-snapshot-lifetime-sentinel'
  fs.writeFileSync(path.join(spillRoot,locator),spillBody)
  const descriptor={version:1,kind:'source-of-truth',locator,byteLength:Buffer.byteLength(spillBody),
   sha256:createHash('sha256').update(spillBody).digest('hex'),createdAt:1,head:spillBody,tail:spillBody}
  await new SqliteAgentHistory(conn,1,Date.now,s.id).appendBatch([{invocationId:'snapshot-inv',turnId:'snapshot-turn',sequence:2,
   schemaVersion:1,eventId:'snapshot-event-2',idempotencyKey:'snapshot-event-2',kind:'invocation-completed',
   payload:{status:'completed',body:{__spaceassistant_spill_v1:descriptor}}}],1)
  const nextPermit={dbPath:temp.dbPath,sessionId:s.id,sessionGeneration:s.generation,scopeKey:'scope',specVersion:1,
   sourceIdentityJson:readProjectionSourceIdentity(conn,s.id,s.generation)!,connectionEpoch:1,processGeneration:1,rebuildToken:'token-2'}
  const readNative=fs.readFileSync,spillObserved:boolean[]=[]
  vi.spyOn(fs,'readFileSync').mockImplementation(((...args:Parameters<typeof fs.readFileSync>)=>{
   if(String(args[0]).endsWith(locator))spillObserved.push(Boolean(readConn?.isTransaction))
   return readNative(...args)
  }) as typeof fs.readFileSync)
  const parseNative=JSON.parse,parseObserved:boolean[]=[]
  vi.spyOn(JSON,'parse').mockImplementation((value:Parameters<typeof JSON.parse>[0],reviver?:Parameters<typeof JSON.parse>[1])=>{
   if(typeof value==='string'&&value.includes('spill-snapshot-lifetime-sentinel'))parseObserved.push(Boolean(readConn?.isTransaction))
   return parseNative(value,reviver)
  })
  const normal=readProjectionHistoryChunk(nextPermit,{afterSessionSequence:1,maxRows:1,maxBytes:256*1024})
  expect(normal).toMatchObject({kind:'chunk',events:[{payloadJson:expect.stringContaining(spillBody)}]})
  expect(spillObserved).toEqual([false])
  expect(parseObserved.length).toBeGreaterThan(0)
  expect(parseObserved.some(Boolean)).toBe(false)
 }finally{vi.restoreAllMocks();temp.cleanup()}
})
