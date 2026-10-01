import { createAgentRuntime } from './agentRuntime'
import { createSecurityAuditLog, resolveSecurityAuditLogDir } from '../confirmation/audit'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { PolicyAuthorizationChangeRegistry } from './policyAuthorizationChangeRegistry'
import { ConfirmIdSpace } from '../remote/confirmId'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'
import { ApprovalAdmission } from '../../packages/agent-sdk/src/approval'
import { InvocationRuntime } from '../../packages/agent-sdk/src/scheduler'
import { ResourceLockRegistry } from '../../packages/agent-sdk/src/resourceLock'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import type { AnthropicRouteProfile } from '@spaceassistant/agent-provider-pi-ai'
import { createDesktopAnthropicProvider } from '../piAiAnthropicBridge'
import { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'

/**
 * 桌面宿主 runtime 组装(P0 修复,评审 batch3-runtime-admission-sdk-review):
 * 生产装配的唯一入口——main.ts 用它构造完整组件集,禁止空参 createAgentRuntime()
 * (空参全组件 no-op 桩:内置工具/取消/撤销/confirmId/MCP 限流/审计全部静默失效)。
 * 独立模块纪律:本模块 import builtinExecutors 大链,**不得**被六原模块(经 defaults)
 * 在模块加载期触达——只有 main.ts 与测试显式 import,无 CJS 环。
 */
export function createDesktopAgentRuntime(): ReturnType<typeof createAgentRuntime> {
  const modelProviders = new ModelProviderRegistry()
  const anthropicProfiles: AnthropicRouteProfile[] = Object.entries(MODEL_BASELINE)
    .filter(([, baseline]) => baseline.sourceProvider === 'anthropic')
    .map(([modelId, baseline]) => ({
      routeId: `desktop-anthropic-${modelId}`,
      protocol: 'anthropic-messages',
      dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1',
      modelId,
      endpoint: 'https://api.anthropic.com',
      credentialRef: `desktop-llm-service:${modelId}`,
      modelCapabilities: {
        contextWindow: baseline.maximumContext,
        maxOutputTokens: baseline.maxTokens,
        reasoning: baseline.reasoning,
        strictJsonSchema: false
      }
    }))
  const anthropicProvider = createDesktopAnthropicProvider(anthropicProfiles)
  for (const profile of anthropicProfiles) {
    modelProviders.register({
      routeId: profile.routeId,
      protocol: profile.protocol,
      dialect: profile.dialect,
      adapterVersion: profile.adapterVersion,
      modelId: profile.modelId,
      endpoint: profile.endpoint
    }, anthropicProvider)
  }
  return createAgentRuntime({
    // 审计惰性构造:agentLogger 目录未就绪时降级 NOOP(与原 singleton 语义一致)
    auditFactory: () => {
      const logDir = resolveSecurityAuditLogDir()
      return logDir ? createSecurityAuditLog({ logDir }) : null
    },
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    policyAuthorizationChanges: new PolicyAuthorizationChangeRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry(),
    approvalAdmission: new ApprovalAdmission({ concurrency: 4, queueLimit: 32, maxInFlightPerParent: 2 }),
    invocationRuntime: new InvocationRuntime('desktop-agent-runtime'),
    resourceLocks: new ResourceLockRegistry(),
    modelProviders,
    toolExecutionConcurrency: 2
  })
}
