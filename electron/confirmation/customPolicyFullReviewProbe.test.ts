import { afterEach, expect, it, vi } from 'vitest'
import { decide } from '../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { commitDesktopPolicySnapshot, commitImPolicySnapshot } from './imPolicyStore'
import { assembleInvocation } from '../testSupport/invocationAssembler'
import { filterBuiltinToolsForApiWithApproval } from '../toolsConfigRuntime'
import { readImPolicyAuthorizationRevision, authorizeImInboundMessage } from '../remote/imInboundGuard'
import { loadEffectivePolicyRules } from './policyRulesRuntime'
import type { PolicyRule } from '../../src/shared/confirmation/types'
const facts = {toolName:'probe',actionClass:'execute',baseRiskLevel:'medium',signals:[],summary:{text:'probe'}} as const
const context = {lane:'desktop',origin:{kind:'direct-owner'},sessionId:'s',policyTier:'custom'} as const
const deps = {cache:{lookup:()=>null},config:{},migrationComplete:true}
const dbs: ReturnType<typeof createMemoryAppDb>[]=[]
function db(){const d=createMemoryAppDb('full-review');dbs.push(d);return d}
afterEach(()=>dbs.splice(0).forEach(d=>d.close()))
it('default ask wins over default allow in a custom package',()=>{
 const rules: PolicyRule[]=[{id:'allow',when:'invocation',action:'allow',reason:'a'},{id:'ask',when:'invocation',action:'ask',reason:'q'}]
 expect(decide(facts as any,context,rules,deps)).toMatchObject({type:'require-confirm',answerer:'user'})
})
it('default ask wins over automatic approval without an explicit matching override',()=>{
 const rules: PolicyRule[]=[{id:'auto',when:'invocation',action:'auto-evaluator',reason:'a'},{id:'ask',when:'invocation',action:'ask',reason:'q'}]
 expect(decide(facts as any,context,rules,{...deps,autoEvaluator:()=>({approve:true})})).toMatchObject({type:'require-confirm',answerer:'user'})
})
it('nested authorization rebuilds parent floor after persisted policy changes',()=>{
 const d=db();const conn=getDbConnection(d)
 commitDesktopPolicySnapshot(conn,{policyBehaviorVersion:'desktop-v1',snapshot:{selectedPackage:'custom',ruleOverrides:{}},updatedAt:1,eventId:'v1'})
 const floor=loadEffectivePolicyRules(d,'desktop')
 const {ports}=assembleInvocation({requestId:'r',sessionId:'s',model:'test',locale:'zh-CN',messages:[],toolsConfig:DEFAULT_TOOLS_CONFIG,appDb:d,workDir:'/tmp',userDataDir:'/tmp',getApiKey:async()=>null,emitFactEvent:vi.fn(),emitSessionEvent:vi.fn(),policyRuleFloor:floor,resolvePolicyRuleFloor:()=>loadEffectivePolicyRules(d,'desktop')})
 commitDesktopPolicySnapshot(conn,{expectedRevision:1,policyBehaviorVersion:'desktop-v1',snapshot:{selectedPackage:'custom',ruleOverrides:{'mcp-tool-ask':'allow'}},updatedAt:2,eventId:'v2'})
 expect((ports.policy as any).resolveCurrentAuthorization().effectiveRules.find((r:PolicyRule)=>r.id==='mcp-tool-ask')?.action).toBe('allow')
})
it('an old ingress approval does not survive an ask to allow to ask revision cycle',async()=>{
 const d=db();const conn=getDbConnection(d)
 const write=(action:string,n:number)=>commitImPolicySnapshot(conn,{policyBehaviorVersion:'im-v1.6',snapshot:{selectedPackage:'custom',ruleOverrides:{'ingress-direct-other-deny':action}},updatedAt:n,eventId:`im${n}`})
 write('ask',1)
 const requestApproval=vi.fn(async()=>{write('allow',2);write('ask',3);return true})
 const result=await authorizeImInboundMessage({channel:'wechat',senderId:'other',messageId:'m',getConfig:()=>({enabled:true,remoteEnabled:true,loggedIn:true,remoteSenderAllowlist:['owner']}),getPolicyRules:()=>loadEffectivePolicyRules(d,'wechat'),getPolicyRevision:()=>readImPolicyAuthorizationRevision(d),requestApproval})
 expect(result.ok).toBe(false)
})
it('exposure revoked while approval waits is not exposed by a captured rule snapshot',async()=>{
 const rules:PolicyRule[]=[{id:'im-no-wechat-send',when:'exposure',match:{lane:['wechat'],toolName:'wechat_send'},action:'ask',userOverride:true,reason:'q'}]
 let current=rules
 const tools=await filterBuiltinToolsForApiWithApproval({cfg:DEFAULT_TOOLS_CONFIG,wechat:{enabled:true} as any,remoteContext:{source:'wechat',messageId:'m'} as any,rules:current,resolveRules:()=>current,requestApproval:async()=>{current=rules.map(r=>({...r,action:'deny'}));return true}})
 expect(current[0].action).toBe('deny')
 expect(tools.some(t=>t.name==='wechat_send')).toBe(false)
})
