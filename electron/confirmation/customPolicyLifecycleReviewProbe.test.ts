import { expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { assembleInvocation } from '../testSupport/invocationAssembler'
import { commitDesktopPolicySnapshot, commitImPolicySnapshot } from './imPolicyStore'
import { PolicyAuthorizationChangeRegistry } from '../runtime/policyAuthorizationChangeRegistry'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import { registerPolicyIpc } from '../ipc/policyIpc'
it('a pending desktop approval is invalidated when the persisted policy changes',async()=>{
 const db=createMemoryAppDb('pending-review'); const conn=getDbConnection(db)
 const runtime=getDefaultAgentRuntime(); const oldRegistry=runtime.policyAuthorizationChanges; (runtime as any).policyAuthorizationChanges=new PolicyAuthorizationChangeRegistry()
 commitDesktopPolicySnapshot(conn,{policyBehaviorVersion:'desktop-v1',snapshot:{selectedPackage:'custom',ruleOverrides:{'mcp-tool-ask':'ask'},legacyDesktopPolicyDataMigrated:true},updatedAt:1,eventId:'old'})
 const {agentSdk}=assembleInvocation({requestId:'pending',sessionId:'s',model:'test',locale:'zh-CN',messages:[],toolsConfig:DEFAULT_TOOLS_CONFIG,appDb:db,workDir:'/tmp',userDataDir:'/tmp',getApiKey:async()=>null,emitFactEvent:vi.fn(),emitSessionEvent:vi.fn()})
 let finish!: (x:any)=>void; const cancel=vi.fn(); const publish=vi.fn()
 const confirmation=agentSdk.createConfirmationPort({evaluate:vi.fn(),markConfirmed:vi.fn()} as any,{cancel,publish,createChannel:()=>({request:()=>new Promise(r=>{finish=r}),cancel}) as any})
 const pending=confirmation({call:{invocationId:'pending',toolCallId:'call',toolName:'mcp_tool',input:{}},confirmationId:'call',answerer:'user',reasonCode:'mcp-tool-ask',context:{lane:'desktop',facts:{toolName:'mcp_tool',actionClass:'execute',baseRiskLevel:'medium',signals:[],summary:{text:'p'}},decision:{riskLevel:'medium',memoryTiers:[],timeoutMs:null,answerer:'user'}}} as any)
 try {
  await Promise.resolve();expect(publish).toHaveBeenCalledOnce()
  commitDesktopPolicySnapshot(conn,{expectedRevision:1,policyBehaviorVersion:'desktop-v1',snapshot:{selectedPackage:'custom',ruleOverrides:{'mcp-tool-ask':'allow'},legacyDesktopPolicyDataMigrated:true},updatedAt:2,eventId:'new',onCommitted:()=>getDefaultAgentRuntime().policyAuthorizationChanges.publish('desktop')})
  await Promise.resolve();expect(cancel).toHaveBeenCalled()
 }finally{finish({kind:'rejected',cause:'cancelled'});await pending;(runtime as any).policyAuthorizationChanges=oldRegistry;db.close()}
})
it('IM rule edits retain rule and before/after action metadata in audit',async()=>{
 const db=createMemoryAppDb('audit-review');const conn=getDbConnection(db)
 try{
 commitImPolicySnapshot(conn,{policyBehaviorVersion:'im-v1.6',snapshot:{selectedPackage:'custom',ruleOverrides:{}},updatedAt:1,eventId:'seed'})
 const handlers=new Map<string,any>();registerPolicyIpc({handle:(c:string,f:any)=>handlers.set(c,f)} as any,db)
 await handlers.get('policy:write')({}, {lane:'wechat',expectedRevision:1,change:{kind:'rule-override',ruleId:'mcp-tool-ask',action:'deny'}})
 const event=JSON.parse((conn.prepare("select event_json from policy_audit_events where event_id!='seed'").get() as any).event_json)
 expect(event).toMatchObject({ruleId:'mcp-tool-ask',beforeAction:'ask',afterAction:'deny'})
 }finally{db.close()}
})
