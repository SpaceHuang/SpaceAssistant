# Builtin Subagent 设计结论

> 状态：已确认
> 日期：2026-07-23
> 来源：基于 v3 设计文档的讨论，前置阅读 [background-task-execution-layer-design-v3.md](../requirement/background-task-execution-layer-design-v3.md) 和 [background-task-execution-layer-design.md](../requirement/background-task-execution-layer-design.md)

---

## 1. 核心架构决策

### 1.1 范式：Codex 拥有认知控制权，宿主拥有执行控制权

从旧版"静态 DAG 工作流引擎"收敛为"受控的 Codex 自治任务托管层"。

- **Codex 决定**：如何完成目标（分析、规划、执行、调整路线、内部委派、验证和修订）
- **宿主决定**：执行是否被授权、资源是否充足、副作用是否安全、结果是否耐崩溃、运行是否真正停止
- **用户确认**：目标、成功标准、权限和预算，不是一张容易过期的完整执行图

### 1.2 编排者 vs 执行者：选择 B

| 选择 | 描述 | 结论 |
|---|---|---|
| A | 把编排者搞复杂（WorkflowCompiler + DAG + Stage），适配一个更笨的 subagent | ❌ 不选。复杂编排逻辑脏，且 Codex/Claude Code/Pi 等真正能干的 Agent 用不上 |
| B | 把 subagent 做到一定能力水平，让编排者一视同仁 | ✅ 选择。编排者只负责安全边界、资源控制、取消、恢复、结果验收 |

**不恢复旧版组件**：WorkflowCompiler、Task DAG、Stage 运行时、ReadinessResolver、失败传播、ReviewLoop Controller、TaskInputBinding、Delegation 均不恢复。

---

## 2. Builtin Subagent 定位

### 2.1 是什么

builtin 是宿主的**兜底 subagent**。当用户没有安装/配置 Codex（或 Codex 不满足硬准入条件）时，系统自动使用 builtin 执行 Mission。

### 2.2 和 Codex 的关系

**对宿主来说，builtin 和 Codex 是完全相同的东西。** 宿主不区分后端。唯一差异在 `AgentRun.backend` 字段，这是一个信息标签，不参与任何调度逻辑。

| 维度 | Codex | builtin |
|---|---|---|
| 认知控制权 | ✅ | ✅ |
| 内部子 Agent 委派 | ✅ | ❌ |
| 并行探索 | ✅ | ❌ |
| 宿主数据模型 | Mission/AgentRun | 完全相同 |
| 宿主安全边界 | 相同 | 相同 |
| 用户感知 | 不暴露差异 | 不暴露差异 |

### 2.3 能力差异的缓解

| 缺失能力 | 缓解措施 |
|---|---|
| 无内部子 Agent 委派 | Intake 阶段拆成多个独立 Mission |
| 无并行探索 | 串行执行，预算给足 |
| 长任务可能迷失方向 | 宿主注入 checkpoint 自检提示 |
| 可能陷入死循环 | 宿主僵局检测 |

---

## 3. 进程模型

### 3.1 builtin 是独立子进程

builtin 作为宿主主进程的**子进程**运行，不是宿主进程内模块。

**原因：**
- 崩溃隔离：Agent 循环异常不会带崩主进程
- 资源隔离：不阻塞 Electron 主进程事件循环
- 和 Codex 架构对称：两者都是独立进程，通过 stdin/stdout 通信

### 3.2 builtin 是"薄"的

子进程只做**纯粹的推理循环**：

```
while (未完成 且 未取消) {
    请求宿主: _llm/chat(messages, tools)
    宿主返回: response (文本 + tool_calls)
    
    如果有 tool_calls:
        请求宿主: tool.execute(name, params)
        宿主返回: result
        将 result 加入 messages
    
    如果没有 tool_calls 且 response 表示完成:
        请求宿主: submit_result(...)
        宿主处理并结束
}
```

**子进程不拥有：**
- API key
- 文件系统访问
- 网络访问
- 任何工具的实际执行能力

**子进程只是"思考循环"，所有副作用由宿主执行。**

### 3.3 API key 安全

builtin 通过 `_llm/chat` RPC 请求宿主代为调用 LLM。API key 永远不离开主进程。

`_llm/chat` 安全分析：

| 攻击路径 | 需要的能力 | 严重程度 |
|---|---|---|
| 替换磁盘上的 builtin-agent 二进制 | 文件系统写入权限 | 远超白嫖 LLM——可直接改宿主代码、窃取 API key |
| 注入到运行中的 builtin-agent 子进程 | 进程内存写入权限 | 同上 |
| 从另一个进程写入 stdin 管道 | 需要 root/同用户权限 + 知道 fd | 同上 |

**结论：** `_llm/chat` 不是网络服务，攻击面等价于"子进程向父进程发送 JSON-RPC 请求"。三层防御：

1. **后端身份门**：`_llm/chat` 只对 builtin 后端暴露，Codex 等外部 Agent 永远看不到
2. **预算兜底**：消耗受 AgentRun 预算约束（已有机制）
3. **进程存活校验**：处理请求前校验子进程 PID 仍存活且是当初 spawn 的那个

---

## 4. 通信协议：ACP（Agent Client Protocol）

### 4.1 为什么选 ACP

ACP 是连接编辑器和 Agent 的标准化协议，基于 **JSON-RPC 2.0 over stdio**。选择 ACP 意味着：

- builtin 和 Codex（通过薄适配）使用**同一套协议**
- 宿主用**同一个 AgentRunHost** 驱动所有后端
- 未来任何 ACP 兼容的 Agent（Gemini CLI、Claude Agent、Pi 等）零适配接入

### 4.2 ACP 核心流程

```
initialize（版本协商 + 能力宣告）
  → session/new（cwd + 工作环境）
  → session/prompt（用户消息）
  → [session/update 循环]（Agent 流式推送：文本、工具调用、用量）
  → stopReason（end_turn / cancelled / max_tokens / refusal）
```

### 4.3 Agent 调用的 Client 方法（宿主提供的能力）

| 方法 | 用途 |
|---|---|
| `session/request_permission` | 请求用户授权工具调用 |
| `fs/read_text_file` | 读取文件（限定 worktree） |
| `fs/write_text_file` | 写入文件（限定 worktree） |
| `terminal/create` | 创建终端执行命令 |
| `terminal/kill` | 终止终端 |
| `terminal/output` | 获取终端输出 |

### 4.4 自定义扩展：`_llm/chat`

ACP 没有定义 LLM 调用方法（因为 ACP 假设 Agent 自己调 LLM）。builtin 需要通过此方法借用宿主 API key。

**参数格式：** Anthropic Messages API 格式（`messages` + `system` + `tools` + `max_tokens`）。宿主负责适配不同 LLM 后端（Anthropic / OpenAI 等），不把内部 API 差异暴露给 subagent。

**返回值：** 流式，复用 ACP 已有的 `session/update` 通知（`agent_message_chunk`）。

---

## 5. 代码组织

### 5.1 位置

放在 `electron/subagent/` 下，**不另建项目**。

```
electron/subagent/
  builtin/                  # 独立子进程，不引用 Electron 模块
    agentLoop.ts            # 纯推理循环
    acpTransport.ts         # JSON-RPC 2.0 over stdin/stdout
    index.ts                # 入口：初始化 transport → 启动 agentLoop
  host/                     # 主进程侧，管理 AgentRun
    agentRunHost.ts         # spawn / 生命周期 / cancel / drain
    llmProxy.ts             # 接收子进程 _llm/chat 请求，用宿主 key 调 API
    toolExecutor.ts         # 在 worktree 内执行子进程请求的工具
    checkpointInjector.ts   # 按预算消耗注入 checkpoint 提示
    stuckDetector.ts        # 监控工具调用模式，检测僵局
  acpTypes.ts               # 共享类型（Client↔Agent 双向方法定义）
```

### 5.2 复用现有模块

- `spawnUtil.ts`（子进程 spawn/kill）
- `toolConfirmRegistry.ts`（确认卡片）
- `pathSecurity.ts`（路径安全）
- `toolWriteConflict.ts`（写冲突）
- `agentLogger`（日志）

### 5.3 编译与打包

- 复用现有 `tsconfig.electron.json`，一次 `tsc` 编译
- `builtin/` 代码不 import 任何 Electron 模块，只依赖 Node.js 内置
- 打包时 `builtin/` 编译产物从 asar 中拆出（`asarUnpack` 或 `extraResources`）

```jsonc
// package.json build 配置
{
  "asarUnpack": [
    "**/better-sqlite3/**",
    "**/subagent/builtin/**"   // 新增
  ]
}
```

运行时路径解析：

```ts
function getBuiltinAgentPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 
      'dist-electron/electron/subagent/builtin/index.js')
  }
  return path.join(__dirname, 'subagent/builtin/index.js')
}
```

### 5.4 与现有 SubagentBackend 的关系

- **builtin 和 Codex**：走统一的 ACP AgentRunHost，不需要 `SubagentBackend` 适配
- **Claude Code**：stream-json 协议不兼容 ACP，保留现有 `SubagentBackend` 适配
- **未来**：Claude Code 支持 ACP 后可移除 `SubagentBackend`

---

## 6. Builtin 增强机制

### 6.1 Checkpoint 自检

宿主按预算消耗向 Agent 注入反思提示，保持方向感。

**触发条件**（满足任一）：
- 工具调用数达到预算的 25%、50%、75%
- 运行时间达到预算的 30%、60%、90%
- 距离上次 checkpoint 超过 30 分钟

**提示内容**（通过 ACP `session/update` 或系统消息注入）：

```
[系统提示] 进度检查点

当前消耗：已用 X 次工具调用 / Y 分钟，占预算的 Z%

请回顾：
1. 当前进度是否与 Mission 目标一致？
2. 是否有偏离或阻塞？
3. 下一步的关键行动是什么？
4. 是否需要请求用户决策？

如果偏离严重，请自行调整策略。
```

### 6.2 僵局检测

宿主监控行为模式，不监控语义。

| 信号 | 阈值 | 行为 |
|---|---|---|
| 连续工具调用失败 | ≥ 5 次 | 注入僵局警告 |
| 同一文件反复修改 | 同一路径 ≥ 8 次编辑 | 注入僵局警告 |
| 工具调用序列重复 | 相同 3 工具序列重复 ≥ 3 次 | 注入僵局警告 |
| 僵局警告后无改善 | 警告后仍触发僵局 | AgentRun 进入 waiting，请求用户决策 |

### 6.3 并行需求拆 Mission

Intake Skill 识别并行需求时，拆成多个独立 Mission。用户一次性确认，各 Mission 独立运行。

**MVP 不做 Mission 间依赖。** 汇总 Mission 的 Agent 通过 `read_mission_deliverable` 工具主动读取前序交付物。未就绪时返回错误，Agent 自行决定等待或先做其他事。

---

## 7. 与 v3 的兼容性

### 7.1 完全复用的 v3 机制

| v3 机制 | builtin 适用性 |
|---|---|
| Mission/AgentRun 数据模型 | ✅ 完全复用 |
| Generation fencing | ✅ 完全复用 |
| 取消/drain 协议 | ✅ 完全复用 |
| RecoveryBundle | ✅ 完全复用，且更简单（无内部子 Agent 部分写入） |
| RunSnapshot | ✅ 完全复用 |
| ProgressNote | ✅ 完全复用 |
| Candidate 导入 | ✅ 完全复用 |
| 独立 Review | ✅ 完全复用 |
| 私有 worktree | ✅ 完全复用 |

### 7.2 builtin 特有的 AgentRun 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `backend: 'builtin'` | - | 区分后端 |
| `checkpointEnabled` | true | 是否启用 checkpoint 自检 |
| `stuckDetectionEnabled` | true | 是否启用僵局检测 |

### 7.3 ACP `session/load` 不支持

builtin 在 `initialize` 的 `agentCapabilities` 中声明 `loadSession: false`。恢复通过宿主创建新 AgentRun + 注入 MissionRecoveryContext，和 v3 的崩溃恢复路径一致。

---

## 8. 已确认的决策清单

| # | 决策 | 结论 |
|---|---|---|
| 1 | 编排复杂度放在哪里 | 放在 subagent，不放在编排者 |
| 2 | 旧版组件是否恢复 | 不恢复（WorkflowCompiler、Task DAG、Stage 等） |
| 3 | builtin 进程模型 | 独立子进程，薄推理循环，通过 RPC 借用宿主能力 |
| 4 | 通信协议 | ACP（JSON-RPC 2.0 over stdio） |
| 5 | `_llm/chat` 参数格式 | Anthropic Messages API，宿主负责适配 |
| 6 | `_llm/chat` 安全 | 后端身份门 + 预算兜底 + 进程存活校验 |
| 7 | 代码组织 | `electron/subagent/` 下，不另建项目 |
| 8 | 打包 | `asarUnpack` 拆出 builtin 编译产物 |
| 9 | 与 SubagentBackend 关系 | builtin/Codex 走 ACP，Claude Code 保留现有适配 |
| 10 | Mission 间依赖 | MVP 不做，`read_mission_deliverable` 工具 |
| 11 | RecoveryBundle | 完全适用，不改设计 |
| 12 | `session/load` | builtin 不支持 |
| 13 | 用户感知 | 不暴露后端差异，系统自动选择 |
| 14 | Intake Skill 并行需求 | 拆成多个独立 Mission |

---

## 9. 后续步骤

1. 详细设计 `AgentRunHost`（ACP Client 侧实现）
2. 详细设计 `builtin-agent` 子进程（ACP Agent 侧实现）
3. 详细设计 `_llm/chat` 扩展的完整语义
4. 详细设计 checkpoint 注入和僵局检测的宿主实现
5. 与现有 v3 设计文档的整合（Mission Intake、AgentRun、RecoveryBundle 等）