# Thinking 强度配置 — 产品需求规格

**版本：** 1.6
**日期：** 2026-09-19
**状态：** 已定稿（OQ 全部闭环；v1.2 / v1.4 两轮评审的阻断项与事实偏差均已修复）
**关联文档：** [llm-multi-service-model-config-requirement.md](./llm-multi-service-model-config-requirement.md)、[settings-requirement.md](./settings-requirement.md)、[settings-ui-refinement-requirement.md](./settings-ui-refinement-requirement.md)、[../develop/agent-core-contract-path-refactor-plan.md](../develop/agent-core-contract-path-refactor-plan.md)、[../review/thinking-effort-settings-requirement-review.md](../review/thinking-effort-settings-requirement-review.md)（v1.2 评审，B1/N1–N5/C1–C4 已在 v1.3–v1.5 处置）、[../review/thinking-effort-settings-requirement-review-v1.4.md](../review/thinking-effort-settings-requirement-review-v1.4.md)（v1.4 复审，B1'/N1–N3 已在 v1.5 处置）

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-09-19 | 初稿：设置页 Thinking 强度（全局 + 模型级）、运行时 effort → provider 参数映射、迁移与验收 |
| 1.1 | 2026-09-19 | **作用域由「全局 + 模型级」改为「全局默认 + 会话级覆盖」**（§4、§5.2、§6、§7.1）；OQ-2 本期只做 adaptive + output_config；不做预算式回退；补 §7.4 会话内记忆；明确会话列存与 `updateSession` 白名单两处实现约束（§6.3） |
| 1.2 | 2026-09-19 | 移除 composer「Enter 发送，Shift+Enter 换行」提示以为强度控件腾位（OQ-9、§5.2）；补 §2.7 说明该元素已演进为「折叠式状态区」（非早期文档所述 `.composer-hint`）；明确只删提示、不动键位行为 |
| 1.3 | 2026-09-19 | **修复阻断项 B1**：迁移基线由「V14 → 新增 V15」更正为「**V16 → 新增 V17**」（§2.5、§6.3、§12、§10.4）；N1 §2.4/OQ-8 的宽度论据更正为整页 `ConfigSettingsPage`（§2.4、§5.3）；N2 §12 删除不存在的「idle 专用样式」清理项；N3 明确档位校验为净新增（§8.4、§12）；N5 `toolLoopModelOptions.ts` 措辞更正；C1 记忆粒度改为 `llmServiceId + model`（§7.4）；C3 远程链路经核验确认成立（§9）；C4 迁移触发点明确为启动时（§8.1）；批量刷新行号（§12、§2.5–§2.7） |
| 1.4 | 2026-09-19 | **清空全部「待实测」项**（原仅 C2）：§7.3 的「adaptive + effort 同发」由**推断升为已证实**（官方迁移示例即 A+C 同发，§2.3/§7.3）；同期发现三项需修正的事实并落地——① 服务端档位比 SDK 枚举宽（另有 `xhigh`，§2.3、OQ-1）；② **档位非等距，`low ≈ medium`**，据此调整效果验收基准与对外口径（§4.1、§10.5）；③ effort 作用面超出 thinking（亦影响工具调用频率，§2.3）。另明确 GA 端点无需 beta header（§7.4），并加评审 C 项闭环小结（§11.1） |
| 1.5 | 2026-09-19 | **修复复审阻断项 B1'**：v1.3 的 C3 结论（四条 lane「无绕过路径」）只核验到调用点、未追到装配入参，**实际不成立**——远程 / Butler lane 的装配点无 thinking 入参，实际恒 `off`。据此新增 **OQ-10** 决策（本期固定 `off`、不接通），并把 §7.6 改写为「按 lane 的档位边界」（原 §7.6 子调用顺延为 §7.7）；§9 远程会话行更正；§10.3 补远程 lane 验收项；§12 标注两文件「本期不改」。另修非阻断项：§10.3 记忆粒度同步为 `llmServiceId + model`、§2.3 表头「三条」→「四条」 |
| 1.6 | 2026-09-19 | **产品确认 OQ-10 保留方案 B**（远程 / Butler lane 本期固定 `off`，不接通），最后一项开放决策闭环；文档状态由「待评审」转为**已定稿**。§7.6 保留「方案 A 独立立项」的未来路径说明，不改动 |

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [目标与非目标](#3-目标与非目标)
4. [概念模型](#4-概念模型)
5. [UI 规格](#5-ui-规格)
6. [数据模型与存储](#6-数据模型与存储)
7. [运行时解析与 provider 映射](#7-运行时解析与-provider-映射)
8. [迁移与兼容](#8-迁移与兼容)
9. [边界与异常](#9-边界与异常)
10. [验收标准](#10-验收标准)
11. [已决事项（原 OQ）](#11-已决事项原-oq)
12. [相关文件](#12-相关文件)

---

## 1. 概述

### 1.1 背景

部分模型在开启 Extended Thinking 后**思考过度**：推理链冗长、首字延迟显著、思考 token 消耗大，而实际收益有限。典型表现是简单任务也要「想很久」，用户等不到回复，或为一个改错别字的问题消耗数千 reasoning token。

当前产品对 Thinking 只有**开 / 关二值**控制：

- 设置为「默认开启 Thinking」布尔开关（`config.thinkingEnabled`）；
- 开启后，运行时统一发送 `thinking: { type: 'adaptive' }`，**没有任何强度区分**。

结果是用户面对「会过度思考的模型」只能二选一：忍受冗长思考，或整体关掉 Thinking 连带着复杂任务的推理质量一起牺牲。

### 1.2 本需求要解决的问题

| # | 用户诉求 | 本需求对应能力 |
|---|----------|----------------|
| R1 | 能调低思考强度，而不是只能开 / 关 | 引入四档强度 `off / low / medium / high` |
| R2 | 只对「这次」调低，不影响其他场景 | **会话级覆盖**（§4.2、§5.2） |
| R3 | 全局有一个合理的默认强度 | 全局默认 `thinkingEffort` |
| R4 | 调低之后要**真的变快变省**，不能是界面安慰剂 | 运行时把档位真正落到 provider 请求参数（§7.3） |
| R5 | 某些模型不支持 Thinking，不要给出无效选项 | 复用 `ModelEntry.supportsThinking` 能力标记 + 运行时降级（§7.1） |
| R6 | 升级后原有行为不能突变 | 布尔开关到枚举的等价迁移（§8.1） |

### 1.3 作用域决策说明（v1.1 修订）

原始诉求是「对某些**过度思考的模型**调低强度」，字面指向**模型维度**。经评审改为**会话维度**，理由：

1. **痛点的真实生命周期是一次任务上下文。** 用户说「这模型想太久」，实际场景几乎总是「我这次只是让它改个错别字，它想了很久」。诉求随任务结束而消失，而非「这个模型永远不许想」。
2. **操作摩擦更小。** 会话级入口在聊天区，用户当场可调（0 跳转）；模型级要进设置页逐模型配置。
3. **避免与「切模型」语义重叠。** 「这个模型定位就是轻量活儿」的正确表达是**换模型**，而不是给它挂一个永久档位属性。
4. **避免多层优先级认知负担。** 若同时存在模型级与会话级，优先级变成「会话 > 模型 > 全局」，用户会遇到「我明明在设置里调低了，这个会话怎么还是高档」。

**已知取舍（如实记录）：** 砍掉模型级后，**「为某个模型设置常驻档位」没有落点**——同一模型开多个会话需各自调整。评审认为该场景的真实需求应通过换模型解决；若后续确有此诉求，`ModelEntry` 加字段成本很低，可再补一层（届时需重新评估优先级表述）。

### 1.4 为什么现在能做

运行时契约已经就绪（`docs/develop/agent-core-contract-path-refactor-plan.md` 的 **P4 / 偏差 6** 已完成）：

- `AgentInvocationProfile.reasoning.effort: 'off' | 'low' | 'medium' | 'high'`（`src/shared/agent/invocation.ts:84`）；
- `ModelEntry.supportsThinking?: boolean` 能力标记（`src/shared/domainTypes.ts:732-733`）；
- 装配期能力校验 + 定死规则降级 + `agent.profile.reasoning_degraded` 审计（`electron/runtime/invocationAssembler.ts:179-200`）。

但那份计划的**范围说明**明确写到：「设置页 UI 的 effort 档位选择器**不在本计划**……全局配置的 `thinkingEnabled` 布尔继续作为默认值来源」——本需求就是那一期。

会话级覆盖的基建也已存在，可直接平移：

- `session:update` IPC 已支持更新会话字段（`electron/appIpc.ts:733-747`）；
- `resolveSessionModelBinding()` 已实现「会话绑定 + composer 草稿保持 + 回退」的完整模式（`src/renderer/services/sessionModelBinding.ts`），甚至已处理「composer 在首个会话创建前就渲染，需保留在此处的选择」。

---

## 2. 现状分析

### 2.1 配置层现状

```typescript
// src/shared/domainTypes.ts
export interface ModelEntry {
  supportsThinking?: boolean   // 已存在：显式 false 表示不支持 thinking
  id: string
  name: string
  maximumContext: number
  maxTokens: number
  isDefault: boolean
  isFast: boolean
  isVision: boolean
  enabled: boolean
}

export interface Session {
  id: string
  model: string
  llmServiceId?: string
  // 无 thinking 相关字段
}

export interface AppConfig {
  models: ModelEntry[]
  thinkingEnabled: boolean     // 只有布尔
}
```

| 项 | 现状 |
|----|------|
| 存储键 | `config.thinkingEnabled`（字符串 `'false'` 表示关闭；缺省视为开启） |
| 语义 | 新建会话时是否默认启用 Thinking（`settings-requirement.md` §3.3） |
| UI | `ModelsSettingsTab.tsx:413-423` 「大模型设置」区末尾的单行 Switch + hint「仅对支持 extended thinking 的模型生效」 |
| 强度 | **不存在** |
| 会话级 | **不存在**；`Session` 无任何 thinking 字段 |
| 能力标记 | `supportsThinking` 在 `src/renderer/` 下 **零引用**，UI 完全感知不到模型能力 |

### 2.2 运行时链路现状（档位在此**被折叠丢失**）

```
Session / 全局配置
  └─ resolveTrustedTurnExecutionConfig()            // electron/turnExecutionConfig.ts:114
        enableThinking: getConfigValue(db, 'config.thinkingEnabled') !== 'false'
  └─ claudeStreamHandlers → assembleInvocation({ options: { enableThinking } })
        // electron/claudeStreamHandlers.ts:393-407 —— 未传 effort
  └─ invocationAssembler                          // electron/runtime/invocationAssembler.ts:181-200
        requestedEffort = materials.effort ?? (enableThinking === true ? 'medium' : 'off')
        supportsThinking === false → 降级 'off' + 审计
  └─ toolChatLoop                                 // electron/toolChatLoop.ts:790-793
        const thinking = reasoningEffort !== 'off'
          ? { type: 'adaptive' }
          : { type: 'disabled' }
        // 注释原文：「其余档位本期统一 adaptive，budget 细分随后续阶段」
```

**结论：**

1. 主链路**从未传入 effort**，`low / medium / high` 三档在链路上不可达，实际只有「medium（= 开关开）」与「off」；
2. 即使将来传入 `low` 或 `high`，`toolChatLoop:793` 也会把它们**折叠成同一个 `{ type: 'adaptive' }`**；
3. 因此「调低思考强度」在今天就**不可能生效**——这是本需求必须修的核心。

`electron/toolChatLoop.ts:1035` 的 `llm.request` 日志同样只记 `enableThinking: reasoningEffort !== 'off'`，排查时看不出实际档位。

### 2.3 Provider / SDK 能力现状

`@anthropic-ai/sdk@^0.79.0`（`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`）提供四条强度控制路径：

| 路径 | 类型定义 | 约束 |
|------|----------|------|
| A. `thinking: { type: 'adaptive' }` | `ThinkingConfigAdaptive`（`:950`） | 无预算参数，仅有 `display?: 'summarized' \| 'omitted'` |
| B. `thinking: { type: 'enabled', budget_tokens: N }` | `ThinkingConfigEnabled`（`:963`） | **必须 ≥1024 且 < `max_tokens`**，且占用 `max_tokens` 总预算 |
| C. `output_config: { effort }` | `OutputConfig.effort?: 'low' \| 'medium' \| 'high' \| 'max' \| null`（`:704-708`） | 顶层字段（`:1881`），与 `thinking` **正交**，可同时出现 |
| D. `thinking: { type: 'disabled' }` | `ThinkingConfigDisabled`（`:960`） | 关闭 |

即：**当前代码用的是路径 A（adaptive），而「强度」的正规载体是路径 C（`output_config.effort`）**。

**路径 C 的语义（v1.4 由推断升为已证实，来源见 §11.1）**：官方从 extended thinking 迁移到 adaptive thinking 的标准写法，即 A + C **同发**：

```python
client.messages.create(
    model="claude-opus-4-7",
    max_tokens=64000,
    thinking={"type": "adaptive"},
    output_config={"effort": "high"},
    messages=[...],
)
```

**服务端档位比 SDK 枚举更宽**：SDK 0.79.0 为 `low | medium | high | max`，而服务端实际另有 **`xhigh`**（位于 `high` 与 `max` 之间，随 Opus 4.7 引入）。即 SDK 枚举**落后于**服务端。本需求只暴露四档（§4.1），不受影响；但实现时**不得**用 SDK 枚举反推「服务端只认这四个值」。

**effort 的作用面比 thinking 更宽**：除思考长度外，亦影响工具调用频率等其他 token 消耗，更接近全局「节俭度」旋钮。对本产品（以工具循环为主）属**正向收益**——降档同时降低工具调用开销；但需知晓「降一档」的影响不止思考链。

> 注意：不同代理 / 中转网关对 `output_config` 的透传支持不一，需要在运行时做「不认就回退」的容错（§7.4）。

### 2.4 模型列表 UI 现状

`ModelsSettingsTab.tsx` 的模型列表**已不是早期文档描述的两行卡片**，而是一张 **7 列只读表格**（`config-models-catalog`）：

| 列 | 类名 | 内容 | 可交互 |
|----|------|------|--------|
| 1 | `--toggle` | 启用 Switch | ✅ 可点 |
| 2 | `--name` | 模型名 | ❌ 只读 |
| 3 | `--cap-fast` | 快速徽章 | ❌ 只读 |
| 4 | `--cap-vision` | 视觉徽章 | ❌ 只读 |
| 5 | `--ctx` | 上下文 | ❌ 只读 |
| 6 | `--out` | 输出上限 | ❌ 只读 |
| 7 | `--action` | 删除（仅自定义模型） | ✅ 可点 |

**关键约束：除首列 Switch 与末列删除外，所有列都是只读展示。**

> **宽度事实更正（v1.3）**：设置页**已不是 Modal**，而是整页 `ConfigSettingsPage`（`ConfigModal` 仅为 deprecated 别名，`ConfigModal.tsx:121-123`），容器 `max-width: 720px`（`config-settings.css`）；「560px」是 `settings-requirement.md` 的早期描述，现已不适用。**因此 OQ-8「不加第 8 列」的论据不是空间不足**，而是：① 该表除首列 / 末列外均为只读展示，插入可编辑控件破坏交互范式；② 能力展示已有「快速 / 视觉」两列，i18n 亦预留了合并用的 `models.list.colCaps`（「能力」）。**结论不变**，但论据以本节为准。

> 注：i18n 已存在 `models.list.colCaps`（「能力」）键，暗示曾计划把快速 / 视觉合并为单列；本期不强制合并，但若新增能力列，应优先走合并方案。

### 2.5 会话存储现状

`electron/database/schema.ts:17-32` 的 `sessions` 表为**列存**（非 JSON），当前 `DB_SCHEMA_VERSION = 16`（`schema.ts:2`）：

> ⚠️ **实施前必须再核对一次当时的 `DB_SCHEMA_VERSION`**，不要照抄本节数字（版本号会随其他需求推进而变化）。本节的 16 为 2026-09-19 核验值；V14 = `ownership` / `visibility`、V15 = butler 表、V16 = usage 统计表。

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  llm_service_id TEXT,
  temperature REAL NOT NULL,
  max_tokens INTEGER NOT NULL,
  ...
)
```

两处**必须同步修改的约束**：

| 位置 | 现状 | 影响 |
|------|------|------|
| `electron/database/operations.ts:239-258` | `updateSession` 的 patch 类型是显式 `Pick<Session, 'name' \| 'preview' \| 'model' \| 'llmServiceId' \| 'temperature' \| 'maxTokens' \| 'metadata' \| 'messageCount' \| 'skillsState' \| 'workDirProfileId' \| 'ownership' \| 'visibility'>` | 不把 `'thinkingEffort'` 加进白名单，写入**静默无效** |
| `electron/appIpc.ts:733-747` | `session:update` 的 payload 类型逐字段列出（无 thinkingEffort） | 不补则该 IPC 收不到档位 |

另：`createSession`（`operations.ts:162` 起，INSERT 在 `:207-215`）的 insert 字段列表也需支持该列，用于「用户在 composer 先选档位、随后才创建会话」的场景。

### 2.6 脏检测现状（需同步修）

`configModalSnapshot.ts` 的 `normalizeModels()`（`:40-53`）只序列化 `id/name/maximumContext/maxTokens/isDefault/isFast/isVision/enabled`——**已遗漏 `supportsThinking`**。若不补，能力标记的改动会被判为「无更改」，保存按钮保持禁用（与 `preferredVisionModelId` 当年踩过的坑同源，见该文件 `ConfigModalSnapshotInput` 的注释）。

### 2.7 composer 状态区现状（原「composer-hint」）

**该元素已从「提示文案」演进为「折叠式状态区」**，与 [composer-hint-responsive-requirement.md](./composer-hint-responsive-requirement.md) 描述的早期实现**已不一致**：该文档写的是 `.composer-hint` + `composer-hint--hidden` + `visibility: hidden` / `position: absolute`；现网为下述结构——**文档需重写或废弃**。

现网结构（`src/renderer/components/Chat/MessageInput.tsx`）：

```
.composer-footer                          // flex, space-between
├── .composer-footer__start               // leftRowRef
│   ├── <button .composer-add-attachment> // 附件 +
│   ├── <span>{modelSlot}</span>          // 模型 chip（modelChipRef）
│   ├── .composer-status--measure         // 隐藏测量元素（statusMeasureRef, aria-hidden）
│   └── 二选一（由 statusCollapsed 决定）
│       ├── 折叠态：<button .composer-hint-trigger> + Tooltip（22px）
│       │           · running → <span .composer-status-trigger-dot>（脉冲点）
│       │           · idle    → <Keyboard />（键盘图标）
│       └── 展开态：<div .composer-status>
│           ├── idle    → 仅 hintIdle 文本（Enter 发送，Shift+Enter 换行）
│           └── running → <span .composer-status__pulse>（脉冲点）
│                        + .composer-status__activity =
│                           runningStatus（「生成中」等）+ runningDetail
│                           + runningElapsed（耗时）+ queueCount（队列）
│                        + 可选「· 」+ hintRunning / hintRunningQueue
└── .composer-footer__actions             // ContextUsageRing + 发送 / 停止
```

> **注（v1.2 修正）：** 展开态 **idle 无键盘图标**；键盘图标仅出现在**折叠态且 idle** 时（`running ? 脉冲点 : Keyboard`，`MessageInput.tsx:470-475`）。

| 机制 | 位置 | 说明 |
|------|------|------|
| 双档折叠 | `MessageInput.tsx:302-335` | `neededWidth > availableWidth && neededCollapsedWidth <= availableWidth` → 折为 22px 图标按钮；阈值含 `attachWidth` / `chipWidth` / `triggerWidth(22)` / `gap(8)` |
| 折叠重测 | `MessageInput.tsx:337-354` | `ResizeObserver` 监听 footer，并在 `modelSlot` / `running` / `canQueueSend` / `queueCount` / `footerStatusLabel` / 附件数变化时重测 |
| 文案三态 | `MessageInput.tsx:101-105` | `hintIdle`（idle）/ `hintRunningQueue` / `hintRunning`（running） |

**结论（对 §5.2 的影响）：**

1. 该区域**本就自带降级**（窄窗口折成 22px 图标），并非恒占一整句宽度；
2. 但 idle 时其**唯一内容**就是 `hintIdle`（Enter 提示），故移除后 idle 态可**整块不渲染**，腾出的空间大于「删一段文字」；
3. `hintRunning` / `hintRunningQueue` 是**功能性状态**（提示可中止 / 可排队），须保留；
4. **running 态的「生成中」+ 耗时等内容走独立通道**（`showActivity` 分支内的 `runningStatus` / `runningDetail` / `runningElapsed` / `queueCount`），**不经过 `hintIdle`**，删除后者不会波及（保留清单见 §5.2.1）。

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | 设置页提供 **全局 Thinking 强度**四档选择：`关闭 / 低 / 中 / 高`（对应 `off / low / medium / high`） |
| G2 | 全局档位作为**默认值提供者**，替代原布尔开关的语义位置（§5.1） |
| G3 | 聊天区提供 **会话级强度覆盖**，缺省继承全局（§5.2） |
| G4 | 运行时把档位**真正落到 provider 请求**（`output_config.effort`），不再折叠成布尔（§7.3） |
| G5 | 上游不支持强度字段时**可恢复降级**（不报错中断），并落审计与会话内记忆（§7.4） |
| G6 | 复用 `ModelEntry.supportsThinking`：不支持的模型运行时降为 `off` 并留痕（§7.1） |
| G7 | 旧的 `thinkingEnabled` 布尔 **等价迁移**，升级后行为不变（§8.1） |
| G8 | 设置页脏检测覆盖新字段（全局强度 + `supportsThinking`）（§2.6、§5.5） |

### 3.2 非目标

- **不做** 模型级强度覆盖（v1.1 决策，理由见 §1.3）；
- **不做** `thinking.enabled + budget_tokens` 预算式路径（OQ-2 决策，理由见 §7.5）；
- **不做** 逐消息（per-message）的强度切换；
- **不做** 基于任务复杂度自动选档（「智能调档」另立需求）；
- **不做** 已有模型 `supportsThinking` 的行内编辑入口（本期仅「添加模型」Popover 可设置，理由见 §5.3）；
- **不修改** Thinking 的**展示**形态（`ThinkingBlock` / `thinkingSegments` 已实现，本次只改「要不要想、想多少」）；
- **不引入** 非 Anthropic 协议 provider 的等价参数（本期以 `anthropic.messages.stream` 为准）；
- **不实现** `reasoning` 的按模型自动探测（能力标记仍由声明决定）；
- **不改变** Enter / Shift+Enter 的**实际键位行为**（`handleEnter` 逻辑不动），仅移除 composer 的提示文案（§5.2、OQ-9）；
- **不做** 远程（飞书 / 微信）与 Butler（automation）lane 的 thinking 接通：这两条 lane 本期**固定 `off`**，不继承全局、不读会话覆盖（OQ-10 决策，理由与影响见 §7.6）。

---

## 4. 概念模型

### 4.1 强度档位

```typescript
/** 复用既有契约类型，不新造枚举 */
type ThinkingEffort = 'off' | 'low' | 'medium' | 'high'   // src/shared/agent/invocation.ts:84
```

| 档位 | UI 文案（zh-CN） | en-US | 语义 |
|------|------------------|-------|------|
| `off` | 关闭 | Off | 不发送思考请求（`thinking: { type: 'disabled' }`） |
| `low` | 低 | Low | 最短思考，优先响应速度 |
| `medium` | 中 | Medium | 默认档，兼顾质量与速度 |
| `high` | 高 | High | 完整推理，用于复杂任务 |

> 与契约保持四档，**不新增 `max` / `xhigh`**（OQ-1 决策；服务端另有 `xhigh` / `max`，见 §2.3）。

**档位非等距（重要，v1.4 补）**：社区实测（Simon Willison 五档对比，经多篇文章引用）显示 **`low` 与 `medium` 的实际差异很小**——两者在多数任务上几乎不产生可见 reasoning token，接近「不推理、只换价签」；要到 `high` 及以上才有明显推理。两个产品含义：

1. **「从「中」降到「低」」的收益可能不明显**——真正可感知的是**从 `high` 降到 `medium`/`low`**，或直接 `关闭`。§10.5 的效果验收据此以「`high` → `low`」为对比基准，而非「`medium` → `low`」；对外口径也不得承诺「降一档必然更快」。
2. **默认档选 `medium` 更稳妥**：既与现网「默认开启」等价迁移（§8.1），又落在低成本区间；若默认 `high`，所有未调整的会话成本都会显著上升。

### 4.2 两层解析模型（v1.1）

```
┌────────────────────────────────────────────────────────────┐
│ ① 全局默认      config.thinkingEffort                        │
│    设置页「大模型设置」区 · Thinking 强度（默认「中」）        │
└──────────────────────────┬─────────────────────────────────┘
                           │ 被覆盖（缺省则继承）
┌──────────────────────────▼─────────────────────────────────┐
│ ② 会话级覆盖    Session.thinkingEffort（NULL = 继承 ①）      │
│    聊天区 composer · 思考强度                                │
│    ← 「这次别想太久」在这里当场调整                           │
└──────────────────────────┬─────────────────────────────────┘
                           │ 能力校验
┌──────────────────────────▼─────────────────────────────────┐
│ ③ 能力 & 上游校验                                           │
│    · ModelEntry.supportsThinking === false → off（已有）     │
│    · 上游不认 output_config → 去强度降级（§7.4）             │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
              provider 请求体（thinking / output_config）
```

**解析优先级：** 会话级覆盖 > 全局默认 > 内置默认（`medium`）。

**继承 vs 快照（重要区分）：**

| 字段 | 语义 | 全局改动后的表现 |
|------|------|------------------|
| `Session.model` / `Session.llmServiceId` | **快照**：创建 / 选择时固化 | 老会话不变 |
| `Session.thinkingEffort`（本需求） | **继承**：`NULL`/缺省即「未覆盖」，每次解析读全局当前值 | 未覆盖的老会话**跟着变** |

这与「全局默认」的语义一致：用户改全局，意图是影响所有未显式覆盖的会话。**实现时不得把全局值快照进会话**，否则「改全局」对存量会话失效。

**冻结语义不变：** 发起时解析、调用内冻结（沿用既有约定）。会话级改动**不影响进行中的 turn**，下次发送生效。

### 4.3 「过度思考」的处理路径（v1.1）

用户抱怨「某模型想太久」时的正确操作：**在该会话的 composer 里把强度调低**（②），全局保持「中」。

---

## 5. UI 规格

### 5.1 全局强度（设置页 · 大模型设置区）

**替换** 现有「默认开启 Thinking」Switch 行（`ModelsSettingsTab.tsx:413-423`）。

| 项 | 规格 |
|----|------|
| 控件 | `Select`（4 项：关闭 / 低 / 中 / 高） |
| 位置 | 原 Switch 所在行（`config-models-thinking-row`），保持贴底、右对齐 |
| 标签 | `Thinking 强度`（i18n `models.defaults.effortLabel`） |
| 提示 | `对会长时间思考的模型，可在此调低默认强度；也可在对话中单独调整当前会话。`（`models.defaults.effortHint`） |
| 默认值 | `medium`（OQ-3 决策） |
| 迁移兼容 | 原 Switch「开」= `medium`，「关」= `off`（§8.1） |
| 区块 intro | 更新 `models.defaults.intro`（现文案「Thinking 开启后……」需改为强度表述） |

> 不新增「Thinking 总开关」（OQ-7 决策）：`关闭` 已是档位之一，避免两个控件语义重叠。

### 5.2 会话级覆盖（聊天区 · composer）

| 项 | 规格 |
|----|------|
| 位置 | 聊天区 composer footer 左段 `.composer-footer__start` 内，**模型 chip 之后、状态区之前**（结构见 §2.7） |
| 触发 | 点击当前强度展示区，弹出列表（Popover / Dropdown，沿用模型选择器交互） |
| 选项 | ~~**5 项**：`默认（继承）` / `关闭` / `低` / `中` / `高`~~ **已变更（实施期用户定稿）**：列表仅 **4 档** `关闭 / 低 / 中 / 高`；「是否默认」是档位的**属性**而非独立选项——等于当前全局档位的项带「`<档位> · 默认`」标记，点它 = 清除覆盖回到继承（写 `null`，继承语义 §4.2 不变）。取舍：与全局值相同的显式快照不可表达（其与继承无可感知差异，接受） |
| 值 | 会话字段：`undefined`（继承）/ `off` / `low` / `medium` / `high` |
| 展示态 | 未覆盖时显示 `默认（中）`，括注为**当前全局档位**，避免用户不确定实际值 |
| 选择效果 | 写 `Session.thinkingEffort`（`session:update`），**下次发送生效** |
| 选择「默认」 | 清除会话覆盖（写回 `null`） |
| 能力联动 | 当前会话模型 `supportsThinking === false` 时，控件禁用并提示「该模型不支持 Thinking」 |
| 未创建会话时 | 支持草稿：沿用 `resolveSessionModelBinding` 的「composer 先渲染」处理，把此处选择保留到会话创建时一并带入 |
| 远程会话 | 飞书 / 微信来源会话无 composer，不可从远端调整；桌面打开该会话时可见可控，字段缺省继承全局 |

#### 5.2.1 移除 Enter 提示为强度控件腾位（OQ-9，v1.2）

`composer-footer__start` 在中等宽度下容纳「附件 + + 模型 chip + 状态区」已接近上限，强度控件需要落位空间。现有状态区在 **idle 时的唯一内容**就是 `hintIdle`（「Enter 发送，Shift+Enter 换行」），故移除它腾位。

| 项 | 处理 |
|----|------|
| `input.hintIdle` 键 | **删除** |
| idle 态展开区 | **整块不渲染**（该区 idle 唯一内容即此提示） |
| idle 折叠态图标按钮 | **删除**（内容移除后图标无意义；`Keyboard` 图标 import 一并清理） |
| `footerStatusLabel` 的 idle 分支 | 不再产出 idle 文案（`MessageInput.tsx:121-128`） |
| `hintRunning` / `hintRunningQueue` | **保留**（running 态功能性状态，与强度控件无空间冲突） |
| 双档折叠测量逻辑 | **保留**（running 态仍需折叠降级，§2.7） |
| `handleEnter` 键位行为 | **不变**（仅删提示，不改行为） |

**必须保留的运行态内容（`showActivity` 分支内，与 `hintIdle` 无关）** —— 实现时勿连同 idle 提示一起删除：

| 保留项 | 来源字段 | 渲染类名 |
|--------|----------|----------|
| 「生成中」等运行状态标签 | `runningStatus`（经 `activitySummary`） | `.composer-status__label` |
| 运行详情 | `runningDetail` | `.composer-status__detail` |
| **耗时** | `runningElapsed` | `.composer-status__elapsed` |
| 队列条数 | `queueCount` | `.composer-status__queue` |
| 脉冲点（展开态） | — | `.composer-status__pulse` |
| 脉冲点（折叠态） | — | `.composer-status-trigger-dot` |

**变量改法（仅此一处受 idle 影响）：**

```diff
  const hintText = running
    ? canQueueSend ? t('input.hintRunningQueue') : t('input.hintRunning')
-   : t('input.hintIdle')
+   : ''   // idle 无提示文案；详见 §2.7
```

idle 时 `footerStatusLabel`（`MessageInput.tsx:121-128`）随之返回空串，据此判定该区域是否渲染。

**实现提示：** idle 态整块不渲染后，`checkOverflow` 会因测量元素为空而 early return（`MessageInput.tsx:304-305`，`if (!container || !measure) return`），`statusCollapsed` 可能**残留上次的值**。虽 idle 不渲染故无视觉影响，但从 idle 转回 running 的首帧可能用旧值闪烁；建议 idle 时重置 `statusCollapsed = false`。

**已知取舍（如实记录）：** 移除后 **Shift+Enter 换行** 的信息失去落点。判断为聊天产品通用约定、多数用户可自行发现；若后续需补，可置于「设置 → 通用」的帮助文案。**不得**因此改动键位行为。

**草稿保持模式（实现参考）**：`src/renderer/services/sessionModelBinding.ts` 中 `resolveSessionModelBinding(cfg, session, draftOption)` 已实现该模式，建议新增同构的 `resolveSessionThinkingBinding(cfg, session, draftEffort)`，避免另起一套逻辑。

### 5.3 能力标记 `supportsThinking`（设置页）

**背景约束：** 模型列表是一张 7 列表格，除首列启用与末列删除外**均为只读展示**（§2.4）；且已有「快速 / 视觉」两列占用能力位。因此**不新增「思考」列**（论据详见 §2.4 的宽度事实更正）。

| 项 | 规格 |
|----|------|
| 列表展示 | **仅当 `supportsThinking === false`** 时，在模型名后跟一个弱化小标记（如 `无思考`），`title` 说明「该模型不支持 Thinking，强度设置对其无效」 |
| 不展示 | `supportsThinking === undefined` 或 `true` 时**不显示任何徽章**——缺省即支持，给绝大多数模型加正向徽章没有信息量且加剧列宽压力 |
| 可编辑入口 | **仅「添加模型」Popover** 增加复选框「支持 Extended Thinking」，**默认勾选**；写入 `ModelEntry.supportsThinking` |
| 已有模型 | **本期不做**行内编辑入口（列表除启用/删除外均只读，插入可编辑控件会破坏交互范式且无列位）。如需修改，走「删除 + 重新添加」；后续若诉求明确，再评估行内编辑或合并「能力」列方案 |
| 运行时不受影响 | 库中已存在的 `supportsThinking === false` 记录继续生效（装配期降级逻辑不变） |

> **为何默认勾选：** 与运行时语义一致——只有**显式** `false` 才触发降级（`invocationAssembler.ts:187`）。

### 5.4 i18n

| 命名空间 / key | zh-CN | en-US |
|----------------|-------|-------|
| `models.defaults.effortLabel` | `Thinking 强度` | `Thinking effort` |
| `models.defaults.effortHint` | 见 §5.1 | — |
| `models.effort.off` | `关闭` | `Off` |
| `models.effort.low` | `低` | `Low` |
| `models.effort.medium` | `中` | `Medium` |
| `models.effort.high` | `高` | `High` |
| `models.effort.notSupported` | `该模型不支持 Thinking` | `This model does not support thinking` |
| `models.effort.unsupportedBadge` | `无思考` | `No thinking` |
| `models.add.supportsThinking` | `支持 Extended Thinking` | `Supports extended thinking` |
| `composer.thinking.label` | `思考强度` | `Thinking effort` |
| `composer.thinking.inherit` | `默认` | `Default` |
| `composer.thinking.inheritWithGlobal` | `默认（{{effort}}）` | `Default ({{effort}})` |
| `composer.thinking.aria` | `选择思考强度` | `Choose thinking effort` |

档位四项文案（`off/low/medium/high`）在设置页与聊天区复用，建议置于公共命名空间避免两处重复；若当前无合适公共命名空间，则 `config.json` 与 `chat.json` 各定义一套。

> 旧键 `models.defaults.thinkingLabel` / `thinkingHint` / `thinkingAria` 在迁移期保留（读旧配置的兼容路径），发布一个周期后清理。

### 5.5 脏检测与保存

- `ConfigModalSnapshotInput`：`thinkingEnabled: boolean` → `thinkingEffort: AppConfig['thinkingEffort']`；
- `normalizeModels()` 增加 `supportsThinking` 字段（§2.6）；
- 会话级档位属**会话字段**，不进设置页快照（由 `session:update` 独立持久化，无需保存按钮）。

---

## 6. 数据模型与存储

### 6.1 类型变更

```typescript
// src/shared/domainTypes.ts
import type { AgentReasoningEffort } from './agent/invocation'

export interface ModelEntry {
  supportsThinking?: boolean   // 已有，语义不变；本需求只补 UI 入口
  // 不新增 thinkingEffort（模型级已砍，见 §1.3）
  // ...其余不变
}

export interface Session {
  /** Thinking 强度覆盖；缺省 / null = 继承全局 config.thinkingEffort（§4.2 继承语义） */
  thinkingEffort?: AgentReasoningEffort
  // ...其余不变
}

export interface AppConfig {
  models: ModelEntry[]
  /** @deprecated 由 thinkingEnabled 迁移而来，迁移后仅作只读镜像 */
  thinkingEnabled?: boolean
  /** 全局 Thinking 强度（默认值提供者） */
  thinkingEffort: AgentReasoningEffort
}
```

### 6.2 持久化键

| 键 / 列 | 类型 | 说明 |
|---------|------|------|
| `config.thinkingEffort` | string（枚举） | **新增**，全局档位 |
| `config.thinkingEnabled` | string（`'true'`/`'false'`） | **保留只读**，迁移后不再写入（§8.1） |
| `sessions.thinking_effort` | TEXT / NULL | **新增列**；`NULL` = 继承全局（不写入即继承，天然兼容存量会话） |
| `config.models` | JSON | `ModelEntry.supportsThinking` 已在该 JSON 内，无结构变更 |

### 6.3 存储层改动点（实现约束，勿漏）

`Session` 为**列存**（§2.5），三处必须同步：

| # | 位置 | 改动 |
|---|------|------|
| 1 | `electron/database/schema.ts` | 新迁移（**当前至 V16，新增 V17**）：`ALTER TABLE sessions ADD COLUMN thinking_effort TEXT;`；`DB_SCHEMA_VERSION` 同步 → 17；在迁移序列末尾注册（参照 V16 的注册方式） |
| 2 | `electron/database/operations.ts:239-258` | `updateSession` 的 `Pick<Session, ...>` 白名单**加入 `'thinkingEffort'`**，并在 SQL 更新中写入该列（支持写 `null` 以清除覆盖） |
| 3 | `electron/database/operations.ts:162`（INSERT 在 `:207-215`） | `createSession` 的 insert 字段列表加入 `thinking_effort`（供 composer 草稿带入） |
| 4 | `electron/appIpc.ts:733-747` | `session:update` 的 payload 类型加入 `thinkingEffort?: AgentReasoningEffort \| null`，并加对应 patch 分支 |

> ⚠️ 第 2、4 项为**白名单式**实现，漏改不会报错、只会静默不生效，必须列为验收项（§10.3）。

---

## 7. 运行时解析与 provider 映射

### 7.1 解析链（主进程）

在 `resolveTrustedTurnExecutionConfig()`（`electron/turnExecutionConfig.ts`）中解析出**最终档位**：

```typescript
function resolveThinkingEffort(
  globalEffort: AgentReasoningEffort,
  sessionEffort: AgentReasoningEffort | null | undefined,
  modelEntry: ModelEntry | undefined
): AgentReasoningEffort {
  if (modelEntry?.supportsThinking === false) return 'off'      // 能力降级（已有语义）
  return sessionEffort ?? globalEffort                          // 会话 > 全局
}
```

- 替换现有 `enableThinking: getConfigValue(db, 'config.thinkingEnabled') !== 'false'`（`:114`）；
- 会话档位来自 `session.thinkingEffort`（**已由 `getSession` 读出，无需额外查询**）；
- 迁移期**双读**：`config.thinkingEffort` 缺失时由 `config.thinkingEnabled` 推导（§8.1）。

### 7.2 契约下传（替代布尔折叠）

| 层 | 现状 | 改造后 |
|----|------|--------|
| `TurnExecutionConfig` | `enableThinking: boolean`（`assistantFactAggregator.ts:15`） | `thinkingEffort: AgentReasoningEffort`（`enableThinking` 保留一个发布周期做兼容映射） |
| `assembleInvocation` 入参 | `options.enableThinking` | 新增 `effort` 实参由主链路显式传入（装配层兼容映射逻辑保留作兜底） |
| `claudeStreamHandlers.ts:407` | `options: { maxTokens, enableThinking }` | 改为传 `effort: frozen.thinkingEffort` |
| `toolChatLoop` | `reasoningEffort !== 'off' ? adaptive : disabled`（`:793`） | 按下表按档位产出 wire 参数 |

> 装配层已有的兼容映射（`materials.effort ?? (enableThinking === true ? 'medium' : 'off')`，`invocationAssembler.ts:181-182`）在迁移窗口内**保留**，但主链路必须改为显式传 `effort`，否则档位仍然不可达。

日志同步：`electron/toolChatLoop.ts:1035` 的 `llm.request` 事件字段 `enableThinking` 改为 `effort`（便于按档位排查）。

### 7.3 档位 → wire 参数映射（核心）

| effort | `thinking` | `output_config` | 说明 |
|--------|-----------|-----------------|------|
| `off` | `{ type: 'disabled' }` | 不发送 | 与现网 `off` 行为一致 |
| `low` | `{ type: 'adaptive' }` | `{ effort: 'low' }` | 最短思考 |
| `medium` | `{ type: 'adaptive' }` | `{ effort: 'medium' }` | **缺省档** |
| `high` | `{ type: 'adaptive' }` | `{ effort: 'high' }` | 完整推理 |

- **字段顺序约定**：`claudeToolLoopStreamParams` 现约定「固定字段在前、`thinking` 置尾，便于上游前缀 / KV 缓存对齐」（该文件顶部注释 + `claudeToolLoopStreamParams.test.ts:44` 断言键序）。扩展为 `... , output_config, thinking`（`thinking` 仍为最后一名）；
- `output_config` 目前仅承载 `effort`；实现时须**合并而非覆盖**其他 `output_config` 用途（如 structured outputs），避免后续冲突；
- `ToolLoopThinkingConfig` 类型（`claudeToolLoopStreamParams.ts:5`）需扩展以承载 `output_config`，映射逻辑集中在 `buildClaudeToolLoopStreamParams` / `buildClaudeNarrativeCompletionParams`，**不散落在业务代码里**。

> **C2 结论（v1.4）：已证实，不再是待实测项。** `thinking: { type: 'adaptive' }` 与 `output_config.effort` 同发，是**官方推荐写法**（adaptive thinking 迁移示例即 A + C 同发，见 §2.3 代码块），两字段正交成立。
>
> **证据强度（如实标注）**：证据来自公开社区解读与官方迁移示例（2026 年，知乎多篇：*Claude 提示工程最佳实践 · 完整参考笔记*、*[Claude Code源码学习]Thinking 与推理控制*、*Claude 5.1 发布* 等），**非本地 SDK 可直接验证**；SDK 侧只能证明「类型上两字段独立、无互斥」。因此「官方是否允许」已闭合，但本产品实际发出的 wire 产物仍需断言——§10.3 的抓包验收**保留**，其职责已从「确认官方语义」改为「验证本产品请求体符合预期（含自身键序约定）」。

### 7.4 上游不支持强度字段时的降级（fail-soft + 会话内记忆）

`output_config` 在部分中转网关上可能不被识别（400 / 参数被拒 / 静默忽略）。

| 场景 | 行为 |
|------|------|
| 首次请求带 `output_config.effort` 被拒（明确未知字段类错误） | **自动重试一次**：去掉 `output_config`，保留 `thinking: { type: 'adaptive' }`（退化为 medium 语义） |
| 重试仍失败 | 按既有错误路径上抛（`回复未能完成` / 错误态），不静默吞掉 |
| 审计 | 记 `llm.effort.unsupported`，含 `{ model, llmServiceId, requestedEffort, fallback: 'adaptive' }` |
| **会话内记忆（OQ-6 决策：做）** | 主进程维护进程内 `Map<string, true>`，**key = `llmServiceId + model`（非仅 `llmServiceId`，见 C1）**；命中过该错误后，本进程内不再对**该服务下的该模型**附加 `output_config`，避免每轮都重试一次，同时不误伤同服务下其他支持该字段的模型。进程重启即清空（免去 TTL 与「网关已修复」的失效判断），首次跳过时落一次 `llm.effort.unsupported_memoized` 审计 |

> 该降级只处理「强度字段不被识别」，**不得**掩盖真正的模型不可用 / 鉴权失败（沿用 `turnExecutionConfig` 的 fail-fast 语义）。

**关于 beta header（v1.4 补）**：社区对 Claude Code 源码的解读显示其注入 effort 时会附带 `EFFORT_BETA_HEADER`（`configureEffortParams` 中 `betas.push(...)`）。但 SDK 0.79.0 的**非 beta** `MessageCreateParamsBase.output_config`（`messages.d.ts:1881`）同样声明该字段，官方迁移示例也未要求额外 header。**结论：走 GA 端点（本项目现用的 `anthropic.messages.stream`）无需手动附加 beta header。** 若实测遇到「字段被静默忽略且无报错」，再评估补 header；会话中途改档所需的 `mid-conversation-output-config-*` 头**本需求用不到**（不支持 mid-conversation 改档，见 §3.2 非目标）。

### 7.5 预算式回退：本期不做（OQ-2 决策）

`thinking: { type: 'enabled', budget_tokens: N }` 作为兜底路径**本期不实现**，理由：

1. 三个预算数字（如 4096 / 16384 / 32768）是自定义的，与官方 `effort` 的真实语义不对应；
2. 受 SDK 硬约束 `1024 ≤ budget_tokens < max_tokens`，且**占用 `max_tokens` 总预算**（类型注释原文：*Requires a minimum budget of 1,024 tokens and counts towards your `max_tokens` limit*）。用户输出上限设得低时（本项目存在工具循环 `max_tokens` 下限逻辑）需钳制，可能导致高档位名不副实；
3. 上游不认 `output_config` 时退化为 `adaptive` 已足够（即现状行为，不会更差）。

后续若确需，另立需求，并需先核对项目内 `maxTokens` 的实际取值分布。

### 7.6 按 lane 的档位边界（**本需求的关键边界，v1.5 修正**）

effort 解析结果**并非所有 lane 都消费**。当前只有 **desktop lane** 把解析出的档位送到真正发请求的装配入参；其余三条 lane 的装配点**根本没有 thinking 参数**：

| lane | `resolveTrustedTurnExecutionConfig` | 实际装配点 | 装配入参中的 thinking | 档位是否生效 |
|------|-------------------------------------|-----------|---------------------|-------------|
| **desktop** | `appIpc.ts:940` → 传入 `claudeStreamHandlers.ts:407` | 同一 frozen config | ✅ `options: { maxTokens, enableThinking }` | ✅ 生效 |
| **feishu** | `feishu/remoteCommandRouter.ts:661` | `remote/imRemoteAgent.ts:129` | ❌ `options: { maxTokens: 8192 }`（`:141`） | ❌ 不生效 |
| **wechat** | `wechat/weChatCommandRouter.ts:363` | 同上（`runImRemoteAgent`） | ❌ 同上 | ❌ 不生效 |
| **automation**（butler） | `butler/butlerInvoker.ts:139` | `butlerInvoker.ts:255` | ❌ `options: { maxTokens: 8192 }`（`:269`） | ❌ 不生效 |

**事实澄清（v1.5 更正 v1.3 的 C3 结论）**：v1.3 曾断言四条 lane「均经统一解析、无绕过路径」。**该结论只对「调用点」成立，对「产出是否生效」不成立**——远程与 Butler 的 router 虽调用了统一解析函数，但其结果中的 thinking 字段被丢弃；且 `imRemoteAgent.ts:125` / `butlerInvoker.ts` 会**自行重新解析** model 与 credentials，即这两条 lane 从未接入冻结执行配置的完整产出。

**后果**：今天飞书 / 微信 / Butler 的 turn **无论全局 `thinkingEnabled` 开关如何，thinking 恒为关**（装配层兜底 `options.enableThinking === true ? 'medium' : 'off'`，`invocationAssembler.ts:181-182`，实参 `undefined` → `'off'`）。

**本期决策（OQ-10）：保持 `off`，不接通。** 理由：

1. IM 场景追求快速回复，长思考与其相悖；
2. 接通会使 IM / Butler 从「实际 always-off」变为「跟随全局 medium」，**属行为变更**，与 R6（升级后行为不变）冲突；
3. 那是「修复既有缺陷」，应独立立项；本需求目标是「能调低」而非「让所有 lane 都能思考」。

**因此档位的语义边界是：**

```
档位（全局默认 / 会话覆盖）→ 仅对 desktop lane（用户直接发起的主对话）生效
远程（feishu / wechat）与 Butler  lane → 恒 off（与现网一致，不受本需求影响）
审批等子调用           → 恒 off（§7.7，既有规则）
```

**同一会话在不同 lane 下的表现**：用户在桌面打开一个 IM 来源会话并调档，仅影响其**桌面**发起的 turn；该会话的 IM turn 仍为 `off`。即档位**按 lane 生效，而非按会话全局生效**——这是有意设计，与 §7.7 子调用恒 `off` 同一模式。

> 若后续决定接通（方案 A），需额外改动：`remote/imRemoteAgent.ts`、`feishu/feishuRemoteAgent.ts`、`wechat/weChatRemoteAgent.ts`、`butler/butlerInvoker.ts` 四处装配入参，并显式立项记录该行为变更。

### 7.7 子调用与安全边界（不变）

- 审批 Agent 等子调用保持 `effort: 'off'`（`electron/confirmation/approvalAgent.ts:292`，零成本档，基线 §5.4 规则 5）——**本需求不放开**；
- 不提供任何「子调用强制高档」入口；
- 能力降级仍走 `agent.profile.reasoning_degraded` 审计（已有）。

---

## 8. 迁移与兼容

### 8.1 全局配置升级（**启动时一次性写入**）

**触发点（C4 决策）：** 固定在**应用启动迁移**（与 DB schema 迁移同期）写入一次；`config:get` **只做「缺失时推导」的读兜底，不落库**——避免读路径副作用与双写窗口（`config:get` 被渲染层高频调用）。

| 旧值 | 新值 `config.thinkingEffort` | 依据 |
|------|------------------------------|------|
| `config.thinkingEnabled === 'false'` | `off` | 原语义「关闭」 |
| `config.thinkingEnabled === 'true'` | `medium` | 与装配层兼容映射 `true → 'medium'` **完全一致**，保证行为等价 |
| 键缺失 | `medium` | 现网 `getConfigValue(...) !== 'false'` 即「默认开启」，对应 medium |

- 迁移**只写一次**：写入 `config.thinkingEffort` 后，`thinkingEnabled` 保留为只读镜像，不再参与运行。

### 8.2 会话层：无需回填（与全局迁移不同）

老会话 `thinking_effort` 为 `NULL`，语义正好是「未覆盖 = 继承全局」，**因此不需要任何数据回填**，也不会因迁移而改变行为。

> 注意：**不得**按全局当前值把存量会话逐个写成显式档位——那会把「继承」变成「快照」，导致后续改全局对老会话失效（§4.2）。

### 8.3 类型兼容

| 字段 | 处理 |
|------|------|
| `AppConfig.thinkingEnabled` | 标 `@deprecated`，迁移后仅作只读镜像 |
| `TurnExecutionConfig.enableThinking` | 标 `@deprecated`，保留一个发布周期的兼容映射 |
| `options.enableThinking`（`AgentInvocationProfile` / `toolChatLoop` / `api.ts:142` / `assistantFactAggregator.ts:15` / `toolLoopModelOptions.ts`） | 同上，迁移期后删除 |
| `ModelEntry.supportsThinking` | 无变化（缺省 = 支持） |
| `Session.thinkingEffort` | 新增可选；缺省 = 继承 |

### 8.4 校验规则（**净新增**）

> ⚠️ `config:set` **没有统一校验框架**，只有零散逐字段校验；`thinkingEnabled` 本身**完全无校验**——非 boolean 会被 `String()` 静默强转（`appIpc.ts:1674`）。故本节校验均为**净新增工作**，需在 `config:set` 内新增档位枚举校验分支（§12 已列为改动点）。

| 规则 | 处理 |
|------|------|
| `config.thinkingEffort ∈ {'off','low','medium','high'}` | 否则**拒绝保存**并提示（`config:set` 新增校验分支） |
| `session:update` 的 `thinkingEffort` | 允许 `null`（清除覆盖）或四档之一；非法值拒绝并提示 |
| `supportsThinking === false` 的模型配了非 `off` 档位 | 无需拒绝（运行时本就降级为 `off`），但设置页应给出提示（§5.3 弱化标记）以解释「调了没效果」 |

---

## 9. 边界与异常

| 场景 | 预期行为 |
|------|----------|
| 全局 `off`，会话覆盖为 `high` | 该会话用 `high`（会话级优先级更高）——**允许**，展示上不显示为「继承」 |
| 全局被调低，会话无覆盖 | 全部未覆盖会话随之变化（继承语义，§4.2） |
| 会话已覆盖，用户改全局 | 该会话**不受影响**（覆盖优先） |
| 会话覆盖控件选「默认」 | 清除覆盖，回到继承；展示态变为 `默认（<当前全局>）` |
| 当前会话模型 `supportsThinking === false`，会话覆盖为 `high` | 实际 `off`；控件禁用 + 「该模型不支持 Thinking」；审计 `reasoning_degraded` |
| 会话中途换模型（如切到不支持 Thinking 的模型） | 档位按**当前模型**重新走 ③ 能力校验；覆盖值保留（换回原模型时恢复） |
| 上游 400 拒绝 `output_config` | 见 §7.4：去掉强度重试一次 + 审计；**同服务同模型**后续请求跳过 `output_config`（进程内记忆，粒度见 §7.4 / OQ-6） |
| 会话级调整发生在 turn 进行中 | 不影响进行中的 turn（发起时冻结），下次发送生效 |
| 远程会话（飞书 / 微信） | 无 composer 入口；**本期 thinking 恒 `off`**（OQ-10，§7.6），不继承全局、不读会话覆盖。桌面打开该会话时控件可见、可调，但**仅对其桌面 turn 生效**；IM turn 仍为 `off`。**勿误读为「继承全局」**——v1.3 的 C3 结论已被 v1.5 更正 |
| composer 在首个会话创建前选择了档位 | 草稿保留，随会话创建一并写入（§5.2、§6.3 第 3 项） |
| 窄窗口 / 面板拖宽 | idle 态状态区不再渲染；running 态空间不足时折叠为 22px 图标按钮（既有机制，§2.7） |
| 移除 Enter 提示后 | Shift+Enter 信息失去落点（已知取舍，§5.2.1 / OQ-9）；键位行为不变 |
| 旧的 `thinkingEnabled` 与新的 `thinkingEffort` 同时存在 | 以 `thinkingEffort` 为准（`thinkingEnabled` 只读） |
| 会话模型回退 / 视觉路由切换 | 档位按**切换后的目标模型**重新解析（沿用 `resolveTrustedTurnExecutionConfig` 的重绑顺序） |

---

## 10. 验收标准

### 10.1 设置页

- [ ] 「大模型设置」区出现「Thinking 强度」选择器，含 关闭 / 低 / 中 / 高 四项，默认「中」
- [ ] 原「默认开启 Thinking」Switch 已移除
- [ ] 添加模型 Popover 有「支持 Extended Thinking」复选框，默认勾选，可写入 `supportsThinking`
- [ ] `supportsThinking === false` 的模型在列表中显示弱化「无思考」标记，且未新增第 8 列
- [ ] 区块 intro 文案已更新为强度表述
- [ ] 切换语言后，上述所有文案在 zh-CN / en-US 下均正确（无 hardcode、无 key 泄漏）

### 10.2 聊天区（会话级）

- [ ] composer 有思考强度入口；点击弹出 5 项（默认 / 关闭 / 低 / 中 / 高）
- [ ] 未覆盖时展示 `默认（<当前全局档位>）`
- [ ] 选择后写入 `Session.thinkingEffort`，**重开会话后仍保持**
- [ ] 选择「默认」可清除覆盖，展示态回到 `默认（<全局>）`
- [ ] 切换会话时，控件展示与各自会话的档位一致（会话 A 低、会话 B 默认，互不串）
- [ ] 当前会话模型 `supportsThinking === false` 时控件禁用并提示
- [ ] 首个会话创建前选择档位，该选择随会话创建写入（草稿保持）
- [ ] composer 不再显示「Enter 发送，Shift+Enter 换行」提示，且 idle 态该区域**不占位**
- [ ] **running 态仍显示「生成中」等运行状态标签与耗时**（回归重点，§5.2.1 保留清单）
- [ ] running 态仍显示队列条数（有多条排队时）
- [ ] running 态仍显示「点击停止按钮中止」/「Enter 发送并排队」
- [ ] running 态空间不足时折叠为图标按钮，且折叠态显示**脉冲点**（非键盘图标）
- [ ] Enter / Shift+Enter 的**实际行为**未变（发送 / 换行）

### 10.3 运行时（**本需求的核心验收**）

- [ ] 全局 `high`：抓包 / 日志确认请求含 `output_config: { effort: 'high' }`
- [ ] 全局 `low`：请求含 `{ effort: 'low' }`，且与 `high` 的请求体**不相等**（证明档位未被折叠）
- [ ] 全局 `off`：请求为 `thinking: { type: 'disabled' }`，**不含** `output_config`
- [ ] **会话 A 覆盖 `low` + 全局 `high`**：会话 A 的请求发 `low`，会话 B（无覆盖）发 `high`
- [ ] 全局由 `high` 改为 `low` 后，**未覆盖的存量会话**随之变为 `low`（继承语义，非快照）
- [ ] 已覆盖的会话在全局改动后**保持不变**
- [ ] `supportsThinking === false` + 全局 `high`：该模型实际 `off`，且落 `agent.profile.reasoning_degraded`
- [ ] 上游拒绝 `output_config`：自动去强度重试成功，落 `llm.effort.unsupported`；**同服务同模型**后续请求不再附加 `output_config`（记忆生效），**同服务其他模型不受影响**（记忆粒度为 `llmServiceId + model`，§7.4 / OQ-6）
- [ ] **远程 / Butler lane 恒 `off`**（OQ-10）：飞书 / 微信 / Butler 的 turn 请求**不含** `output_config`，且 `thinking: { type: 'disabled' }`，与升级前一致
- [ ] 同一 IM 来源会话：桌面 turn 按档位、IM turn 仍 `off`（§7.6 lane 边界）
- [ ] 审批 Agent 等子调用仍为 `off`（回归不破）
- [ ] `llm.request` 日志记录实际档位（不再是布尔）

### 10.4 配置与迁移

- [ ] 旧库（`thinkingEnabled='true'`）升级后 `thinkingEffort='medium'`，行为与升级前一致
- [ ] 旧库（`thinkingEnabled='false'`）升级后 `thinkingEffort='off'`
- [ ] 存量会话升级后 `thinking_effort` 为 `NULL`，且**未被批量回填**为显式值
- [ ] `sessions` 表新增列迁移**版本号正确**（当前基线 V16 → 新增 **V17**，不与既有 V15 butler / V16 usage 重号），老库升级无报错
- [ ] 迁移可重复执行（幂等）
- [ ] 迁移在**启动时一次性写入**（非 `config:get` 读路径副作用），`config:get` 仅做缺失推导不落库
- [ ] 修改全局强度 / `supportsThinking` 后，**保存按钮正确启用**（脏检测覆盖新字段）
- [ ] `session:update` 传 `thinkingEffort` 后**确实落库**（白名单已补，非静默无效）
- [ ] 非法档位值保存 / 更新被拒并提示
- [ ] 重启应用后，全局档位与各会话档位均正确持久化

### 10.5 效果（体验目标）

- [ ] 对同一「过度思考」模型，**`high` → `low`**：首字延迟与 reasoning token 明显下降（抽样对比，非硬指标）
- [ ] 调低后思考过程仍可在 `ThinkingBlock` 正常展示（`low` 不等于不展示）
- [ ] **已知档位非等距**（§4.1）：`medium` → `low` 的变化可能不明显，**不作为验收失败项**；对外口径不得承诺「降一档必然更快」

---

## 11. 已决事项（原 OQ）

| ID | 问题 | 决定 |
|----|------|------|
| **OQ-1** | 是否暴露 SDK 的 `effort: 'max'` | **否**，只暴露四档 `关闭 / 低 / 中 / 高`；如需 `max`，先扩 `AgentReasoningEffort`。**v1.4 补**：服务端实际另有 `xhigh`（位于 `high` 与 `max` 之间），SDK 0.79.0 枚举未含；同样不暴露。四档已覆盖「省 → 均衡 → 尽力」的全部产品语义，而 `xhigh` / `max` 属成本翻倍档（社区实测成本倍率约 1.6–1.9×），不适合作为常规用户选项 |
| **OQ-2** | 是否实现 `thinking.enabled + budget_tokens` 回退路径 | **否**，本期只做 `adaptive + output_config.effort`；理由见 §7.5（自定义数字不对应官方语义 + 占用 `max_tokens` 且受 `< max_tokens` 硬约束） |
| **OQ-3** | 默认档取 `medium` 还是 `low` | **`medium`**（与现网「默认开启」等价迁移） |
| **OQ-4** | 作用域：是否做会话级覆盖 | **做**。作用域定为 **全局默认 + 会话级覆盖** 两层（§1.3、§4.2） |
| **OQ-5** | 是否做模型级覆盖 | **不做**。理由：与「切模型」语义重叠、引入三层优先级认知负担、痛点生命周期是单次任务（§1.3）。`supportsThinking` 作为**能力**保留，但不是强度设置（§5.3） |
| **OQ-6** | 是否对不支持 `output_config` 的服务做记忆 | **做**。进程内 `Map<'llmServiceId + model', true>`，重启清空（§7.4）。C1 评审后粒度由「仅服务」收窄为「服务 + 模型」，避免同服务下其他模型的强度控制被连坐禁用 |
| **OQ-7** | 是否加「Thinking 总开关」 | **不加**，`关闭` 已是档位之一，避免语义重叠（§5.1） |
| **OQ-8**（v1.1 新增） | 是否新增模型列表「思考」列 | **不加**。**论据（v1.3 更正）**：该表除首 / 末列外均为只读展示，插入可编辑控件破坏交互范式；能力位已有快速 / 视觉两列（i18n 亦预留 `models.list.colCaps` 合并位）。改为「仅不支持时显示弱化标记」（§5.3、§2.4）。原「560px 空间不足」论据**不成立**——设置页已是整页 `ConfigSettingsPage`（720px），非 Modal |
| **OQ-9**（v1.2 新增） | 是否保留 composer「Enter 发送，Shift+Enter 换行」提示 | **移除**（方案 B）。idle 态整块不渲染以腾位给强度控件；`hintRunning*` 保留；已知取舍：Shift+Enter 信息失去落点（§5.2.1、§2.7）。评审曾提方案 A（保留、由既有折叠机制自然让位），但产品判定该提示价值低于强度控件的落位需求，最终选 B |
| **OQ-10**（v1.5 新增） | 是否接通远程（飞书 / 微信）与 Butler lane 的 thinking | **否，本期固定 `off`**（**v1.6 产品确认保留方案 B**）。这两条 lane 的装配点本就无 thinking 入参（`imRemoteAgent.ts:141`、`butlerInvoker.ts:269`），实际恒 `off`；接通会使 IM / Butler 从 always-off 变为跟随全局，属**行为变更**（与 R6 冲突）且超出本需求目标。档位语义边界见 §7.6。若后续要接通，走方案 A 独立立项（需另改 4 个文件并记录行为变更） |

### 11.1 评审项闭环（B / C 项）

**v1.2 评审报告**（`docs/review/thinking-effort-settings-requirement-review.md`）—— B1 / N1–N5 / C1–C4：

| 项 | 问题 | 处置 |
|----|------|------|
| **B1** | 迁移版本号误写为「V14 → V15」，实际基线 V16 | **已修复**（v1.3）：四处统一改为 V16 → V17（§2.5、§6.3、§10.4、§12） |
| **C1** | 进程内记忆粒度按 `llmServiceId`，同服务下其他模型会被连坐禁用 | **已采纳**：key 改为 `llmServiceId + model`（§7.4、OQ-6） |
| **C2** | `adaptive + output_config` 同发语义未经官方注释明示，属推断 | **已闭合**：由官方迁移示例证实（§2.3、§7.3）；§10.3 抓包验收保留，职责改为验证本产品 wire 产物 |
| **C3** | 远程会话链路是否同样经过统一解析 | **v1.5 更正为「前提不成立」**——详见下表 |
| **C4** | 迁移触发点「启动或 `config:get` 时」需二选一 | **已明确**：固定为启动时一次性写入，`config:get` 只做缺失推导不落库（§8.1） |

**v1.4 复审报告**（`docs/review/thinking-effort-settings-requirement-review-v1.4.md`）—— B1' / N1–N3：

| 项 | 问题 | 处置 |
|----|------|------|
| **B1'** | v1.3 关闭 C3 时只核验「是否调用统一解析」，未追「产出是否到达装配入参」，导致「无绕过路径」结论失真 | **已修复**（v1.5）：核实三条非桌面 lane 装配点确无 thinking 入参；新增 **OQ-10** 决策（本期固定 `off`、不接通）；§7.6 改写为「按 lane 的档位边界」；§9 更正；§10.3 补验收；§12 标注两文件「本期不改」 |
| **N1** | §10.3 验收口径仍写「同一服务」，未同步 C1 的新粒度 | **已修复**：改为「同服务同模型」+「同服务其他模型不受影响」（§10.3） |
| **N2** | §2.3 表头「三条强度控制路径」与表中四行不符 | **已修复**：改为「四条」（§2.3） |
| **N3** | v1.4 外部事实（`xhigh`、`low ≈ medium`、成本倍率）被转化为验收基准，若官方口径变化需回改 | **已声明**：§2.3 / §4.1 / §10.5 与 §11.1 来源表均标注「以官方为准，若不符则回改」 |

> **关于 v1.3 的 C3 失误**：该结论的错误不在「事实错误」（四条 lane 确实都调用了统一解析函数），而在**核验深度**——停在调用点、未追数据流到装配入参。这是本次记录的主要教训：**「函数被调用」不等于「产出被消费」**。同类判断今后需追到最终消费点。

> **C2 证据来源与可信度声明**：结论依据 2026 年公开社区解读与官方迁移示例，**非本地 SDK 可验证**；本地 SDK 侧仅能证明「两字段类型独立、无互斥」。来源（title / url / author）：
>
> | 用途 | title | url | author |
> |------|-------|-----|--------|
> | 官方 adaptive + effort 迁移示例 | Claude 提示工程最佳实践 · 完整参考笔记 | https://zhuanlan.zhihu.com/p/2042310403892500251 | 电话微波炉 |
> | `configureEffortParams` 源码、默认 effort、beta header | [Claude Code源码学习]Thinking 与推理控制 — 让模型"想"多少 | https://zhuanlan.zhihu.com/p/2032554806959674059 | Luis |
> | Simon Willison 五档实测（`low ≈ medium`）、per-message effort beta | Claude Fable 5.1 发布，一个模型两种安全档，账单最多省 45% | https://zhuanlan.zhihu.com/p/2078465038671688340 | 若风科技说 |
> | `xhigh` 档位、effort 控制单步推理强度 | Anthropic 发布 Claude Opus 4.7，性能如何？ | https://www.zhihu.com/question/2028243941196054744/answer/2028249476632953084 | 小小将 |
> | effort 影响工具调用频率等全局开销 | 同一模型如何被调节出不同表现：大模型 Effort 参数 | https://zhuanlan.zhihu.com/p/2055749979646513195 | 数据与AI爱好者 |
> | effort 成本倍率表（low 0.60 / high 1.00 / max 1.91） | Claude订阅刷新了，原来是Fable 5.1 来了 | https://zhuanlan.zhihu.com/p/2078321372179314170 | 诸葛青人不错 |
>
> 上述为社区解读（部分直接引用源码与官方示例），**非一手官方文档**；若后续官方文档口径与此不符，以官方为准并回改 §2.3 / §7.3。

---

## 12. 相关文件

| 文件 | 变更类型 |
|------|----------|
| `src/shared/domainTypes.ts` | `AppConfig.thinkingEffort`（`thinkingEnabled` 标 deprecated）；`Session.thinkingEffort?`；`ModelEntry` 不变 |
| `src/shared/agent/invocation.ts` | 复用 `AgentReasoningEffort` / `AgentReasoningProfile`（无结构变更） |
| `src/shared/assistantFactAggregator.ts` | `TurnExecutionConfig.thinkingEffort`（`enableThinking` 过渡保留） |
| `src/shared/api.ts` | `options.enableThinking` → effort（迁移窗口内兼容） |
| `electron/turnExecutionConfig.ts` | 解析最终档位（会话 > 全局 > medium；能力降级），替换 `:114` 的布尔推导 |
| `electron/remote/imRemoteAgent.ts` | **本期不改**（OQ-10 豁免）：其 `:141` 装配入参无 thinking；若走方案 A 需在此透传档位 |
| `electron/butler/butlerInvoker.ts` | **本期不改**（OQ-10 豁免）：其 `:269` 同上 |
| `electron/claudeStreamHandlers.ts` | `:407` 改为传 `effort`（不再只传 `enableThinking`） |
| `electron/runtime/invocationAssembler.ts` | 实参 `effort` 接通（`:181-182` 兼容映射保留） |
| `electron/claudeToolLoopStreamParams.ts` | 生成 `output_config`；键序约定扩展为 `... , output_config, thinking`；`ToolLoopThinkingConfig` 扩展 |
| `electron/toolChatLoop.ts` | `:793` 按 §7.3 映射替换布尔折叠；`:1035` 日志字段改 `effort`；`llm.effort.unsupported` 审计 + 去强度重试 + 进程内记忆 |
| `electron/toolLoopModelOptions.ts` | **待扩展的改动锚点**：现仅 13 行、只解析 `maxTokens` 与布尔 `enableThinking`，**不存在**布尔→档位映射逻辑；需改为解析 / 传递 effort（迁移期兼容） |
| `electron/database/schema.ts` | 新迁移（**V17**，当前基线 V16）：`ALTER TABLE sessions ADD COLUMN thinking_effort TEXT;`；`DB_SCHEMA_VERSION` → 17 |
| `electron/database/operations.ts` | `:239-258` `updateSession` 白名单加 `'thinkingEffort'` + SQL 写入（支持 `null`）；`createSession`（`:162` 起，INSERT `:207-215`）insert 加该列 |
| `electron/appIpc.ts` | `config:get`/`config:set` 读写 `thinkingEffort`（读取行 `:1253`；实际写入点在 `:1674` 附近）；**新增档位枚举校验分支**（现网 `thinkingEnabled` 无校验、`String()` 静默强转，见 §8.4）；`:733-747` `session:update` payload 加字段 + patch 分支；**启动迁移**逻辑（非 `config:get` 内落库） |
| `src/renderer/components/Config/ModelsSettingsTab.tsx` | `:413-423` Switch → 强度 Select；`:420` 附近条件渲染「无思考」标记；添加模型 Popover 加复选框 |
| `src/renderer/components/Config/configModalSnapshot.ts` | `thinkingEnabled` → `thinkingEffort`；`normalizeModels()` 补 `supportsThinking`（`:40-53`） |
| `src/renderer/components/Chat/`（新增组件，如 `ComposerThinkingPicker`） | 会话级档位入口 + Popover 列表 |
| `src/renderer/components/Chat/MessageInput.tsx` | 插入强度控件（模型 chip 之后、状态区之前）；idle 态状态区不渲染、移除 idle 折叠图标按钮（§5.2.1）；**保留** running 态折叠测量逻辑 |
| `src/renderer/theme/layout.css` | 新控件样式。**无需清理 idle 专用样式**（v1.3 更正）：现网 `.composer-status` 基类 / `--measure` / `__hint` 均为共用，唯一状态限定的 `.composer-status--running .composer-status__hint`（`:1462`）是 **running 专用**，不存在 idle-only 规则 |
| `src/renderer/services/sessionModelBinding.ts`（或新增同构模块） | `resolveSessionThinkingBinding(cfg, session, draftEffort)`，含草稿保持 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/config.json` | 设置页文案（§5.4） |
| `src/renderer/i18n/resources/{zh-CN,en-US}/chat.json` | 聊天区文案（§5.4）；**删除 `input.hintIdle`**；保留 `hintRunning` / `hintRunningQueue` |
| `docs/requirement/composer-hint-responsive-requirement.md` | **实现已演进（§2.7），描述过时**：需重写为「折叠式状态区」或废弃 |
| `docs/requirement/settings-requirement.md` | §3.3「默认开启 Thinking」更新为「Thinking 强度」 |
| `docs/requirement/llm-multi-service-model-config-requirement.md` | §5.2 区段顺序中的 Thinking 项同步为强度选择器 |
| `docs/develop/agent-core-contract-path-refactor-plan.md` | P4 范围说明中「设置页 UI 选择器独立排期」回填本文档链接 |

---

*文档结束*
