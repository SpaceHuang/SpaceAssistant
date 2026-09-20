import { createAgentRuntime } from './runtime/agentRuntime'
import { setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { ConfirmIdSpace } from './remote/confirmId'
import { ChatCancelRegistry } from './chatCancelRegistry'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { McpConcurrencyGate } from './mcp/mcpToolExecutor'

/**
 * electron 项目测试装配(P8):每个测试文件加载时装配默认 runtime(真组件类——
 * 兼容转发的联动语义,如 cancel→toolConfirm 广播、builtin 注册表解析,在测试中同样生效;
 * 生产由 main.ts 装配 db 化准入状态)。
 * 纪律:本文件先于测试文件 mock 注册加载,不得 import 重链(如 builtinExecutors——
 * 其 442 文件闭包含 ipcShared 等,会抢先真实实例化致 vi.mock('electron') 失效);
 * 需要 builtin registry 的测试在文件内显式 createBuiltinToolRegistry() 注入。
 * 审计未注入 → agentLogger 未初始化时降级 NOOP。
 */
setDefaultAgentRuntime(
  createAgentRuntime({
    confirmIds: new ConfirmIdSpace(),
    chatCancels: new ChatCancelRegistry(),
    toolRevocations: new ToolRevocationRegistry(),
    mcpGate: new McpConcurrencyGate()
  })
)
