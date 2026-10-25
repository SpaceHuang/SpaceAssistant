import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createAgentSdkSafetyPolicy } from './agentSdkSafetyPolicy'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { commitDesktopPolicySnapshot } from './imPolicyStore'
import { assembleInvocation } from '../testSupport/invocationAssembler'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { decide } from '../../src/shared/policy/policyEngine'
it.each(['allow','ask'] as const)('a live pending policy change recheck accepts new %s using the real Electron adapter',async(next)=>{
 const facts={toolName:'read_file',actionClass:'read',baseRiskLevel:'low',signals:[],summary:{text:'read'}}
 const ask={type:'require-confirm',ruleId:'r',answerer:'user',riskLevel:'low',facts,memoryTiers:[],timeoutMs:null,disposition:'human-required'}
 const evaluateGate=vi.fn().mockResolvedValueOnce({decision:ask,facts,approvedFactIds:[]}).mockResolvedValueOnce({decision:next==='allow'?{type:'auto-allow',ruleId:'r',reason:'r'}:ask,facts,approvedFactIds:[]})
 const policy=createAgentSdkSafetyPolicy({resolveGateArgs:async()=>({toolName:'read_file',toolInput:{},sessionId:'s',workDir:'/tmp',userDataDir:'/tmp',toolsConfig:{},effectiveRules:[],decisionCache:{}} as any),evaluateGate})
 const binding={requestId:'r',turnId:'t',invocationId:'r',toolCallId:'c',capabilityId:'read_file',capability:{state:'known-authorized',id:'read_file'},inputSnapshotHash:createHash('sha256').update('{}').digest('hex'),planDigest:'p',factsDigest:'f',authorizationVersion:'v1',phase:'initial-compat'} as const
 expect(await policy.evaluate(binding)).toMatchObject({kind:'ask'})
 // The old approval was cancelled by a policy change; markConfirmed must not be called.
 expect(await policy.evaluate({...binding,authorizationVersion:'v2',phase:'recheck'})).toMatchObject({kind:next})
})
it('an explicitly narrower parent authorization remains deny with unchanged persisted policy',()=>{
 const db=createMemoryAppDb('parent-boundary-review');try{
 commitDesktopPolicySnapshot(getDbConnection(db),{policyBehaviorVersion:'desktop-v1',snapshot:{selectedPackage:'custom',ruleOverrides:{'mcp-tool-ask':'allow'}},updatedAt:1,eventId:'seed'})
 const rule=DEFAULT_POLICY_RULES.find(r=>r.id==='mcp-tool-ask')!
 const {ports}=assembleInvocation({requestId:'r',sessionId:'s',model:'test',locale:'zh-CN',messages:[],toolsConfig:DEFAULT_TOOLS_CONFIG,appDb:db,workDir:'/tmp',userDataDir:'/tmp',getApiKey:async()=>null,emitFactEvent:vi.fn(),emitSessionEvent:vi.fn(),policyRuleFloor:[{...rule,action:'deny',userOverride:true}]})
 expect((ports.policy as any).resolveCurrentAuthorization().effectiveRules.find((r:any)=>r.id===rule.id)?.action).toBe('deny')
 }finally{db.close()}
})
it('automation missing MCP permission cannot be bypassed by an old allow cache',()=>{
 const facts={toolName:'mcp_tool',actionClass:'execute',baseRiskLevel:'low',signals:[{kind:'mcp-tool',serverId:'server',toolName:'tool'},{kind:'automation-mcp-permission',status:'missing'}],summary:{text:'mcp'}}
 const result=decide(facts as any,{lane:'automation',origin:{kind:'automation'},sessionId:'s'} as any,DEFAULT_POLICY_RULES,{cache:{lookup:(key:any)=>({id:'prior-allow',key,decision:'allow',lane:'*',scope:'persistent',createdAt:1,lastHitAt:1,hitCount:1,source:'user-confirm'} as any)},config:{},migrationComplete:true})
 expect(result).toMatchObject({type:'deny',ruleId:'automation-mcp-permission-missing-deny'})
})
it('a user auto-review action cannot be skipped by an old MCP allow cache',()=>{
 const facts={toolName:'mcp_tool',actionClass:'execute',baseRiskLevel:'low',signals:[{kind:'mcp-tool',serverId:'server',toolName:'tool'}],summary:{text:'mcp'}}
 const evaluator=vi.fn(()=>({approve:false}))
 const rules=DEFAULT_POLICY_RULES.map(r=>r.id==='mcp-tool-ask'?{...r,action:'auto-evaluator' as const,userOverride:true}:r)
 const result=decide(facts as any,{lane:'desktop',origin:{kind:'direct-owner'},sessionId:'s',policyTier:'custom'} as any,rules,{cache:{lookup:(key:any)=>({id:'prior-allow',key,decision:'allow',lane:'*',scope:'persistent',createdAt:1,lastHitAt:1,hitCount:1,source:'user-confirm'} as any)},config:{},migrationComplete:true,autoEvaluator:evaluator})
 expect(result).toMatchObject({type:'require-confirm',answerer:'agent'})
})

it('cancelling a synchronous channel waiter does not hide the authorization-changed outcome',async()=>{
 const {createAgentSdkConfirmationPort}=await import('./agentSdkConfirmationPort')
 let notify!:()=>void;let settle!:(x:any)=>void;let version='v1'
 const port=createAgentSdkConfirmationPort({
  createChannel:()=>({request:()=>new Promise(r=>{settle=r}),cancel:()=>settle({kind:'rejected',cause:'cancelled'})}) as any,
  publish:()=>{},cancel:()=>{},currentAuthorizationVersion:()=>version,
  subscribeAuthorizationChange:(_call,listener)=>{notify=listener;return()=>{}}
 })
 const pending=port({call:{invocationId:'r',toolCallId:'c',toolName:'mcp_tool',input:{}},confirmationId:'c',answerer:'user',reasonCode:'r',context:{facts:{toolName:'mcp_tool',actionClass:'execute',baseRiskLevel:'low',signals:[],summary:{text:'p'}},decision:{riskLevel:'low',memoryTiers:[],timeoutMs:null}}} as any)
 await Promise.resolve();version='v2';notify()
 expect(await pending).toMatchObject({kind:'authorization-changed'})
})
