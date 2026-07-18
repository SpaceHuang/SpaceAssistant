# CLI Subagent 集成（Claude Code / Codex）- 产品需求规格

**版本：** 1.8
**日期：** 2026-07-12
**状态：** 草案 / 待评审
**关联文档：**
- [claude-codex-integration.md](../references/claude-codex-integration.md)（参考实现：Multica 统一 Backend 调用 Claude Code / Codex）
- [tools-requirement.md](./tools-requirement.md)（主 Agent 工具体系）
- [confirmation-card-trust-requirement.md](./confirmation-card-trust-requirement.md)（工具确认卡片与信任机制）
- [shell-command-tool-requirement.md](./shell-command-tool-requirement.md)、[shell-security-enhancement-requirement.md](./shell-security-enhancement-requirement.md)（命令执行确认）
- [llm-multi-service-model-config-requirement.md](./llm-multi-service-model-config-requirement.md)（主 Agent 的 LLM 服务与模型池）

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-07-11 | 初稿：定位 Subagent 委派模式；第一期 Claude Code + Codex；工具授权可配置 |
| 1.1 | 2026-07-11 | OQ-1 已决：采用统一 `dispatch_subagent` 工具（参数选引擎），不分立两个工具 |
| 1.2 | 2026-07-11 | 明确 Subagent 无状态（D9）：移除线程续接机制，上下文由主 Agent 维护 |
| 1.3 | 2026-07-11 | OQ-2 已决（D10）：多任务编排按依赖动态串/并行，编排方法论以 Skill 承载 |
| 1.4 | 2026-07-11 | 加 N8 总约束（不改 CLI）；§7 进度信息改为来源核对；§8.2 工具授权适配 CLI 工具集；§11.5 日志方案明确主进程记录；OQ-2 定稿（D11 摘要级持久化） |
| 1.5 | 2026-07-11 | §8 扩展为「工具授权与用户问询」：新增问询卡片、分 CLI 能力表（Codex 可转交 / Claude 待验证）、问询验收与日志事件 |
| 1.6 | 2026-07-11 | OQ-2/OQ-3 定稿（D13 本期仅主 Agent 自主委派、D14 文件变更仅展示）；所有开放问题已决 |
| 1.7 | 2026-07-11 | 一致性清理：清除正文与 D 项中失效的 OQ 编号引用；§5.5 并发描述对齐 §11.4；§9.1/§7.3/§16.3 补问询态 |
| 1.8 | 2026-07-12 | 技术验证结论回填（见 [验证计划](../develop/cli-subagent-integration-verification-plan.md)）：Claude Code `-p` stream-json 模式无 control_request、工具自动执行，**授权降级为 observe-only**（confirm 退化为「禁高危工具 + 观察」，逐次确认仅 Codex 支持，新增 D15、更新 §5.4/§8.1/§8.4/§16.4）；Claude 问询**已验证不通过**（`-p` 模式工具集不含 AskUserQuestion）、本期不实现（D12 更新、§8.5 修订）；`maxTurns` 对 Claude 无 CLI 支持（v2.1.207 无 `--max-turns`，§6.2 标注） |

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [目标与非目标](#3-目标与非目标)
4. [概念模型](#4-概念模型)
5. [Subagent 配置（设置页）](#5-subagent-配置设置页)
6. [主 Agent 委派能力](#6-主-agent-委派能力)
7. [执行过程展示](#7-执行过程展示)
8. [工具授权与用户问询](#8-工具授权与用户问询)
9. [结果回收与主流程衔接](#9-结果回收与主流程衔接)
10. [无状态与上下文](#10-无状态与上下文)
11. [安全与边界](#11-安全与边界)
12. [跨平台](#12-跨平台)
13. [数据模型与存储](#13-数据模型与存储)
14. [用户故事与典型流程](#14-用户故事与典型流程)
15. [i18n 文案规划](#15-i18n-文案规划)
16. [验收标准](#16-验收标准)
17. [已决事项与待确认](#17-已决事项与待确认)
18. [相关文件](#18-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 当前以 **HTTP API 直连**的方式驱动主 Agent（Anthropic Claude 兼容 API）：用户消息经主进程发往 LLM，模型在工具循环（`toolChatLoop`）中自主调用内置工具（`read_file` / `edit_file` / `grep` / `run_script` 等），主进程执行工具、渲染进程展示过程与结果。

与此同时，业界出现了以 **本地 CLI**形态运行的编码 Agent（Claude Code、Codex 等）。它们自带完整的工具集（读写文件、运行命令、搜索、甚至浏览器操作）、多轮自主执行能力与会话/线程恢复能力，适合独立完成一个**有明确边界的子任务**。参考实现 [claude-codex-integration.md](../references/claude-codex-integration.md) 证明了：通过统一的子进程调用抽象，可以同构地驱动 Claude Code（stream-json）与 Codex（JSON-RPC 2.0）。

### 1.2 产品定位（核心）

本需求引入 **CLI Subagent 委派**机制：

> **主 Agent（HTTP API）不替换**。主 Agent 在自己的工具循环中，把一个**子任务**委派给某个 CLI Subagent（Claude Code 或 Codex）；Subagent 在本地启动 CLI 子进程自主执行，主 Agent 与用户**实时观察其执行过程**；Subagent 完成后**回收结果**，主 Agent **继续推进自己的流程**。

三句话定位：

| 维度 | 说明 |
|------|------|
| **谁是主** | 主 Agent（现有 HTTP API Claude）始终是编排者，负责理解用户意图、拆解任务、整合结果 |
| **谁是 Subagent** | Claude Code、Codex 作为"被委派的执行者"，承接主 Agent 交付的子任务 |
| **关系** | 委派 ≠ 替换。HTTP API 主链路保持不变，Subagent 是主 Agent **新增的一类工具能力** |
| **第一期范围** | Claude Code + Codex 同时支持，二者在统一抽象下对主 Agent 透明 |

### 1.3 用户价值

| # | 价值 | 说明 |
|---|------|------|
| V1 | **借力成熟编码 Agent** | 复用 Claude Code / Codex 已有的强大工具集与多轮执行能力，主 Agent 无需自建即可处理复杂本地子任务 |
| V2 | **分工编排** | 主 Agent 擅长规划与整合，Subagent 擅长埋头执行；二者协作完成超出单方能力的任务 |
| V3 | **过程可见可控** | 用户能"看着"Subagent 执行，对其工具调用可确认或放行，不会盲跑 |
| V4 | **多引擎可选** | 同一任务可委派给不同 Subagent（Claude Code 或 Codex），按场景择优 |
| V5 | **零迁移** | 现有 HTTP API 用户与配置完全不受影响，Subagent 是纯增量能力 |

### 1.4 术语

| 术语 | 含义 |
|------|------|
| **主 Agent** | SpaceAssistant 现有的、由 HTTP API 驱动的对话 Agent，负责编排 |
| **CLI Subagent / Subagent** | 通过本地 CLI 子进程驱动的执行型 Agent（本期：Claude Code、Codex） |
| **委派（Dispatch）** | 主 Agent 调用"委派工具"，把子任务交给 Subagent 执行的一次动作 |
| **委派生命周期** | 交付任务 → 启动 Subagent → 流式执行 → 回收结果 → 主 Agent 继续 |
| **Subagent 线程** | Subagent 内部的会话标识（Claude session_id / Codex threadId）；产品层面不暴露、不续接，仅供排障（见 D9） |
| **内置工具** | SpaceAssistant 主进程自带的工具（read_file / run_script 等） |
| **Subagent 自带工具** | CLI Agent 内部具备的工具（其读写文件、运行命令等），由 CLI 自身执行 |

---

## 2. 现状分析

### 2.1 主 Agent 工具循环（`toolChatLoop`）

| 维度 | 现状 |
|------|------|
| 调用方式 | HTTP API 直连 LLM，模型返回 `tool_use`，主进程执行工具 |
| 内置工具 | `read_file` / `edit_file` / `write_file` / `list_directory` / `grep` / `run_script`（Python） |
| 工具执行体 | 主进程直接执行（文件操作 / 脚本执行） |
| 工具调用展示 | `ToolUseData` + 状态机（calling / confirming / executing / completed / failed / rejected） |
| 确认机制 | 聊天窗口内嵌确认卡片，按风险等级（low / medium / high）与信任机制 |
| 工作目录边界 | 文件操作不可超出会话工作目录（`pathSecurity`） |
| MCP | 现状不支持（[tools-requirement.md](./tools-requirement.md) 明确为后续迭代） |

### 2.2 与本需求的关系

- 主 Agent 的 HTTP API 链路、工具循环、确认卡片、模型池等**全部保持不变**。
- 本需求新增**一类工具**：`dispatch_subagent`。其"执行体"不是主进程直接操作，而是**启动 CLI 子进程**并把任务交给 Subagent。
- 该工具与现有 `run_script`（执行体=Python 子进程、实时输出、需确认）**同构**，可复用现有的子进程执行、流式回传、确认卡片、工具卡片展示等产品模式，只是执行体换成 CLI Agent 且内部多轮。

### 2.3 现有能力差距

| 差距 | 影响 |
|------|------|
| 无本地 CLI Agent 调用能力 | 无法借助 Claude Code / Codex 的成熟工具集与多轮执行 |
| 无 Subagent 配置入口 | 无法管理 CLI 路径、模型、思考级别、授权策略 |
| 无嵌套执行流展示 | 无法呈现 Subagent 内部的多轮工具调用与思考 |
| 无多任务编排 | 复杂任务无法拆解为多个子任务并行/串行委派（见 §6.4） |

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | 主 Agent 可在工具循环中调用**委派工具**，把子任务交给 Claude Code 或 Codex Subagent 执行 |
| G2 | Subagent 在本地启动 CLI 子进程自主执行；执行过程（文本 / 工具调用 / 思考）按 CLI 输出事件流**实时解析并展示**（粒度取决于 CLI，见 §7.2） |
| G3 | Subagent 完成后**回收结果**（最终输出、状态、token 用量、文件变更摘要），作为工具结果交还主 Agent，主 Agent 据此继续推进 |
| G4 | 设置页提供 **Subagent 配置**：CLI 安装检测、版本校验、默认模型、思考级别、工具授权策略、超时 |
| G5 | Subagent 自带工具的执行授权**可配置**：默认沿用确认卡片机制，可切换"自动批准"以无人值守 |
| G6 | 支持**多任务编排**：主 Agent 按子任务依赖动态决定串/并行委派（见 §6.4） |
| G7 | 安全边界清晰：Subagent 在受控工作目录内执行、进程隔离、环境变量过滤、超时回收 |
| G8 | 跨平台：Windows / macOS / Linux 均可运行，Windows 下不弹出控制台窗口 |
| G9 | 委派记录持久化到消息历史，历史会话回看可见完整 Subagent 执行过程 |

### 3.2 非目标

| # | 非目标 | 说明 |
|---|--------|------|
| N1 | **不替换主 Agent HTTP API** | Subagent 是主 Agent 的工具，不是新的主链路 |
| N2 | **不提供用户与 Subagent 直接对话的独立聊天渠道** | Subagent 不作为独立会话类型；用户通过主 Agent 间接使用（可经消息意图影响委派选择） |
| N3 | **不为 Subagent 配置独立 MCP** | 现状无 MCP；本期 Subagent 使用其 CLI 默认工具集，不注入额外 MCP 配置 |
| N4 | **不接入飞书远程 / Skill 路由 / 标题生成等旁路** | 本期仅主聊天工具循环支持委派；其他模块仍走 HTTP API |
| N5 | **不实现 Subagent 的自定义工具注册 / Hooks** | 沿用 CLI 自带能力 |
| N6 | **不提供 Subagent 配置的导入/导出** | 首版不做 |
| N7 | **不承诺 Subagent 调用的 LLM 计费归并到主 Agent 账号** | Subagent 使用各自 CLI 的鉴权与计费，与主 Agent HTTP API Key 无关 |
| N8 | **不修改 Claude Code / Codex 代码** | CLI 作为第三方子进程被调用，仅被动输出事件流；所有解析、映射、记录、编排逻辑均在主 Agent（主进程 + 主 Agent LLM）侧完成，不依赖 CLI 配合或改造 |

---

## 4. 概念模型

### 4.1 主 Agent / Subagent 协作关系

```
┌──────────────────────────────────────────────────────────────┐
│  用户                                                        │
│   │ 消息                                                     │
│   ▼                                                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  主 Agent（HTTP API Claude，现有 toolChatLoop）          │ │
│  │  · 理解意图 / 拆解任务 / 整合结果                        │ │
│  │  · 可调用：内置工具（read_file / run_script / …）       │ │
│  │  · 可调用：委派工具 dispatch_subagent  ◄── 本需求新增   │ │
│  └────────────┬──────────────────────────┬─────────────────┘ │
│               │ 内置工具执行             │ 委派子任务         │
│               │ （主进程直接做）         ▼                    │
│               │            ┌──────────────────────────────┐  │
│               │            │  CLI Subagent（本地子进程）  │  │
│               │            │  · Claude Code  或  Codex    │  │
│               │            │  · 自带工具集，多轮自主执行  │  │
│               │            │  · 流式回传过程              │  │
│               │            └──────────────┬───────────────┘  │
│               │                           │ 回收结果          │
│               │           ◄───────────────┘                  │
│               │  主 Agent 拿到结果，继续推进自己的流程        │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 委派生命周期

```
[主 Agent 决定委派]
        │
        ▼
[1. 交付任务]  主 Agent 调用 dispatch_subagent，传入任务描述 + 参数
        │
        ▼
[2. 启动 Subagent]  主进程启动 CLI 子进程（Claude Code / Codex）
        │              · 工作目录、模型、思考级别、授权策略就绪
        ▼
[3. 流式执行]  Subagent 自主多轮执行（文本 / 工具调用 / 思考）
        │              · 过程实时推送 UI（用户"看着"）
        │              · 工具调用按授权策略：确认 or 自动批准
        ▼
[4. 回收结果]  Subagent 完成 → 回收最终输出 / 状态 / token / 文件变更
        │
        ▼
[5. 主 Agent 继续]  结果作为 tool_result 返回主 Agent → 继续推理
```

### 4.3 Subagent 类型（第一期）

| Subagent | 底层 CLI | 模型来源 | 思考级别 | 状态 |
|----------|----------|----------|----------|------|
| **Claude Code** | `claude` CLI | 静态模型列表 | low / medium / high / xhigh / max（按模型支持） | 无状态 |
| **Codex** | `codex` CLI（app-server） | 动态发现（`codex debug models`） | reasoning effort | 无状态 |

> 二者在产品层面对主 Agent 与用户**透明**：主 Agent 只需选择"委派给谁"，底层协议差异由实现层屏蔽。Subagent 每次被委派均为独立调用，不保留跨调用上下文（见 D9）。

---

## 5. Subagent 配置（设置页）

### 5.1 入口与结构

设置弹窗新增 **「Subagent」Tab**（与「通用 / 大模型 / 工具 / Skill」并列）。Tab 内按 Subagent 类型分区，第一期两张卡片：**Claude Code**、**Codex**。

```
┌─ Subagent Tab ──────────────────────────────────────────────┐
│ 说明文案：Subagent 由主 Agent 在对话中按需委派子任务。       │
│ 每个 Subagent 使用本地安装的 CLI 自主执行；其工具调用可按     │
│ 策略确认或自动批准。Subagent 使用各自 CLI 的鉴权，与上方     │
│ 大模型服务的 API Key 无关。                                  │
│                                                             │
│ ┌─ Claude Code ────────────────────────────────────────┐   │
│ │ [✓] 启用                                              │   │
│ │ 状态：● 已安装  v2.1.3（满足 ≥ 2.0.0）   [重新检测]   │   │
│ │ CLI 路径：[claude_______________] [自动检测]          │   │
│ │ 默认模型：[Claude Sonnet 5 ▼]                         │   │
│ │ 默认思考级别：[medium ▼]（随模型可用级别动态）         │   │
│ │ 工具授权：(●) 确认后执行  ( ) 自动批准                │   │
│ │ 执行超时：[30] 分钟    无活动超时：[10] 分钟          │   │
│ └───────────────────────────────────────────────────────┘   │
│ ┌─ Codex ──────────────────────────────────────────────┐   │
│ │ [✓] 启用                                              │   │
│ │ 状态：● 未安装  （未在 PATH 中找到 codex） [重新检测] │   │
│ │ CLI 路径：[_______________] [自动检测]                │   │
│ │ 默认模型：[（待 CLI 安装后自动发现）▼]                 │   │
│ │ 默认思考级别：[medium ▼]                               │   │
│ │ 工具授权：(●) 确认后执行  ( ) 自动批准                │   │
│ │ 执行超时：[30] 分钟    无活动超时：[10] 分钟          │   │
│ └───────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 CLI 安装检测与版本校验

| 需求点 | 描述 |
|--------|------|
| 检测触发 | 进入 Subagent Tab 时自动检测；提供「重新检测」按钮手动触发 |
| 检测方式 | 执行 `<cli> --version`，提取版本号；Windows 下跳过 npm shim 的无关输出行 |
| 状态展示 | ● 已安装（绿色，含版本号） / ● 未安装（灰色，提示未在 PATH 找到） / ● 版本过低（橙色，含当前与最低要求版本） |
| 最低版本 | Claude Code ≥ 2.0.0；Codex ≥ 0.100.0（app-server stdio 模式所需）；版本过低时**禁用启用开关**并提示升级 |
| CLI 路径 | 默认自动检测 PATH；允许手动填写绝对路径（用于 nvm/fnm/volta 等非默认安装位置） |
| 未安装可用性 | Subagent 未安装或版本过低时，该 Subagent **不可被委派**；主 Agent 的委派工具仍可调用但会返回明确错误（见 §9.3） |

### 5.3 模型与思考级别

| 需求点 | 描述 |
|--------|------|
| 模型列表来源 | Claude Code：静态模型列表；Codex：动态发现（需 CLI 已安装且版本支持） |
| 模型发现失败 | 回退到内置静态列表；列表为空时下拉显示空态并提示「请先安装/升级 CLI」 |
| 默认模型 | 用户为每个 Subagent 选定一个默认模型；委派时未指定则用默认 |
| 思考级别 | 按所选模型实际支持的级别动态过滤；不支持思考级别的模型禁用该下拉 |
| 缓存 | 模型与思考级别发现结果做短期缓存，CLI 版本变化后失效重发现 |

### 5.4 工具授权策略（Subagent 级）

| 策略 | 含义 |
|------|------|
| **确认后执行**（默认推荐） | Subagent 自带工具的调用走现有确认卡片机制；高危工具必确认，低危可信任 |
| **自动批准** | Subagent 内部工具调用一律放行（等价 bypassPermissions），仅可视化展示不拦截 |

- 每个 Subagent 独立配置，互不影响。
- 主 Agent 单次委派可在工具参数中**临时覆盖**该策略（见 §6.2）。
- 「自动批准」开启时，卡片需显示醒目提示，告知用户 Subagent 将无人值守执行本地操作。
- **引擎差异（D15，技术验证结论）**：`confirm` 的「逐次确认」**仅 Codex 支持**（Codex 经 server-request 发起工具授权请求，可转交用户）。Claude Code 在 `-p` stream-json 模式下不发授权请求、工具自动执行，**无逐次确认能力**；其 `confirm` 退化为「`--disallowedTools` 粗粒度禁用高危工具（如 PowerShell/Bash/Write/Edit）+ 观察执行过程」，`auto` 为纯观察。设置页与委派卡片须醒目区分两引擎的 `confirm` 语义。

### 5.5 超时与资源

| 项 | 默认 | 说明 |
|----|------|------|
| 执行超时 | 30 分钟 | 单次委派的绝对时限；到点终止 Subagent 并标记超时 |
| 无活动超时 | 10 分钟 | Subagent 长时间无任何语义活动（无文本/工具/状态）则判定卡死并终止 |
| 首轮无进度超时 | 30 秒 | 启动后迟迟未收到首个有效事件则快速失败（便于排障） |
| 并发委派 | 见 §11.4 | 限制全局同时运行的 Subagent 数量（按依赖动态串/并行，全局上限保护） |

---

## 6. 主 Agent 委派能力

### 6.1 委派工具定义

向主 Agent 注册**一个统一的委派工具**（统一工具，由参数选择引擎）：

| 项 | 内容 |
|----|------|
| 工具名 | `dispatch_subagent` |
| 描述（给主 Agent） | 把一个有明确边界的子任务委派给本地 CLI Subagent（Claude Code 或 Codex）自主执行。适用于需要多步文件操作/命令执行/代码搜索的复杂子任务。工具会启动 Subagent、实时回传执行过程、并在完成后返回最终结果。 |
| 适用场景提示 | "重构某模块""在仓库中定位并修复某类问题""实现某个独立函数并自测"等可独立交付的子任务 |
| 不适用提示 | 单次文件读取、单条命令执行等轻量操作应直接用内置工具，不必委派 |

> **工具形态**：采用单一 `dispatch_subagent` 工具，由 `agent` 参数选择 Claude Code 或 Codex。主 Agent 只需学习一个工具接口，引擎差异由参数屏蔽；不分立 `dispatch_claude_code` / `dispatch_codex` 两个工具。

### 6.2 委派参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent` | `"claude_code" \| "codex"` | 是 | 目标 Subagent；未安装/未启用时返回错误 |
| `task` | string | 是 | 交付给 Subagent 的子任务描述（自然语言 prompt） |
| `cwd` | string | 否 | Subagent 工作目录；默认主会话工作目录；必须在工作目录允许范围内（见 §11.1） |
| `model` | string | 否 | 指定模型；缺省用该 Subagent 的默认模型 |
| `thinkingLevel` | string | 否 | 覆盖默认思考级别；须为该模型支持的级别 |
| `toolApproval` | `"confirm" \| "auto"` | 否 | 临时覆盖该 Subagent 的工具授权策略 |
| `timeoutMinutes` | number | 否 | 临时覆盖执行超时 |
| `maxTurns` | number | 否 | 限制 Subagent 最大执行轮次。**Codex 生效**；Claude Code 无对应 CLI 旗标（v2.1.207 无 `--max-turns`），对 Claude 为 no-op，靠执行/无活动超时兜底 |

### 6.3 委派触发与执行流

1. 主 Agent 在推理中调用 `dispatch_subagent`，传入 `agent` + `task` + 可选参数。
2. 主进程校验：目标 Subagent 是否启用/已安装/版本达标；`cwd` 是否合法；超时与授权策略合并。
3. 主进程启动对应 CLI 子进程，注入任务（每次均为全新独立调用，不续接历史）。
4. Subagent 自主多轮执行；过程事件实时映射为流式增量推送（见 §7）。
5. Subagent 内部工具调用按 `toolApproval` 策略：`confirm` → 触发确认卡片；`auto` → 放行。
6. Subagent 完成或异常终止 → 回收结果（见 §9）。
7. 结果作为 `tool_result` 返回主 Agent → 主 Agent 继续工具循环。

### 6.4 多任务编排与并发

主 Agent 在处理一个复杂任务时，可能拆解出多个子任务并分别委派给 Subagent。其串/并行调度**不固定**，由主 Agent 根据子任务间的依赖关系动态决定：

| 子任务关系 | 调度策略 |
|-----------|---------|
| 无依赖 | **并行**：主 Agent 在一轮内并行发起多个 `dispatch_subagent`，多个 Subagent 同时运行 |
| 有依赖 | **串行**：主 Agent 先发起前置子任务，等其结果回收后，再发起依赖该结果的后续子任务 |

**编排逻辑由 Skill 承载（不硬编码于主进程）：**

- 内置一个「Subagent 任务编排」Skill，描述如何拆解任务、判断子任务依赖、决定串/并行、汇总结果的方法论。
- 该 Skill 经现有 Skill 路由机制加载后，作为指导注入主 Agent 的 system prompt；由主 Agent（LLM）自行执行编排决策，主进程不内置调度器。
- 用户可在 Skill 管理界面查看、禁用或自定义该编排 Skill（与普通 Skill 一致）。

**并发能力与保护：**

- 主进程支持同一主会话内多个 Subagent 并发运行，并支持主 Agent 单轮内并行发起多个委派。
- 并发受全局上限保护（见 §11.4），超限时后续委派排队，避免资源失控。

---

## 7. 执行过程展示

### 7.1 Subagent 执行卡片

委派在主对话流中以**「Subagent 执行卡片」**呈现，与现有工具调用卡片同层级，但支持**嵌套展开**内部执行流。

```
┌─ 🤖 Subagent · Codex · gpt-5.5 · 进行中 ───────────────────┐
│ 任务：在 src/utils 下找到所有未处理的 Promise rejection 并修复│
│ ───────────────────────────────────────────────────────── │
│ ▼ 执行过程（展开）                                          │
│   ┌─ 思考 ───────────────────────────────────────────┐    │
│   │ 我先搜索 catch 缺失的调用点…                     │    │
│   └──────────────────────────────────────────────────┘    │
│   ┌─ 工具 · grep ────────────────────────── ✓ 完成 ┐     │
│   │ 模式：\.then\(  路径：src/utils                  │     │
│   │ → 命中 7 处                                     │     │
│   └─────────────────────────────────────────────────┘     │
│   ┌─ 工具 · edit_file · requestHandler.ts  ⏸ 待确认 ┐    │
│   │ diff：+ try { … } catch (e) { … }               │    │
│   │      [批准] [拒绝] [信任此类操作]                │    │
│   └─────────────────────────────────────────────────┘    │
│   …（实时追加）                                            │
│ ───────────────────────────────────────────────────────── │
│ ⏱ 已用 02:15 · 🔤 入 1.2k / 出 3.4k · 📁 改 2 文件        │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 流式内容展示与来源约束

**总原则（见 N8）：进度信息不是"我们决定展示什么"，而是"主进程能从 CLI 输出事件流里解析出什么就展示什么"。CLI 不额外上报、我们不改它；不假设 CLI 提供其未提供的信息（如进度百分比），用状态机诚实表达进度。**

| 信息项 | 来源 | 受 CLI 输出约束 / 降级 |
|--------|------|----------------------|
| 委派元信息（类型/模型/task/cwd/授权） | 主进程自有 | 无（启动时即有） |
| 状态机（排队/运行中/待确认/等待用户输入/完成/失败/超时/已终止） | 主进程维护 | 无（按解析到的事件推进） |
| 已用时间 | 主进程计时 | 无 |
| Subagent 文本输出 | 解析 CLI 事件 | **粒度由 CLI 决定，按事件流增量展示，不保证逐字**；超长折叠 |
| Subagent 思考 | 解析 CLI 事件 | **取决于模型/CLI 是否输出**（Claude thinking、Codex reasoning）；无则该维度不展示 |
| 内部工具调用（名/参数/状态/结果） | 解析 CLI 事件 | 字段结构取决于 CLI（Claude tool_use/tool_result、Codex tool 事件各不同） |
| 工具授权确认（含 diff） | 解析 CLI approval 请求 | **仅 Codex 产生**（Claude Code `-p` 模式无 approval 请求，D15）；diff 仅当 CLI 给出变更结构（如 Codex applyPatch 的 patch），否则降级为工具参数展示 |
| token 用量 | 解析 CLI usage 事件 | **口径取决于 CLI**（字段名/是否含缓存，Claude 与 Codex 不同），归一化展示 |
| 文件变更列表 | 解析 CLI 变更事件或从工具调用流推断 | **CLI 可能不输出结构化变更；从写入类工具推断可能不完整** |
| 终止入口 | 主进程杀进程 | 无 |

> 缺失字段不阻断展示：某维度 CLI 未输出时，对应区域隐藏或显示"无"，不报错。

### 7.3 折叠与降噪

- 卡片默认**收起为摘要态**（标题 + 状态 + 一行任务概要 + 用量），点击展开完整执行过程。
- 进行中且存在“待确认”工具或用户问询时，卡片自动展开并高亮待处理项。
- 历史会话回看时，卡片为只读完成态，可展开查看过程。

### 7.4 与现有工具卡片的区别

| 维度 | 现有工具卡片 | Subagent 执行卡片 |
|------|--------------|-------------------|
| 执行体 | 主进程直接操作 | CLI 子进程自主多轮 |
| 内容 | 单次工具调用 | 嵌套多轮（文本 / 思考 / 多个子工具） |
| 确认 | 工具级确认 | Subagent 内部工具级确认（复用同机制） |
| 结果 | 工具返回值 | Subagent 最终输出 + 用量 + 文件变更 |

---

## 8. 工具授权与用户问询

### 8.1 授权策略执行

Subagent 自带工具（读写文件、运行命令等）的授权，按该 Subagent 配置的 `toolApproval` 策略（可被单次委派覆盖）执行。**按引擎分流（D15，技术验证结论）**：`-p` stream-json 模式下 Claude Code 不发授权请求、工具自动执行，逐次确认**仅 Codex 支持**。

| 引擎 | 策略 | 行为 |
|------|------|------|
| **Codex** | `confirm` | Codex 经 server-request 发起工具授权请求 -> 主进程弹内部工具确认卡片 -> 用户批准/拒绝/信任 -> 回写 accept/deny。高危强制确认、不提供信任选项 |
| **Codex** | `auto` | 后端直接回 accept，工具调用仅以子工具卡片展示，不拦截；高危命中强制 deny（越界路径/注入）仍拦截 |
| **Claude Code** | `confirm` | **observe-only**：`--disallowedTools` 粗粒度禁用高危工具（PowerShell/Bash/Write/Edit），允许的工具自动执行、仅展示，**无逐次确认**（协议限制，D15） |
| **Claude Code** | `auto` | observe-only，全工具自动执行，仅展示 |

> **说明**：Claude Code 的 `confirm` 非真正「批准后执行」，而是「禁高危 + 观察」。两引擎 `confirm` 语义差异须在设置页与启动闸门卡醒目区分（§8.4）。

### 8.2 确认卡片的复用与 CLI 工具适配

> **适用范围（D15）**：本节确认卡片机制**仅 Codex 触发**（Codex 经 server-request 发起工具授权请求）。Claude Code `-p` 模式不发授权请求、工具自动执行，不产生确认卡片。

- Subagent 内部工具调用的确认，**沿用现有确认卡片体系**（[confirmation-card-trust-requirement.md](./confirmation-card-trust-requirement.md)、[shell-security-enhancement-requirement.md](./shell-security-enhancement-requirement.md)）：交互形态、信任机制、风险判定原则一致。
- 确认卡片需标注来源为“Subagent（Claude Code / Codex）”，与主 Agent 内置工具确认视觉上可区分。
- **风险判断需适配 CLI 自带工具集（见 N8）**：CLI 自带工具（Claude 的 Edit/Write/Bash、Codex 的 shell/apply_patch 等）与 SpaceAssistant 内置工具（read_file/edit_file/run_script）名字与参数结构不同，现有按内置工具设计的风险规则**不能直接套用**；主进程需为 Claude Code / Codex 各自的工具集适配确认与风险等级判定（哪些必确认、哪些可信任），这部分逻辑在主进程侧完成，不依赖 CLI。
- 信任机制（信任此命令 / 信任此域名）同样适用，跨会话生效。
- 高风险操作（敏感路径、注入风险等）即使在 `confirm` 策略下也**强制确认、不提供信任选项**，沿用现有风险判定。

### 8.3 用户干预

| 操作 | 行为 |
|------|------|
| 批准 | Subagent 继续执行该工具 |
| 拒绝 | 该工具调用被拒；Subagent 收到拒绝结果，可自主调整后续行为（如换方案） |
| 信任 | 写入信任列表，后续同类操作免确认 |
| 终止委派 | 用户可随时点「终止」强制结束整个 Subagent 委派；已执行的操作不回滚 |

### 8.4 自动批准的安全提示

- 开启「自动批准」时，设置页与委派卡片均需**醒目提示**：Subagent 将无人值守执行本地文件与命令操作。
- 建议自动批准仅在工作目录受控、用户充分信任的场景启用（如隔离的实验仓库）。

### 8.5 用户问询（CLI 主动向用户请求输入）

**与工具授权确认的区别：** 工具授权确认是 CLI 要执行某操作、问“允许吗?”（响应=批准/拒绝/信任）；用户问询是 CLI 遇到歧义或需信息、问“用哪个方案?/请提供 X”（响应=用户输入或选择）。两者都由 CLI 发起请求、主进程响应，但问询卡片收集的是**输入内容**而非授权决策。

**这是 SpaceAssistant（有 GUI）相比 daemon 式集成（无 UI，只能自动应答或禁用）的差异化能力。**

#### 8.5.1 分 CLI 能力（受 N8 约束，依赖 CLI 协议暴露）

| CLI | 问询机制 | 能否识别/处理 | 说明 |
|-----|----------|---------------|------|
| **Codex** | `mcpServer/elicitation/request`（MCP 标准问询，JSON-RPC method 明确）；响应 `{action, content, _meta}` | ✅ 能 | 主进程解析该 method -> 弹问询卡片 -> 把用户输入放进 `content` 回传。参考实现自动 `accept + content:nil`，我们改为转交用户 |
| **Claude Code** | `AskUserQuestion` 等问询工具 | ❌ 不支持（已验证） | 实测 v2.1.207 `-p`（print/SDK）模式工具集**不含 `AskUserQuestion`**，模型无法调用。**Claude 侧问询本期不实现**，不影响其他能力；Codex 不受影响（D12） |
| 非结构化 stdin 阻塞 | CLI 退化到传统终端式等待输入 | ❌ 不能 | 无法结构化收集，只能透传或规避 |

#### 8.5.2 问询卡片规格

```
┌─ ❓ Subagent 问询 · Codex · 等待你的输入 ──────────────────┐
│ 问题：检测到两个数据库配置，使用哪个？                      │
│ ───────────────────────────────────────────────────────── │
│ 选项 / 输入：                                               │
│  (○) 使用 .env 中的 DATABASE_URL                            │
│  (○) 使用 config/dev.json                                   │
│  ( ) 自定义输入：[__________________________________]       │
│                                                            │
│                              [跳过/拒绝]  [提交回答]        │
└────────────────────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 触发 | 主进程解析到 CLI 问询请求（如 Codex elicitation）时弹出，Subagent 阻塞等待 |
| 问题展示 | CLI 请求中的问题文本（若无结构化问题，展示原始请求摘要） |
| 选项 | 若 CLI 提供候选选项，渲染为单选；否则仅输入框 |
| 自定义输入 | 文本输入框，用户可输入自由回答 |
| 提交 | 按协议把回答回传 CLI（Codex 放入 `content`）；CLI 继续执行 |
| 跳过/拒绝 | 等价 `action: reject`（或对应 CLI 的拒绝语义）；CLI 收到拒绝后自行调整 |
| 来源标注 | 标注来自“Subagent（Claude Code / Codex）” |
| 超时 | 问询等待**不计入**无活动超时（见 §5.5）；但可设问询自身最长等待，超时按拒绝处理 |

#### 8.5.3 处理流程

1. CLI 发起问询请求
2. 主进程解析（识别为问询类，非授权类）
3. 弹问询卡片：展示问题、选项/输入框
4. 用户输入或选择 / 或跳过
5. 主进程按 CLI 协议回传回答
6. CLI 继续

#### 8.5.4 约束

- 完全依赖 CLI 协议暴露问询机制（N8）；Claude / Codex 机制不同，需分别适配。
- **Claude 侧已验证不通过**（v2.1.207 `-p` 模式工具集无 `AskUserQuestion`）：Claude Code subagent **本期不实现问询**，不影响其他能力；问询仅 Codex（elicitation）支持。
- 问询期间 Subagent 阻塞，状态显示“等待用户输入”，不计入无活动超时。

---

## 9. 结果回收与主流程衔接

### 9.1 回收结果结构

Subagent 完成后，主进程回收并向上汇总以下信息：

| 字段 | 说明 |
|------|------|
| `status` | completed / failed / timeout / aborted（终态；运行态见 §13.2） |
| `finalOutput` | Subagent 的最终文本输出（作为 `tool_result` 返回主 Agent） |
| `error` | 失败/超时/终止时的错误信息（含 CLI stderr 摘要） |
| `tokenUsage` | 本次委派的 token 用量（输入 / 输出 / 缓存等，按 Subagent 各自口径） |
| `filesChanged` | Subagent 改动/创建的文件列表摘要（若 CLI 提供） |
| `durationMs` | 执行耗时 |

### 9.2 主 Agent 衔接

- `finalOutput` 作为 `tool_result` 注入主 Agent 上下文，主 Agent 据此**继续推理与工具循环**（如：整合结果、继续下一步、或再次委派）。
- 主 Agent 可在一次会话中**多次委派**（同引擎或不同引擎），也可在委派间穿插使用内置工具。
- token 用量并入会话统计（见 §13.3）。

### 9.3 异常与错误

| 场景 | 行为 |
|------|------|
| Subagent 未安装 / 版本过低 | 委派立即失败，返回明确错误：`Subagent「Codex」未安装或版本过低，请在设置中配置` |
| `cwd` 非法 / 越界 | 委派失败，返回路径安全错误 |
| 启动失败（CLI 不存在/权限问题） | 失败，错误含 stderr 摘要 |
| 执行超时 / 无活动超时 | 终止 Subagent，标记 timeout，已产生的过程与部分结果保留展示 |
| 用户终止 | 标记 aborted，已执行操作不回滚 |
| Subagent 内部错误（API 鉴权失败、模型不可用等） | 失败，错误信息透传（注：Subagent 鉴权与主 Agent HTTP API Key 无关，见 N7） |

> 所有错误均以用户可读的中文提示呈现，并保留技术细节（stderr 摘要）供排障，技术细节默认折叠。

---

## 10. 无状态与上下文

### 10.1 Subagent 无状态

- 每次 `dispatch_subagent` 委派都是**一次独立的 CLI 调用**：Subagent 只关注本次委派的 `task` 与参数，执行完毕即结束，**不保留跨调用的上下文**。
- Subagent 内部虽存在会话/线程标识（Claude session_id / Codex threadId），但产品层面**不暴露、不续接**，仅供排障日志使用。

### 10.2 上下文由主 Agent 维护

- 主 Agent 的"记忆"即其**对话历史**（消息 + 工具调用 + 工具结果），持久化于 SQLite，每次推理均可见完整历史。
- 后续若需在先前委派基础上继续推进，由**主 Agent 自行**将相关上下文（上次任务与结果摘要）写入新的 `task` 交给 Subagent；Subagent 无需也不负责记住历史。

---

## 11. 安全与边界

### 11.1 工作目录约束

- Subagent 的 `cwd` 默认为主会话工作目录，可指定为其**子目录**；不允许越界到工作目录之外。
- 沿用现有 `pathSecurity` 路径遍历防护；越界路径在委派前即拒绝。
- Subagent 内部工具的文件操作同样受工作目录约束（由确认机制与 CLI 工作目录共同保障）。

### 11.2 进程隔离与终止

- 每个 Subagent 委派以独立子进程运行，**进程级隔离**。
- 委派结束（正常完成 / 超时 / 用户终止 / 主会话关闭）时，**可靠终止 Subagent 及其派生的孙进程**，避免进程泄漏。
- Windows 下创建隐藏控制台、不弹窗；Unix 下按进程组管理信号（见 §12）。

### 11.3 环境变量

- Subagent 子进程继承**受控环境变量**：过滤掉主进程的内部标记（如 `CLAUDECODE_*` 系列），避免 Subagent 误判自身运行环境。
- 保留用户级配置变量（如代理、CLI 自定义路径等）。
- Subagent 的鉴权（Claude Code / Codex 各自的登录态或 Key）由其 CLI 自行管理，**不与主 Agent HTTP API Key 混用**（见 N7）。

### 11.4 并发与资源

| 项 | 限制 |
|----|------|
| 同会话并发委派 | 按依赖动态决定：无依赖可并行、有依赖串行（见 §6.4）；不设固定串行 |
| 全局并发 Subagent | 默认上限 2（跨会话合计）；超限排队，避免资源失控 |
| 单次委派最大轮次 | 可由 `maxTurns` 限制（**Codex 生效**；Claude Code 无 `--max-turns`，靠执行/无活动超时兜底）；防止失控循环 |
| 输出体量 | 流式输出与结果摘要做长度截断保护，避免超大输出撑爆 UI |

### 11.5 日志记录

**复用现有 agentLogger 体系**（`logAgentEvent` / `getAgentLogDir` / `sanitizeForLog`，已有 `shellAgentLogger`、`feishuCliLogger` 先例）：仿 `shellAgentLogger` 新建 `subagentLogger`，预处理字段后调 `logAgentEvent`，写入同一 `Agent-{YYYYmmdd}.log`（开发态 `logs/`、打包态 `{workDir}/.agent/logs/`），JSONL，每行 `{ts,level,event,...fields}`。

**关键：日志由主进程在"解析 CLI 事件 / 做决策"环节记录，CLI 不参与日志（见 N8）。** 但日志字段内容取自 CLI 输出，受 §7.2 同样的 CLI 输出约束；主进程自有的（task 摘要、状态、决策、duration、pid、stderr tail）不受约束。

| event | 时机 | 字段（均脱敏） |
|-------|------|----------------|
| `subagent.dispatch.start` | 委派启动 | agent、task 摘要（前 N 字+长度，不落全文）、cwd、model、thinkingLevel、toolApproval、timeout |
| `subagent.cli.launch` | CLI 子进程启动 | execPath、args 摘要、pid |
| `subagent.tool.request` | Subagent 发起工具调用（解析自 CLI approval 请求） | 工具名、参数摘要、是否需确认 |
| `subagent.tool.decision` | 用户确认决策 | approved/rejected/trusted |
| `subagent.tool.result` | 工具结果（解析自 CLI 事件） | 状态、长度、是否截断 |
| `subagent.inquiry.request` | CLI 发起用户问询（解析自 CLI 问询请求，如 Codex elicitation） | 问询摘要、是否有选项 |
| `subagent.inquiry.response` | 用户问询回答 | accept/reject、回答摘要 |
| `subagent.dispatch.complete` | 完成 | status、finalOutput 摘要、tokenUsage、filesChanged、durationMs |
| `subagent.dispatch.error` | 失败/超时/终止 | 错误类型、stderr tail 摘要 |

**引擎差异（D15/D12）：** `subagent.tool.request` / `tool.decision`（授权）与 `subagent.inquiry.*`（问询）事件**仅 Codex 产生**；Claude Code observe-only，仅产生 `tool.result` 与 `dispatch.start/launch/complete/error` 事件。

**脱敏与边界：**

- 全部字段经 `sanitizeForLog`：敏感 key、`sk-ant-*`、`Bearer xxx`、长 base64 自动 redact；超长截断。
- **task 只记摘要**（前 N 字 + 长度），不落全文——task 可能含用户代码/业务信息，对齐飞书"不落用户正文"原则。
- **不记逐字文本增量、不记完整思考流**——日志只记结构化事件摘要，逐字内容是运行期 UI 的事。
- CLI stderr 尾部（参考实现 2KB tail）由主进程捕获子进程 stderr pipe，仅 `error` 时附加，脱敏后记录，供排障。
- 会话明文备份中，Subagent 委派记录按既有消息备份规则处理。

---

## 12. 跨平台

| 平台 | 要求 |
|------|------|
| **Windows** | Subagent 子进程创建隐藏控制台、不弹黑窗；进程终止用 `Kill` 兜底 |
| **macOS** | 按进程组管理；支持 Codex Desktop 应用包内 CLI 的探测 |
| **Linux** | 按进程组管理；负 PID 信号终止整组 |

- CLI 路径解析需兼容 nvm / fnm / volta 等非默认安装位置（自动检测 PATH 失败时，支持用户手动填写绝对路径）。
- 跨平台行为对用户透明，仅在排障日志中体现差异。

---

## 13. 数据模型与存储

### 13.1 Subagent 配置（`SubagentProfile`）

```typescript
/** 单个 CLI Subagent 的配置 */
export interface SubagentProfile {
  type: 'claude_code' | 'codex'
  enabled: boolean
  executablePath: string          // CLI 路径；空则自动检测 PATH
  // 运行时探测结果（只读，由主进程回填）
  detectedVersion?: string
  installStatus?: 'installed' | 'not_installed' | 'outdated'
  defaultModel?: string           // ModelEntry.id 或 CLI 模型 id
  defaultThinkingLevel?: string
  toolApproval: 'confirm' | 'auto'
  timeoutMinutes: number
  inactivityTimeoutMinutes: number
}
```

### 13.2 委派记录（嵌入消息历史）

每次委派作为一条工具调用记录嵌入消息历史，复用并扩展 `ToolUseData`：

```typescript
/** Subagent 委派执行记录（扩展工具调用数据） */
export interface SubagentDispatchRecord {
  agent: 'claude_code' | 'codex'
  task: string
  cwd: string
  model?: string
  thinkingLevel?: string
  toolApproval: 'confirm' | 'auto'
  status: 'queued' | 'running' | 'awaiting_confirm' | 'awaiting_inquiry' | 'completed' | 'failed' | 'timeout' | 'aborted'
  // 执行过程（流式累积，持久化最终态）
  events?: SubagentEvent[]        // 文本 / 思考 / 子工具调用 摘要
  // 回收结果
  finalOutput?: string
  error?: string
  tokenUsage?: { input?: number; output?: number; cacheRead?: number }
  filesChanged?: string[]
  durationMs?: number
}
```

> 运行期全量流式事件（每条文本增量、每个子工具）用于 UI 实时展示；持久化只保留**摘要级**（任务 + 最终结果 + 状态/用量/文件变更 + 子工具清单的名/状态/结果摘要），不存逐字文本与完整思考流（D11）。摘要字段取决于 CLI 输出能力，缺失则省略。

### 13.3 持久化与统计

| 项 | 说明 |
|----|------|
| 配置存储 | `SubagentProfile[]` 存入 `config.subagents`；敏感字段（若有）按现有加密规则处理 |
| 委派记录 | 随消息历史存入 SQLite（复用消息/工具调用表结构），会话备份同步落盘 |
| token 统计 | Subagent 委派的 token 用量并入会话 token 用量统计与展示 |
| 迁移 | 现有配置无 `subagents` 字段时，初始化为两张默认卡片（Claude Code / Codex，均默认禁用、`toolApproval: confirm`） |

---

## 14. 用户故事与典型流程

### US-1：主 Agent 自主委派编码子任务

> 作为开发者，我让主 Agent"给 src/utils 加上错误日志并补测试"。主 Agent 自行拆解后，把"补测试"委派给 Codex Subagent 执行；我在聊天里看着 Codex 多轮搜索、改文件、跑测试，完成后主 Agent 拿到结果继续整合，最终给我一份总结。

### US-2：用户经意图指定引擎

> 作为开发者，我说"用 Claude Code 把这个模块重构成 hooks"。主 Agent 识别意图，调用 `dispatch_subagent(agent=claude_code, task=…)`，我观察其执行并按需确认工具调用。

### US-3：长任务分次推进（主 Agent 保持上下文）

> 作为开发者，一个较大子任务一次没跑完。主 Agent 在其对话历史中保留了上次委派的任务与结果，下次委派时自行把相关上下文写进新的 `task` 交给 Subagent 继续；Subagent 每次都是无状态的独立执行，无需自己记住历史。

### US-4：无人值守批处理

> 作为开发者，我对一个隔离实验仓库开启 Codex 的「自动批准」，委派一个较大的重构任务，让它无人值守跑完；我事后回看执行过程与改动文件。

### US-5：多引擎协作

> 作为开发者，主 Agent 先委派 Codex 做实现、再委派 Claude Code 做代码审查与修复建议，两次结果由主 Agent 整合输出。

### US-6：安全拦截

> 作为开发者，Subagent 试图执行一条高危命令（如删除工作目录外文件）；即使我开了部分信任，确认卡片仍强制弹出且不提供信任选项，我拒绝后 Subagent 自行调整方案。

### 典型流程时序

```
用户消息 → 主 Agent 推理 → 调用 dispatch_subagent
   → 主进程启动 CLI Subagent（校验安装/路径/授权）
   → Subagent 流式执行（文本/思考/子工具）→ UI 实时展示
   → 子工具按策略：confirm → 确认卡片（批准/拒绝/信任）；auto → 放行
   → Subagent 完成 → 回收结果（输出/用量/文件变更）
   → tool_result 回主 Agent → 主 Agent 继续推理 → … → 回复用户
```

---

## 15. i18n 文案规划

- 所有新增 UI 文案**必须**通过 `t()` 使用，禁止硬编码。
- 命名空间建议：新增 `subagent` 命名空间（设置页 Tab、配置项、卡片文案、状态、错误）；委派卡片相关聊天区文案放入 `chat.subagent.*`。
- key 命名遵循 `subagent.组件.语义` 层级（camelCase，最多 4 层）。
- 状态/错误文案使用 `errors` 命名空间 + 错误码模式（如未安装、版本过低、超时、终止失败）。
- 新增 key 后运行 `npm run i18n:generate-types`；提交前 `npm run i18n:check`。

---

## 16. 验收标准

### 16.1 Subagent 配置

- [ ] 设置页存在「Subagent」Tab，含 Claude Code、Codex 两张配置卡片
- [ ] 进入 Tab 自动检测 CLI 安装与版本；状态正确（已安装/未安装/版本过低）
- [ ] 版本过低时禁用启用开关并提示升级；手动填写 CLI 路径可覆盖自动检测
- [ ] 可为每个 Subagent 配置默认模型、思考级别、工具授权策略、超时
- [ ] 模型/思考级别按 CLI 实际支持动态过滤；CLI 未安装时下拉为空态
- [ ] 配置保存后重启应用持久化正确

### 16.2 委派能力

- [ ] 主 Agent 可调用 `dispatch_subagent`，选择 Claude Code 或 Codex 委派子任务
- [ ] 委派参数（task / cwd / model / thinkingLevel / toolApproval / timeout / maxTurns）生效正确（maxTurns 对 Codex 生效、Claude 无 CLI 支持）
- [ ] 目标 Subagent 未安装/未启用/版本过低时，委派返回明确中文错误
- [ ] `cwd` 越界时委派被拒绝
- [ ] 主 Agent 可按子任务依赖动态决定串/并行；无依赖可并行、有依赖串行
- [ ] 编排方法论以 Skill 承载，可在 Skill 管理界面查看/禁用/自定义
- [ ] 同会话并发委派受全局上限保护，超限排队

### 16.3 执行过程展示

- [ ] 委派以「Subagent 执行卡片」呈现在主对话流，支持折叠/展开
- [ ] Subagent 文本、思考、内部工具调用实时流式展示
- [ ] 卡片标题栏状态实时更新；底部展示用时/token/改动文件数
- [ ] 进行中且有待确认工具或问询时自动展开并高亮
- [ ] 历史会话回看时卡片为只读完成态，可展开查看过程

### 16.4 工具授权与用户问询

- [ ] **Codex** `confirm` 策略下，工具调用触发确认卡片；高危强制确认无信任选项
- [ ] **Claude Code** `confirm` 策略下，高危工具被 `--disallowedTools` 禁用、其余工具自动执行仅展示（observe-only，无逐次确认）；`auto` 为纯观察
- [ ] `auto` 策略下工具调用放行、仅展示；开启时设置页与卡片有醒目提示
- [ ] 设置页与启动闸门卡醒目区分两引擎 `confirm` 语义（D15）
- [ ] 信任机制（命令/域名）跨会话生效（Codex）；拒绝后 Subagent 可自主调整
- [ ] 用户可随时「终止」委派；已执行操作不回滚
- [ ] Codex elicitation 问询能识别并弹问询卡片；用户输入/选择后按协议回传，CLI 继续
- [ ] 问询卡片支持选项单选与自定义输入；跳过/拒绝按对应语义回传
- [ ] 问询等待不计入无活动超时；状态显示“等待用户输入”
- [ ] Claude Code 问询本期不实现（已验证 `-p` 模式无 `AskUserQuestion`），不影响其他能力

### 16.5 结果回收与衔接

- [ ] Subagent 完成后回收最终输出/状态/token/文件变更
- [ ] `finalOutput` 作为 tool_result 返回主 Agent，主 Agent 据此继续
- [ ] 单会话可多次委派（同/不同引擎），可与内置工具穿插
- [ ] 超时/终止/失败时状态与错误正确；stderr 摘要保留且默认折叠

### 16.6 无状态与上下文

- [ ] 每次委派为独立调用，Subagent 不保留跨调用上下文
- [ ] 主 Agent 在对话历史中保留委派的 task 与结果，后续委派时可自行带上下文
- [ ] 不存在 `resumeSubagentThreadId` / 续接相关参数与 UI

### 16.7 安全与跨平台

- [ ] Subagent 在受控工作目录内执行；越界拒绝
- [ ] 委派结束（完成/超时/终止/会话关闭）可靠终止 Subagent 及孙进程，无泄漏
- [ ] 环境变量过滤生效；Subagent 鉴权与主 Agent API Key 隔离
- [ ] Windows 下无控制台弹窗；macOS/Linux 进程组终止正常
- [ ] 并发委派受限于 §11.4 上限

### 16.8 持久化与统计

- [ ] 委派记录随消息历史持久化；历史回看完整可见
- [ ] Subagent token 用量并入会话统计
- [ ] 现有配置升级后初始化两张默认（禁用）Subagent 卡片，现有用户零影响

---

## 17. 已决事项与待确认

### 17.1 已决事项

| ID | 决定 |
|----|------|
| **D1** | **定位为 Subagent 委派，不替换主 Agent HTTP API**；主 Agent 是编排者，Subagent 是被委派的执行者 |
| **D2** | **第一期同时支持 Claude Code + Codex**，二者在统一抽象下对主 Agent 透明 |
| **D3** | **工具授权可配置**：默认「确认后执行」（沿用现有确认卡片），可切「自动批准」；单次委派可覆盖。**逐次确认仅 Codex 支持**，Claude Code 降级为 observe-only（见 D15） |
| **D4** | Subagent 不作为用户直接对话的独立聊天渠道；用户经主 Agent 间接使用 |
| **D5** | Subagent 鉴权与计费由各自 CLI 自行管理，与主 Agent HTTP API Key 无关 |
| **D6** | 第一期不为 Subagent 注入额外 MCP 配置（沿用 CLI 默认工具集） |
| **D7** | 第一期仅主聊天工具循环支持委派；飞书远程 / Skill 路由 / 标题生成等旁路不接入 |
| **D8** | 委派工具采用统一 `dispatch_subagent`（参数 `agent` 选引擎），不分立 `dispatch_claude_code` / `dispatch_codex` |
| **D9** | Subagent 无状态：每次委派为独立调用，不保留跨调用上下文；记忆由主 Agent（对话历史）维护，后续委派时由主 Agent 自行将必要上下文写入 `task` |
| **D10** | 多任务编排按依赖动态决定：无依赖并行、有依赖串行；编排方法论以 Skill 形式注入主 Agent，由主 Agent 自行决策，主进程不内置调度器 |
| **D11** | 信息分层：运行时 UI 全量流式 / 日志结构化摘要 / 持久化摘要级；持久化只存任务+最终结果+状态/用量/文件变更+子工具清单（名/状态/结果摘要），不存逐字文本与完整思考流。摘要字段取决于 CLI 输出能力，缺失则省略 |
| **D12** | 第一期纳入结构化用户问询转交：**Codex elicitation 落地**；**Claude 问询已验证不通过**（v2.1.207 `-p` 模式工具集无 `AskUserQuestion`），Claude 侧本期不实现问询、不影响其他能力（见 §8.5） |
| **D13** | 本期不提供用户手动委派入口（@codex / UI 按钮）；委派完全由主 Agent 自主发起，用户经消息意图影响主 Agent 的委派选择 |
| **D14** | `filesChanged` 文件变更摘要第一期仅展示列表，不提供跳转 diff / 回滚（后续迭代） |
| **D15** | **Claude Code 授权降级为 observe-only**：技术验证实测 `-p` stream-json 模式无 control_request、工具自动执行，无逐次确认能力。Claude 的 `confirm` 退化为「`--disallowedTools` 禁高危（PowerShell/Bash/Write/Edit）+ 观察」，`auto` 为纯观察；逐次确认（D3 机制）仅 Codex 支持。两引擎 `confirm` 语义须在 UI 醒目区分（见 §5.4/§8.1） |

### 17.2 待确认（OQ）

本期无待确认事项，原开放问题均已决，见 §17.1 D8 ~ D14。

---

## 18. 相关文件

> 以下为预期涉及的文件方向，仅供规划，具体技术实现以后续技术设计文档为准。

| 文件 / 模块 | 变更类型 |
|--------------|----------|
| `src/shared/domainTypes.ts` | 新增 `SubagentProfile`、`SubagentDispatchRecord`、`SubagentEvent` 等类型 |
| `electron/`（新建 Subagent 调用模块） | 新建：CLI Subagent 统一调用抽象、Claude Code / Codex 适配、安装检测、模型/思考级别发现 |
| `electron/toolChatLoop.ts` | 注册 `dispatch_subagent` 工具；委派执行体接入工具循环 |
| `electron/appIpc.ts` | Subagent 配置读写、检测、模型发现 IPC；config:get/set 扩展 `subagents` |
| `electron/preload.ts` | 暴露 Subagent 相关 IPC 通道 |
| `src/shared/api.ts` | Subagent 配置/检测 API 类型 |
| `src/renderer/components/Config/` | 新增 Subagent 设置 Tab 与配置卡片 |
| `src/renderer/components/Chat/` | 新增 Subagent 执行卡片组件（嵌套子工具/思考展示） |
| `src/renderer/i18n/resources/*/` | 新增 `subagent` 命名空间与 `chat.subagent.*` 文案 |
| `electron/database/` | 委派记录持久化（复用消息/工具调用表） |
| `electron/pathSecurity.ts` | Subagent `cwd` 校验复用 |
| 现有确认卡片组件 | 复用并标注 Subagent 来源 |

---

*文档结束*

**备注：** 本文档聚焦产品方案与需求梳理，不涉及具体技术实现决策（如 Backend 接口设计、stream-json / JSON-RPC 协议细节、进程管理代码等），相关技术设计另开文档。
