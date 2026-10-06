# 九、组装与能力元数据

> **定位**：01–08 是设计，本篇是"从设计到实现的第一道关"——回答**谁来提供 Runtime 需要的一切**。
>
> 之所以独立成篇：现状的组装（`createAgentRuntime` / `createDesktopAgentRuntime`）与目标形态差异很大，而且**它是实施计划的前置**——不先定形状，迁移路径会悬空。

---

## 1. 现状的组装：一个"组件袋"

```ts
// packages/agent-sdk/src/runtime/createAgentRuntime.ts
export interface AgentRuntimeComponents {
  audit? / confirmIds? / chatCancels? / toolRevocations? / mcpGate? / builtinRegistry?
}
export interface AgentRuntime {
  instanceId: string
  readonly audit / confirmIds / chatCancels / toolRevocations / mcpGate / builtinRegistry
}
```

两个特征，都是要改的：

| 特征 | 问题 |
| --- | --- |
| **它是"组件容器"** | 暴露的是**组件**（`mcpGate` / `builtinRegistry`…），**不是能力**——没有 `call()` / `inspect()` / `cancel()` |
| **缺省即静默失效** | 空参构造会让限流、审计、工具全部变成 no-op 桩。`desktopAgentRuntime.ts` 的注释把这列为 P0 修复项 |

宿主侧 `createDesktopAgentRuntime()` 的工作就是"把这些组件塞满"——**结构不用改，塞的东西要换**。

---

## 2. 组装要改什么

| 项 | 现状 | 目标 |
| --- | --- | --- |
| **Runtime 是什么** | 组件袋 | **执行核心**：`call()` / `inspect()` / `explain()` / `cancel()` / `drain()` |
| **组件形态** | 机制实例：`McpConcurrencyGate`、`ApprovalAdmission`、`ResourceLockRegistry`、`toolExecutionConcurrency: 2` | **具名配额**：名字 + 容量 |
| **缺省行为** | 静默失效 | **必需件缺失 ⇒ 启动即失败**（§10） |
| **映射** | 不存在 | **新增**：`quotasOf` / `priorityOf` |

第二行是最大变化——**那四个组件实例全部退化成"配额名单里的一行"**：

| 现状入参 | 目标 |
| --- | --- |
| `mcpGate: new McpConcurrencyGate(8, 4)` | `{ name: 'mcp:global', capacity: 8 }` + `{ name: 'mcp:server:*', capacity: 4 }` |
| `approvalAdmission: new ApprovalAdmission({ concurrency: 4, … })` | `{ name: 'approval:slot', capacity: 4 }` |
| `resourceLocks: new ResourceLockRegistry()` | 名单里的一行（容量 1） |
| **`toolExecutionConcurrency: 2`** | `{ name: 'tool:concurrent', capacity: 2 }` |

---

## 3. 组装的位置：形态进 SDK，实现留宿主

```text
SDK    createRuntime(deps) 的类型 + 默认实现（最小可用 Runtime）
宿主   deps 的具体内容（配额名单、映射规则、执行器、端口）
```

**现状已经是这个分工**（`createAgentRuntime` 在 SDK；`createDesktopAgentRuntime` 在宿主、且已按"独立模块"纪律隔离以避免 CJS 环）——**所以位置不改，改的是入参形状**。

---

## 4. 装配契约（目标形状）

```ts
createRuntime({
  // 执行器：按边界类型分（§6）
  executors: Record<ExecutorKind, Executor>,

  // 具名配额（[04](./04-quota-and-guards.md) §2）——**三类**：许可 / 预算 / 租约
  permits: Array<{ name: QuotaName; capacity: number }>,
  budgets: Array<{ name: QuotaName; limit: number; consumeOn: 'start' | 'settle' }>,
  leases:  Array<{ name: QuotaName }>,          // 容量恒为 1 + 归属校验，如 session:<id>

  // 映射（[04](./04-quota-and-guards.md) §2、§10）
  capacities: CapabilityRegistry,                   // 能力元数据：谁需要什么
  quotasOf:   (req: CallRequest) => readonly QuotaName[],
  priorityOf: (scope: CallScope) => number,

  // 端口（[05](./05-extension-points.md) §7）
  facts: FactLog, snapshots?: SnapshotStore, clock: Clock,
  hooks?: Hooks, ordering?: Ordering,

  // 策略
  policy: SafetyPolicy,                             // 安全策略——它自己也能发起调用
})
```

**三个要点**：

1. **`permits` / `budgets` 是数据，不是实例**——这是与现状最本质的差别
2. **`quotasOf` / `priorityOf` 是函数**——因为声明依赖调用的输入（§5）
3. **`policy` 不是一个"判定器"，而是一个"可以发起调用的组件"**（安全审核就是它 `await runtime.call()` 的结果，见 [01](./01-positioning.md) §3）

---

## 5. 能力元数据：`requires` 是函数

```ts
type Capability = {
  name: string
  executorKind: ExecutorKind                                    // 用哪个执行器（§6）
  requires: (input: unknown, ctx: CallScope) => readonly QuotaName[] | undefined
}
```

**与现状的对应——签名已经对了**：

```ts
// electron/tools/plannedToolRegistry.ts
resourceKeys?: (input: I, context?) => readonly string[] | undefined
```

只需三件事（详见 [04](./04-quota-and-guards.md) §2「声明由谁填写」）：

1. 明确返回值是**许可名**（而非现状的 `workspace:` / `unknown:` 前缀格式）
2. 复用 `undefined` 的**保守语义**（未声明 ⇒ 未知副作用 ⇒ 占全局屏障）
3. **从"可选"提为"注册时必填"，但允许显式返回 `undefined`**（= 表态"我不知道，按保守处理"）。拦住"忘了写"，放行"故意不写"。

`quotasOf(req)` 的职责因此很薄：

```text
quotasOf(req) = capabilities.get(req).requires(req.intent.input, req.scope)
                ++ 通用规则（如所有调用都要 'call:global'）
```

---

## 6. 执行器：按"边界类型"分，不按"工具来源"分

| 边界 | ExecutorKind | 例子 |
| --- | --- | --- |
| 本机进程内 | `local` | `read_file`、`grep`、`write_file` |
| 本机子进程 | `process` | `run_shell`、`run_script`、**Skill 自带的 CLI** |
| MCP 协议 | `mcp` | MCP 工具 |
| HTTP | `http` | 模型请求、Lark CLI 之类的远端调用 |
| IPC（另一进程） | `human` | 问用户（渲染进程弹卡片） |
| **另一个 Runtime** | `agent` | 审核 Agent、SubAgent（§9） |

**归一化的位置**：

| 归一化什么 | 落在哪 | 别名 |
| --- | --- | --- |
| **怎么调**（边界适配） | **执行器** | 内置 → `builtinExecutors`；MCP → `mcpToolExecutor` |
| **要什么**（许可声明） | **能力元数据** | `requires` |

**两者互不知道**，编排层只写 `{ kind, toolName, input }`。

---

## 7. 三类能力来源

| 来源 | 注册时机 | 元数据从哪来 | 限流的默认粒度 |
| --- | --- | --- | --- |
| **内置工具** | 编译期 | 作者声明（`requires`） | `tool:concurrent` 等 |
| **MCP 工具** | 运行时（连接时**发现**） | **协议不提供** → 保守 | **`mcp:server:<id>`** |
| **Skill 的 CLI** | 运行时（**安装 / 卸载**） | `SKILL.md` frontmatter（可选 `requires`） | `skill:<name>` + `process:shell` |

**三者的共同点值得强调**：**限流都不需要语义元数据**——因为它的正确粒度总是"某个天然的归属"（工具池 / server / skill）。这是同一个结论第三次出现：

> **机制里唯一"每次调用都要过"的那个（限流），恰好是元数据需求最弱的那个。**

而缺元数据的两个（安全、互斥）各有成熟退路：安全走"不确定 → 问模型 / 问人"；互斥**默认不假设**，业务若知道就配同一个名字。

**`SKILL.md` 的 frontmatter 已有 `name` / `description` / `triggers`**，所以 `skill:<name>` 这个许可名现成可用。

---

## 8. 动态注册与生命周期

MCP 与 Skill 都要求注册表支持**运行时增删**——这是现状没有的需求：

| 事件 | 动作 |
| --- | --- |
| MCP server 连接 | 把它的工具注册进 `capabilities`（按 server 归入 `mcp:server:<id>`） |
| MCP server 断开 | 注销 |
| Skill 安装 | 注册它的 CLI 能力；并把 `SKILL.md` 纳入 context 注入的候选 |
| Skill 卸载 | 注销 |

**一条纪律**：**注销不取消在途调用**——已派发的按正常路径结算（它可能已经产生副作用，见 [06](./06-contracts.md) §6）。

**Skill 的两半要分开处理**（这是它容易被误当成一个整体的地方）：

| Skill 的组成 | 归属 | 机制 |
| --- | --- | --- |
| **文档**（`SKILL.md`） | **context 注入** | 由 `triggers` / LLM 路由决定何时注入 |
| **CLI**（若有） | **注册表条目** | 执行器 = `process` |

**而 SKILL.md 里那些 `bash` 代码块，最终是 Agent 用 `run_shell` 执行的**——所以它是**普通工具调用**，不是新的调用类型。

---

## 9. 嵌套 Agent 与 `compose`

审核 Agent 是 `kind: 'agent'` 的调用，**执行器负责"起一个内层 Runtime 并跑一个 Turn"**：

```ts
const auditRuntime = createRuntime(compose(baseDeps, {
  permits: [{ name: 'llm:audit', capacity: 2 }],   // 叠加：隔离的配额
  policy:  auditPolicy,
  prompt:  auditPrompt,
}))
```

**`compose` 是新增件**（同名覆盖、数组追加），它必须保证两件事：

| 保证 | 为什么 |
| --- | --- |
| **配额隔离** | 内层用 `llm:audit`，与主流程的 `llm:global` 分开——否则主流程占满时审核拿不到配额 ⇒ 死锁（[04](./04-quota-and-guards.md) §9） |
| **端口可共享** | 事实流与恢复是内层独立的，但 `FactLog` / `Clock` 等实现可以复用外层 |

**内层有自己的 Turn / Step / 调用 / 事实流**；外层只记录"我发起了一次调用，结果是 X"（[07](./07-failure-and-recovery.md) §5）。

---

## 10. 两条纪律

### 10.1 必需件缺失 ⇒ 启动即失败

现状的"缺省即静默失效"必须改掉：

> **必需件（执行器 / 配额 / 映射 / `FactLog`）缺失 ⇒ 启动即失败，不静默降级。**

理由很实际：静默降级会造出"**看起来在跑、其实没限流、没审计、不能恢复**"的系统——而这类问题在生产上极难发现。现状已经吃过一次（空参 `createAgentRuntime()` 的 no-op 桩）。

### 10.2 收编影子调用

"带等待却绕过框架"的宿主代码必须改为 `runtime.call()`（[08](./08-mapping-and-acceptance.md) §1 末）。它同时是**检验装配契约是否好用的第一个用例**——如果连一个影子调用都收编不顺，说明契约形状有问题。

---

## 11. 与现状文件的对位

| 现状 | 目标 |
| --- | --- |
| `packages/agent-sdk/src/runtime/createAgentRuntime.ts` | **改写**：从"组件袋"变为"执行核心 + 装配契约" |
| `electron/runtime/desktopAgentRuntime.ts` | **改写**：从"塞组件实例"变为"提供配额名单 + 映射 + 执行器" |
| `electron/tools/plannedToolRegistry.ts` 的 `RegisteredTool` | **扩展**：`resourceKeys` → `requires`（语义明确 + 提为必填）；加 `kind` |
| `electron/tools/builtinExecutors.ts` | 拆分为多个执行器（`local` / `process` / `http`…） |
| `electron/mcp/mcpToolExecutor.ts` + `electron/mcp/semaphore.ts` | 合并为 `mcp` 执行器 + 配额（三份实现合一） |
| `electron/skills/skillRouter.ts` | **影子调用** → `kind: 'skill-route'` 的调用 |
| `electron/skills/` 的 Skill 注册逻辑 | 拆为"文档注入"与"CLI 能力注册"两条 |
| `electron/runtime/callAdmissionGate.ts` | 退化为配额（`call:global` / `lane:*`）+ 判定逻辑保留 |

---

## 12. 相关

- 配额与声明：[04-quota-and-guards.md](./04-quota-and-guards.md)（§2 声明由谁填写、§10 优先级）
- 执行器接口：[05-extension-points.md](./05-extension-points.md) §2
- 调用契约：[06-contracts.md](./06-contracts.md)
- 影子调用与迁移路径：[08-mapping-and-acceptance.md](./08-mapping-and-acceptance.md)
