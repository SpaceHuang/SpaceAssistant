import { createAgentRuntime } from './agentRuntime'
import { createSecurityAuditLog, resolveSecurityAuditLogDir } from '../confirmation/audit'
import { ChatCancelRegistry } from '../chatCancelRegistry'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import { ConfirmIdSpace } from '../remote/confirmId'
import { McpConcurrencyGate } from '../mcp/mcpToolExecutor'
import { createBuiltinToolRegistry } from '../tools/builtinExecutors'

/**
 * 桌面宿主 runtime 组装(P0 修复,评审 batch3-runtime-admission-sdk-review):
 * 生产装配的唯一入口——main.ts 用它构造完整组件集,禁止空参 createAgentRuntime()
 * (空参全组件 no-op 桩:内置工具/取消/撤销/confirmId/MCP 限流/审计全部静默失效)。
 * 独立模块纪律:本模块 import builtinExecutors 大链,**不得**被六原模块(经 defaults)
 * 在模块加载期触达——只有 main.ts 与测试显式 import,无 CJS 环。
 */
export function createDesktopAgentRuntime(): ReturnType<typeof createAgentRuntime> {
  return createAgentRuntime({
    // 审计惰性构造:agentLogger 目录未就绪时降级 NOOP(与原 singleton 语义一致)
    auditFactory: () => {
      const logDir = resolveSecurityAuditLogDir()
      return logDir ? createSecurityAuditLog({ logDir }) : null
    },
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate(),
    builtinRegistry: createBuiltinToolRegistry()
  })
}
