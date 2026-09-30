# Composer 模型 / 思考强度合并入口 — 产品需求规格

**日期：** 2026-09-30
**状态：** 需求已定稿（全部决策闭环，见 §10）
**需求来源：** 用户口述（聊天输入区两个选择控件合并为单一浮层入口）

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [术语与概念](#3-术语与概念)
4. [功能需求](#4-功能需求)
5. [交互规格](#5-交互规格)
6. [技术方案](#6-技术方案)
7. [影响面与兼容](#7-影响面与兼容)
8. [边界与异常](#8-边界与异常)
9. [验收标准](#9-验收标准)
10. [决策记录](#10-决策记录)
11. [相关文件](#11-相关文件)

---

## 1. 概述

### 1.1 需求原文（用户口述，逐条落地）

> 1. 现在界面输入框里，模型选择和推理强度的框都铺开占据横向空间，让下面太挤了。
> 2. 我想把他们改到一个入口，点击以后弹出浮层，上面是模型选择，下面是推理强度选择。
> 3. 这样非展开的状态下这两个选项的入口能精简一点。
> 4. 非展开状态下，模型不用显示「服务商-模型名称」，而是只显示模型名称就好。

> **术语注**：原话中的「非展开状态」＝本档的**收起态**（入口 chip 未被点击、浮层未打开），**与窗口宽度无关**——请勿与窄窗口下的「状态区折叠」混淆，二者区分见 §3。

### 1.2 背景

聊天区 composer footer 左段（`.composer-footer__start`）当前串联了 **两个独立的 chip**：

| 控件 | 组件 | 收起态展示 |
|------|------|-----------|
| 模型选择 | `ComposerModelPicker` | `服务商-模型名`（`displayName`，如 `Deep-deepseek-v4-pro`） |
| 思考强度选择 | `ComposerThinkingPicker` | `默认（中）` 或 `低` 等档位文案 |

两者各自是一个 Popover 入口（`trigger="click"`），常态下横向并排占位，故收起态是**两个** chip 并排。其中强度控件是本仓库 `thinking-effort-settings-requirement.md` §5.2 的产物，其落位时已因空间不足而**移除了 idle 键盘提示**（同档 §5.2.1）。

### 1.3 本需求要解决的问题

| # | 问题 | 说明 |
|---|------|------|
| P1 | 横向占位过重 | 两个 chip 并排，且模型 chip 主文案含服务名前缀（最长可到 `火山CodingPlan-deepseek-v4-pro` 量级，chip 已靠 `max-width: 220px` + 省略号兜底），挤压同一行的运行状态区（`composer-status`） |
| P2 | 挤压状态区折叠阈值 | `MessageInput.checkOverflow` 的宽度预算把**两个** chip 宽度都算进去（`modelChipRef` + `thinkingChipRef`），导致运行状态文案更早被迫折叠成 22px 图标点 |
| P3 | 低频入口占常驻空间 | 模型与强度都是**低频**设置项，却各自常驻一个可点击 chip |
| P4 | 服务名前缀在收起态无价值 | 收起态空间有限，服务名前缀（歧义消解信息）在常态下信息密度低、宽度代价高 |

### 1.4 目标

| # | 目标 |
|---|------|
| G1 | 模型选择与思考强度选择合并为**单一入口 chip**，点击弹出**一个浮层**，上半区为模型列表、下半区为思考强度 |
| G2 | 收起态入口文案的**模型段只显示模型名称**，不再显示「服务商-模型名称」（**仅**同名跨服务歧义时附服务段，详见 FR3 / §10） |
| G3 | 收起态**恒定显示当前推理强度**（用户日常调节项，需随时可查；§10） |
| G4 | 收起态横向占位**净下降**：模型段去掉服务名前缀、两个 chip 合为一体；虽新增强度文本，整体仍收窄，为运行状态区腾出宽度（宽度估算见 §5.2.1） |
| G5 | 模型与强度的**选择语义、写库路径、生效时机完全不变**（`session.model` / `session.llmServiceId` / `session.thinkingEffort`） |
| G6 | 浮层内保留完整信息（服务名副文案、快速/视觉徽章、「是否继承全局」标记），信息总量不因收起态精简而丢失 |
| G7 | 无障碍不降级：入口有明确 `aria-label` / `aria-expanded`，两个分区可被读屏识别，键盘可达 |
| G8 | **档位枚举由 4 档扩为 5 档**（新增 `max`），使支持更高强度的模型可在 UI 中选到该档（§10 / FR11） |
| G9 | **修正 `ChatModelOption.displayName` 生成规则**，使其符合既定的「仅歧义时加服务名前缀」规则（§10 / FR12） |

### 1.5 非目标

- **不**改模型列表的数据来源、过滤（启用服务 × `supportedModelIds`）与排序规则（见 `llm-multi-service-model-config-requirement.md` §8.1 / §9.2）；
- **不**改会话字段与持久化协议（`session.model` / `llmServiceId` / `thinkingEffort`），不新增字段；
- **不**改运行时档位解析与 provider 映射（`thinking-effort-settings-requirement.md` §7）；
- **不**改设置页全局强度 UI 的**控件形态**（仍为 Select，见 `ModelsSettingsTab.tsx:183`）与 `supportsThinking` 能力标记（同档 §5.3）；⚠️ 仅其**档位项随枚举扩展**由 4 项变 **5 项**（§7.1）；
- **不**改 `ChatModelOption` 除 `displayName`（FR12 修正对象）以外的字段语义（§FR12）；
- **不**为远程（飞书 / 微信）会话新增强度调整入口；
- **不**做模型 / 强度的快捷键、全局搜索入口或自动选档。

---

## 2. 现状分析

### 2.1 收起态结构（现网）

```
.composer-footer                                // flex, space-between, gap 8
├── .composer-footer__start  (leftRowRef)       // flex, nowrap, flex:1, gap 8
│   ├── <button .composer-add-attachment>       // 「+」附件，约 28px
│   ├── <span ref={modelChipRef}>{modelSlot}</span>       // 模型 chip（收起态常驻）
│   ├── <span ref={thinkingChipRef}>{thinkingSlot}</span>  // 思考强度 chip（收起态常驻）
│   ├── .composer-status--measure               // 隐藏测量元素（visibility:hidden + absolute）
│   └── 状态区：展开态 .composer-status ｜ 状态区折叠 button.composer-hint-trigger(22px)
└── .composer-footer__actions                   // ContextUsageRing + 发送 / 停止
```

> 上图末行的「状态区折叠」= `statusCollapsed`，**只作用于运行状态文案**，与上一行的两个 chip 无关（chip 为 `flex-shrink: 0`，窄窗口下不变形、不消失）。

### 2.2 相关组件职责（代码锚点，均已核对）

| 文件 | 符号 | 职责 |
|------|------|------|
| `src/renderer/components/Chat/ComposerModelPicker.tsx` | `ComposerModelPicker` | 模型 chip + `Popover(topLeft)`；列表项结构 = `.composer-model-picker__service`（服务名副文案）+ `.composer-model-picker__model`（模型名）+ `ConfigModelBadges`（快速 / 视觉徽章）；空态 `modelPicker.empty`；chip 文案取 `displayName` 属性 |
| `src/renderer/components/Chat/ComposerThinkingPicker.tsx` | `ComposerThinkingPicker` | 强度 chip + `Popover(topLeft)`；列表直接由常量 `THINKING_EFFORT_LEVELS` 渲染（**固定 4 档、未消费 `resolveThinkingAvailability`**，见 §2.6）；等于全局档位的项带 `· 默认` 标记，点它回调 `null`（清除覆盖）；模型不支持思考时整体 `disabled` 并用外层 `span` 挂 `Tooltip`（评审项 B2） |
| `src/renderer/components/Chat/ChatView.tsx:955-976` | — | 组装 `modelSlot` / `thinkingSlot` 两个 slot 传给 `MessageInput`；`handleModelSelect`(:801) / `handleThinkingSelect`(:817) 负责写库与草稿保持 |
| `src/renderer/components/Chat/MessageInput.tsx` | `modelSlot`(:30) / `thinkingSlot`(:32) | 两个 slot props；`modelChipRef`(:94) / `thinkingChipRef`(:95) 分别测量；渲染于 `:471-472` |
| `src/renderer/components/Chat/MessageInput.tsx:313-342` | `checkOverflow` | 宽度预算：`attach + chip + effort + status`（`neededWidth`，:334-336）与**状态区折叠后**的预算（含 `triggerWidth=22`）；`setStatusCollapsed(:342)`；`ResizeObserver(:349-358)` + 依赖数组 `:361-362` 触发重测 |
| `src/renderer/theme/layout.css:1419-1647` | `.composer-footer*` / `.composer-model-chip*` | footer 与 chip 视觉（`max-width: 220px`、圆角胶囊、`--open` 旋转 chevron、`--warn` 警告色） |
| `src/renderer/theme/config-settings.css:1646-1790` | `.composer-model-picker*` / `.composer-thinking-picker*` | 两个 Popover 的内边距归零、列表项、服务名副文案、模型名、徽章、强度列表项与 `--active` |

### 2.3 展示名规则：既存偏差在本需求内修正

**修正前（现网实现）：**

- `buildChatModelOptions`（`src/shared/llmModelConfig.ts:253`）对**每个** `(service, model)` 一律产出 `displayName = \`${service.name.trim()}-${model.name}\``——**永远带服务名前缀**。
- 而 `llm-multi-service-model-config-requirement.md` §9.3 规定：**仅当同类模型名被 ≥2 个启用服务支持时**才加前缀，唯一时只显示 `{model.name}`。
- **二者不一致 → 实现比文档更冗余**（属既存缺陷，非本需求引入）。用户在同一菜单里看到的可能是 `Deep-glm-5.3`，而文档本意只是 `glm-5.3`。

**修正内容（本需求一并做掉，FR12）：**

| 条件 | 修正后 `displayName` |
|------|---------------------|
| 该 `model.name` 在**当前可用池中仅出现 1 次**（只有 1 个启用服务支持） | `{model.name}`，如 `glm-5.3` |
| 该 `model.name` 被 **≥2 个**启用服务同时支持 | `{serviceName}-{model.name}`，如 `Deep-deepseek-v4-pro` |

**消费点核查（已全部核对，影响面可控）：**

| 消费点 | 位置 | 影响 |
|--------|------|------|
| 生成处 | `llmModelConfig.ts:253` | **改**：需先收集全部 `(service, model)` 再统计同名出现次数，然后决定前缀 |
| 透传 | `sessionModelBinding.ts:53/64/81/90` | **不改**（只是搬运 `displayName`） |
| `ComposerModelPicker` chip 文案 | `ChatView.tsx:959` → 组件 `displayName` prop | **本需求会删除该组件**（§6.1），chip 文案改用 `modelName` + 可选服务段（FR3）；`displayName` 改由入口 `title` 消费（FR5） |
| 浮层模型列表 | `ComposerModelPicker` 内部 | **不使用** `displayName`——它用 `opt.serviceName`（副文案）+ `opt.modelName`（主文案）分别渲染（已核对源码）。故列表渲染**不受本次修改影响** |
| 设置页 / 快照 | `ModelsSettingsTab.tsx` / `configModalSnapshot.ts` | **不涉及**：二者消费的是 `ModelEntry`，不是 `ChatModelOption`（已核对） |

> ⚠️ **与 FR12 的衔接**：修正后 `displayName` 已内建「是否歧义」这一信息（带前缀 ⇔ 歧义）。**建议**让 `buildChatModelOptions` 在统计时**顺带产出一个显式布尔字段**（如 `ChatModelOption.serviceAmbiguous`），供 FR3 的服务段判定复用——使「歧义判定」这一业务规则**只有一处实现**，避免将来 displayName 与服务段判定漂移（§6.2）。

### 2.4 空间压力来源（P2 细节）

`checkOverflow`（`:328-340`）的预算公式：

```
neededWidth = attach + gap + status
            + (chip>0 ? gap + chip : 0)          // 模型 chip
            + (effort>0 ? gap + effort : 0)      // 强度 chip
neededCollapsedWidth = attach + gap + 22 + (chip) + (effort)
```

两个 chip 各自贡献 `gap(8) + width`，其中强度 chip 文案（`默认（中）`）与模型 chip 文案（含服务名前缀）都是不可压缩的 `flex-shrink: 0` 胶囊。合并为单 chip 后，该项**天然少一组** `gap + width`。

### 2.5 现有测试约束（改动即需同步）

| 测试 | 断言内容 |
|------|----------|
| `src/renderer/components/Chat/ComposerThinkingPicker.test.tsx` | **现状断言**（迁移后须改写，见 §7.2）：收起态文案（`默认（中）` / `低`）；4 档 `menuitem` 文本序列 `['关闭','低','中 · 默认','高']`；默认项 `--active`；点默认项回调 `null`；禁用 + Tooltip（`fireEvent.mouseEnter` 打到外层 span） |
| `src/renderer/components/Chat/MessageInput.test.tsx:115-128` | 「thinking slot 位于 model slot 之后、状态区之前」的 DOM 顺序断言 |
| `npm run i18n:check` / `i18n:generate-types` | 新增 / 删除 key 必须 zh-CN、en-US 双份对齐 |

### 2.6 档位集合现状核查（FR10 的技术前提）

> 需求要点：不同服务商 / 模型可提供的档位数量是变化的，**不能写死 4 档**。核查结论：**该判断成立，且现网已有相应数据源，但未接到 composer**。

**三处事实（均已核对到代码）：**

| # | 位置 | 事实 |
|---|------|------|
| 1 | `src/shared/agent/invocation.ts:86` | 产品档位枚举**当前 4 个**：`AgentReasoningEffort = 'off' \| 'low' \| 'medium' \| 'high'`。**本需求扩展为 5 个**（+`max`，FR11） |
| 2 | `src/shared/modelBaseline.ts:5` | 上游档位空间**更大**：`ThinkingLevelMap = Partial<Record<AgentReasoningEffort \| 'minimal' \| 'max', string \| null>>`——除产品档位外还有 **`minimal` / `xhigh`**（`max` 在扩展后已属产品档位）；`null` 表示该档不支持。⚠️ 该类型**未声明 `xhigh`**，但基线里有 208 处（类型与数据不一致，属既有偏差） |
| 3 | `src/shared/thinkingAvailability.ts` | `resolveThinkingAvailability(model, { effortUnsupportedByMemo })` → `{ unsupported: [...], source: 'baseline'\|'memo'\|'unknown' }`。**粒度是「按模型」**（查 `MODEL_BASELINE[modelName]`），**不是按服务商** |

**✅ SDK 类型边界（本次只加 `max` 的有利事实）：**

```ts
// node_modules/@anthropic-ai/sdk/resources/messages/messages.ts:1090
interface OutputConfig {
  /** All possible effort levels. */
  effort?: 'low' | 'medium' | 'high' | 'max' | null;
  format?: JSONOutputFormat | null;
}
```

**SDK（`@anthropic-ai/sdk@0.79.0`，官方 API 客户端）的 `OutputConfig.effort` 白名单本就包含 `max`**，因此本次扩展**不触碰类型边界、无需任何类型转换**：

| 档位 | SDK 类型是否接受 | 本次处理 |
|---|---|---|
| `low` / `medium` / `high` | ✅ 接受 | 直接传（现状） |
| **`max`（本次新增）** | ✅ **接受** | **直接传，无转换、无需 `as`** |
| `minimal` / `xhigh` | ❌ 白名单未含 | **本次不加**（若将来要加，才需处理该边界） |

> 📌 **既有观察（非本需求引入，亦不在本次范围）**：本项目构造请求体时**不引用** SDK 的 `OutputConfig` 类型——`claudeToolLoopStreamParams.ts:10` 用自己的 `ToolLoopOutputConfig = { effort: AgentReasoningEffort }`，函数返回 `Record<string, unknown>`，调用侧（`toolChatLoop.ts:1342-1344`）再整体 `as Parameters<typeof client.messages.stream>[0]`。故 SDK 类型在这条路径上**不参与检查**。记此仅为说明「类型限制不构成障碍」；**不**在本次收敛该 `as`（属独立技术债）。

**⚠️ 判定语义（易错，必须按此实现）：**

```ts
// thinkingAvailability.ts 核心逻辑
const PRODUCT_EFFORTS = ['low', 'medium', 'high']        // 注意：不含 off
unsupported = PRODUCT_EFFORTS.filter(e => map[e] === null)
```

| 基线写法 | 是否排除该档 | 说明 |
|---|---|---|
| `"low": null` | ✅ **排除** | 显式声明不支持——**这是唯一的排除依据** |
| `"low": "low"` | ❌ 不排除 | 显式声明支持 |
| **`low` 键缺失**（`undefined`） | ❌ **不排除** | `undefined === null` 为 false；键缺失＝上游未裁决 → 视为可用 |
| `"off": null` | ❌ **不排除** | `PRODUCT_EFFORTS` **不含 `off`**，故 `off` 的任何基线值都不影响过滤 |

**基线扫描结果（`res/resource/model-baseline.json`，282 KB / 1046 个模型，其中 458 个带 `thinkingLevelMap`）：**

**可用档位数分布（产品 5 档：`off` / `low` / `medium` / `high` / `max`）：**

| 可用档位数 | 模型数 | 举例 |
|---|---|---|
| 5 档 | 779 | `claude-fable-5` → `[off, low, medium, high, max]` |
| 4 档 | 184 | `gpt-5` → `[off, low, medium, high]` |
| 3 档 | 55 | `gpt-5.2-pro` → `[off, medium, high]` |
| 2 档 | 28 | `gpt-5-pro` → `[off, high]` |
| **1 档** | **0** | — |

> **结论：真实取值范围是 2–5 档，且当前基线中不存在只有 1 档的模型。**
>
> ⚠️ **"5 档" 的 779 个里绝大多数是 fail-open 的结果**（键缺失 → 全部视为可用），**而非上游真的声明了 5 档**。**获得 >`high` 档位的模型共 204 个**（基线中 `max` 非 `null` 的模型数）——即本次扩张的实际收益面。

**⚠️ fail-open 的副作用（本需求需知悉，但不改变该语义）：**

| 情形 | 影响 |
|---|---|
| 588 个**无** `thinkingLevelMap` 的模型（如 `claude-haiku-4-5`） | UI 将显示**全部 5 档**，含 `max` |
| 但这些模型**可能并不支持** `max` | 用户选中后 → 请求照发 → 上游可能忽略或报错 → 由 §7.4 兜底（用户感知"设了没效果"）。⚠️ 注意 **`max` 是 SDK 白名单内的合法值**，故更可能是被**静默忽略**而非 400 拒绝——而静默忽略不会触发 §7.4 的重试路径，须在验收中留意（A22d） |

**真实的少档例子（显式 `null` 驱动，5 档口径）：**

```jsonc
"gpt-5-pro":       { low:null, medium:null, high:"high", max:null }   → 可用 [off, high]            // 2 档
"deepseek-v4-pro": { low:null, medium:null, high:"high", max:"max" }  → 可用 [off, high, max]       // 3 档
"glm-5.2":         { low:null, medium:null, high:"high", max:"max" }  → 可用 [off, high, max]       // 3 档
"kimi-k3":         { low:"low", medium:null, high:"high", max:"max" } → 可用 [off, low, high, max]  // 4 档
```

**反例（容易被误读为"只有 N 档"，实际全 5 档可用）：**

```jsonc
"claude-opus-4-6": { max:"max" }                             // low/medium/high 键缺失 → 不排除 → 5 档全可用
"claude-fable-5":  { off:null, xhigh:"xhigh", max:"max" }     // 键缺失 + off 不在排除清单 → 5 档全可用
"claude-haiku-4-5": /* 无 thinkingLevelMap 键 */              // 键缺失 → fail-open → 5 档全可用
```

> 提示：**同一模型的可选档位数会随枚举范围改变**——例如 `deepseek-v4-pro` 在 4 档口径下只有 2 档（`off`/`high`），纳入 `max` 后为 **3 档**（`off`/`high`/`max`）。这正是 FR10「不得写死档位数」的实证。

**由此推出三条规则（FR10 依据）：**

| # | 规则 | 说明 |
|---|------|------|
| R1 | **可用档位 = 产品档位集合中「未被显式 `null` 排除」的子集** | 即 `THINKING_EFFORT_LEVELS`（5 档）减去 `availability.unsupported`。5 档口径下实际范围 **2–5 档**（§2.6 ②） |
| R2 | **`off` 恒可用** | 排除判定只遍历 `PRODUCT_EFFORTS`（**不含 `off`**，`thinkingAvailability.ts:11`）——即便基线写 `"off": null`（如 `claude-fable-5`），`off` 也不进 `unsupported`。这是**既有语义**（`off` = 零成本档、子调用默认），本需求**不改变**。⚠️ 枚举扩展后 `PRODUCT_EFFORTS` 须从 `['low','medium','high']` 扩为 **4 项**（+`max`），**仍不含 `off`**（FR11） |
| R3 | **键缺失视为「可用」** | 两条路径：① 整个 `thinkingLevelMap` 键缺失（`source: 'unknown'`，fail-open 返回 `unsupported: []`）；② map 存在但某档键缺失（该档不被排除）。二者都**不**因基线缺数据而误禁用户选择。⚠️ 副作用见上方「fail-open 的副作用」 |

**依赖缺口（本需求的前置改动）：**

| 层 | 是否持有 availability | 结论 |
|----|----------------------|------|
| 主进程 `electron/toolChatLoop.ts:1004-1010` | ✅ 已接线（`baselineBlocksEffort` / memo 短路） | 运行时 fail-soft 已实现 |
| `electron/turnExecutionConfig.ts` | ❌ 未调用 | 执行快照未携带 |
| `src/shared/turnCoordinator.ts` | ❌ 未调用 | — |
| `src/renderer/components/Chat/ChatView.tsx` | ❌ 无引用 | **renderer 拿不到** |
| `src/renderer/services/sessionModelBinding.ts` | ❌ 无引用 | — |
| `ComposerThinkingPicker` / `MessageInput` | ❌ 无引用 | **故当前写死 4 档** |

> ⚠️ 结论：**「不写死档位数」不是纯 UI 改动**，需要先把「该模型的可用档位集合」送到 composer。方案已定（**renderer 自算**，§6.6 / §10），落点见 FR10。

---

## 3. 术语与概念

| 术语 | 本档含义 |
|------|----------|
| **收起态** | 入口 chip **未被点击**、浮层**未打开**的状态（即 chip 平时显示的样子）。⚠️ **与窗口宽度无关**。本档统一用「收起态」，不使用「折叠态」一词，以免与下一行混淆 |
| **浮层打开态** | 点击入口后弹出的一体化面板（上半区模型、下半区强度）处于打开的状态 |
| **状态区折叠（`statusCollapsed`）** | **另一回事**：窗口宽度不足时，footer 的**运行状态文案**被折成 22px 图标点（`MessageInput.checkOverflow` → `.composer-hint-trigger`）。它**不改变入口 chip 的形态**（chip 为 `flex-shrink: 0`）。本档涉及此机制时一律写全称「状态区折叠」，不用简称 |
| **模型入口** | 原 `ComposerModelPicker`，浮层上半区 |
| **强度入口** | 原 `ComposerThinkingPicker`，即 UI 文案「思考强度」（沿用既有文案，§10）。⚠️ 全文「推理强度」仅出现在引述用户口述处，产品文案一律用「思考强度」 |
| **合并入口** | 本需求新增的单一 chip（唯一常驻控件） |
| **入口主文案** | 合并入口 chip 内显示的文本＝模型段（无服务名前缀）＋强度段（FR3） |
| **模型段 / 强度段** | 入口主文案的两部分：模型段＝模型名（＋歧义时的服务段，见下）；强度段＝当前生效档位文案（如 `中`） |
| **服务段** | **仅当**同名模型被 ≥2 个启用服务支持时，缀在模型段后的服务名标识，**全角括号**包裹（如 `（Deep）`）（§10） |
| **继承 / 覆盖** | 会话未设置档位＝继承全局；设置后为会话覆盖（`thinking-effort-settings-requirement.md` §4.2）。**收起态不区分二者**（都显示档位词），区分只在浮层内与 `title` |
| **可用档位集合** | 某模型实际可选的档位列表 ＝ 产品 5 档（`THINKING_EFFORT_LEVELS`）减去该模型的 `availability.unsupported`（§2.6）。**档位数可变（当前基线 2–5）**，实现**不得**假定为 4 或 5 |
| **产品档位集合（5 档）** | `off` / `low` / `medium` / `high` / `max`，按此顺序排列（FR11） |
| **不可用档位** | 该模型 `thinkingLevelMap` 中**显式值为 `null`** 的档位（**键缺失不算**，见 §2.6 判定语义）。**不渲染**——即从可选集合中直接剔除，而非"渲染但禁用"（§10） |

---

## 4. 功能需求

### FR1 单一常驻入口

- composer footer 左段的**两个 chip 合并为一个**：仅保留**一个**可点击 chip（下称「合并入口」），位置沿用原模型 chip 的位置（附件按钮之后、状态区之前）。
- 合并入口的视觉沿用现 `.composer-model-chip--button` 胶囊样式（含 `.composer-model-chip--open`、`.composer-model-chip--warn` 状态）。
- 移除 `ComposerThinkingPicker` 的常驻 chip 与其独立 Popover。

### FR2 浮层为「上模型 / 下强度」两分区

- 点击合并入口弹出**一个** Popover，版面自上而下：

```
┌───────────────────────────────────────────┐
│ 模型                                       │  ← 分区标题（都显示）
│ ┌───────────────────────────────────────┐ │
│ │ Claude Sonnet 4.5            [快速][视觉]│ │  ← 模型项：模型名 + 徽章
│ │ Deep                                    │ │  ← 服务名副文案（保留）
│ ├───────────────────────────────────────┤ │
│ │ GPT-4o                                  │ │
│ │ OpenAI                                  │ │
│ │ …（列表超出时在模型分区内滚动）           │ │
│ └───────────────────────────────────────┘ │
│ ───────────────── 分隔线 ─────────────────  │
│ 思考强度                                   │  ← 分区标题
│ [ 关闭 ][ 低 ][ 中 · 默认 ][ 高 ]           │  ← 可用档位集合（N 档，数据驱动）
│ [ 最高 ]                                   │  ← 5 档时在此换行为第 2 行（§5.2）
└───────────────────────────────────────────┘
```

> **收起态示例（§10）**：无歧义 `deepseek-v4-pro · 高`；有歧义 `deepseek-v4-pro（Deep） · 高`。

- **模型分区**：内容与现 `ComposerModelPicker` 列表一致（服务名副文案 + 模型名 + 快速 / 视觉徽章 + 选中态 + 空态文案 `modelPicker.empty`）。
- **强度分区**：档位项与现 `ComposerThinkingPicker` 的语义一致（等于当前全局档位的项带 `· 默认` 标记；点该标记项＝清除会话覆盖，回调 `null`）。⚠️ **但档位项不再固定**：应按「该模型的可用档位集合」渲染（**FR10**），范围 **2–5 档**；线框中的 4 档仅为示意（真实全档模型为 **5 档**，会换行为两行，见 §5.2）。
- 两分区之间用 1px 分隔线（视觉变量取 `--sa-border`）区分，不使用两个独立 Popover。
- **关闭时机（§10）**：选中**任一模型**或**任一档位**（含点「`X · 默认`」清除覆盖）后，浮层**立即关闭**——两分区行为一致，与合并前的两个独立控件相同。实现上即两处 `onSelect` 回调内 `setOpen(false)`，**不**存在"选完保持打开"的分支。

### FR3 收起态文案：模型名（＋可选服务段）＋ 当前推理强度

- 合并入口主文案由**三段**构成：`{模型名}` ＋ `{服务段?}` ＋ `{强度文案}`，例如：
  - 无歧义：`deepseek-v4-pro · 中`
  - 有歧义（同名模型被多个启用服务支持）：`deepseek-v4-pro（Deep） · 中`
  - ⚠️ 示例须**自洽**：档位词必须是该模型**可用集合内**的值（如 `deepseek-v4-pro` 的可用集合为 `off/high/max`，就**不会**出现 `· 中`）。
- **模型段**＝当前生效模型名（`resolveSessionModelBinding(...).modelName`），**不得**包含服务名前缀。
  - 例：会话绑定 `Deep-deepseek-v4-pro` → 收起态显示 `deepseek-v4-pro`，而非 `Deep-deepseek-v4-pro`。
- **服务段（§10）**：
  - **触发条件**：当前 `modelName` 在同一次 `listChatModelOptions(cfg)` 结果中**被 ≥2 个 service 支持**（即同名不同服务，用户无法仅凭模型名判断用的是哪套凭证）。
  - **格式**：**全角括号** `（{serviceName}）`，紧随模型段；**不得**使用 `·`（该符号已归强度段专用，避免视觉混淆）。
  - **数据**：`serviceName` 取自当前命中的 `ChatModelOption.serviceName`；歧义判定可用既有 `listChatModelOptions(cfg)` 纯函数统计，**无需新增数据通道**。
  - **不触发**时**完全省略**服务段（不得留空括号）。
- **强度段**＝**当前生效档位**文案（来自 `resolveSessionThinkingBinding(...).effort`，经既有 `composer.thinking.{off|low|medium|high|max}` 取词），**恒定显示**（§10）。
  - 依据：强度是用户日常会调节的项，收起态不可见会显著抬高「看一眼现在是几档」的成本。
  - **不区分**「继承 vs 覆盖」：两态都只显示档位词（如 `中`），不加「默认」括注（省宽度）。「是否继承全局」的信息由浮层内的 `· 默认` 标记、选中态与入口 `title` 承载（FR5）。
- 主文案为空时的回退顺序：模型段 `modelName` → `cfg.model` → `composer.prefs.unknownModel`（「未配置模型」）；强度段始终有值（继承时取全局档位），不参与回退。
- **截断优先级（宽度不足时）**：收缩只作用于**模型段（含服务段）**（`.composer-model-chip__label` 既有的 `min-width: 0` + 省略号），**强度段 `flex-shrink: 0`、不被截断**——确保「强度随时可查」在窄窗口下仍成立。
- 完整信息（服务名-模型名、是否继承）由 `title` 与浮层承载（FR5）。

### FR4 选择行为与既有语义完全一致

| 动作 | 行为（不得改变） |
|------|------------------|
| 选定某个模型 | 调用现有 `handleModelSelect`：有会话 → `session:update { model, llmServiceId }` + `upsertSession`；无会话 → 存草稿 `draftModelOption`，随首个会话创建写入 |
| 选定某个档位 | 调用现有 `handleThinkingSelect`：有会话 → `session:update { thinkingEffort }`；点「`X · 默认`」项 → 写 `null`（清除覆盖，回到继承）；无会话 → 存草稿 `draftThinkingEffort`；失败路径仍走 `message.error(formatUserFacingError(...))` |
| 生效时机 | **下次发送生效**（不变） |
| 草稿清理 | 会话建立后清理草稿的既有 `useEffect`（`ChatView.tsx:142-147`）不变 |

### FR5 信息不丢失（收起态精简的补偿）

- 合并入口 `title`（悬浮提示）应给出**完整**信息：`{displayName} · 思考强度：{强度文案}`，并注明是否继承全局（如追加「（默认）」）。⚠️ 此处的 `displayName` 经 **FR12** 修正后语义更贴切：**无歧义 = 纯模型名**（如 `glm-5.3`），**有歧义 = 带服务名前缀**（如 `Deep-deepseek-v4-pro`）——正好充当「完整但不过度冗余」的悬浮说明。该项也保证服务名歧义在 hover 时**始终**可解（即使收起态提示因截断而不完整）。
- 浮层内每一模型项保留服务名副文案；同名模型跨服务的歧义在浮层内可辨。
- 强度档位的「当前生效值 / 是否继承」在浮层内以选中态与 `· 默认` 标记呈现；收起态只显示档位词，故「是否继承」**不**能从收起态推断，须由 `title` 与浮层承载。

### FR6 禁用与不可用状态（**关键差异**）

- **模型不支持 Thinking**（`currentModelEntry.supportsThinking === false`）时：**浮层仍可打开**（用户必须还能切换模型），仅**强度分区整体禁用**并在其内提示「该模型不支持 Thinking」（复用 `composer.thinking.notSupported`）。
  - ⚠️ 与现状的差异：现 `ComposerThinkingPicker` 是**整个控件 disabled**，若合并后照搬，合并入口将一并被禁用，用户将**无法换模型**——本需求明确禁止该实现。
  - 禁用态的 Tooltip 可达性坑（评审 B2：禁用元素不派发鼠标事件）在合并后**自然消解**（chip 本身不再禁用），实现时把提示直接放在强度分区内即可，无需外层 `span` 兜底。
- **当前会话模型不可用**（`sessionBinding.option` 缺失，`unavailable === true`）：合并入口沿用警告色（`.composer-model-chip--warn`），`title` 提示 `modelPicker.unavailableHint`；浮层照常打开，列表可见可选。
- **可用模型池为空**：合并入口仍可点击，浮层模型分区给出 `modelPicker.empty` 空态文案（「暂无可用模型，请前往设置配置 API 服务与模型」）；强度分区照常可用（档位与模型无关，仅受 `supportsThinking` 联动）。

### FR7 状态区折叠逻辑随结构收敛（`statusCollapsed`，与入口形态无关）

- `MessageInput` 的宽度预算改为**单个** chip 项：`neededWidth` 与 `neededCollapsedWidth` 各去掉一组 `gap + effortWidth`（`:329`、`:336`、`:340` 附近）。
- 该 chip 项的宽度**已包含强度段**（`chipWidth` 是 `offsetWidth` 实测值），因此**无需**为强度另加预算项；公式项数由 3 项（attach/chip/effort）收为 2 项（attach/chip）。
- 状态区折叠的触发条件（`neededWidth > availableWidth && neededCollapsedWidth <= availableWidth`）、`triggerWidth=22`、`gap=8` 常量与 idle 复位逻辑（`:307-311`）**均保持不变**。
- 预期效果：合并后 chip 宽度下降（估算见 §5.2.1），`statusCollapsed` 更少被触发，运行状态文案有更大概率保持展开——本需求最直接的收益，须在验收中体现（A17）。

### FR8 无障碍与键盘

- 合并入口：`aria-haspopup="dialog"`（浮层含两个分区，非单一 listbox/menu）、`aria-expanded={open}`、`aria-label` 同时描述模型与强度。
- 强度分区：容器 `role="radiogroup"`（或 `role="group"` + `aria-labelledby` 指向分区标题），档位项 `role="radio"` + `aria-checked`；模型分区沿用 `listbox`/`option` 语义（或 `menu`/`menuitemradio`），**不得**让读屏只播报「模型」而漏掉强度区。
- 键盘：`Tab` 可进入浮层并遍历两个分区；`Enter` / `Space` 触发选择；`Esc` 关闭浮层并把焦点还给入口 chip；点击浮层外部关闭（Ant Design Popover 默认行为，触发器保持 `trigger="click"`）。
- 入口 chip 的 `focus-visible` 样式沿用 `.composer-model-chip--button:focus-visible`。

### FR9 文案国际化

- 所有新增文案走 `t()`（`chat` 命名空间），zh-CN / en-US 双份对齐，新增后运行 `npm run i18n:generate-types` 与 `npm run i18n:check`。
- 具体键位变更见 §6.5。
- ⚠️ **不得**写死档位文案数组（如 `const LABELS = [t('off'), t('low'), t('medium'), t('high')]`）——文案须按**实际档位键**逐项取词，以适配可变档位数（FR10）。档位键共 **5 个**（FR11）。

### FR10 档位集合必须数据驱动（**硬约束**）

> 依据：§2.6 的代码核查。需求要点：不同服务商 / 模型提供的档位数量是变化的，**不能写死档位数**。

- 强度分区的档位项**必须**由「该模型的可用档位集合」生成，**禁止**硬编码档位数组。集合定义见 §2.6 R1–R3。
- **档位键取自产品枚举（5 档）**：`AgentReasoningEffort`，本次扩展后为 `off/low/medium/high/max`（FR11）。
- **数据来源**（方案 A，§10）：renderer 调用共享纯函数 `resolveThinkingAvailability(modelName, { effortUnsupportedByMemo: false })`，由 `unsupported` 反推 `availableEfforts`。详见 §6.6。
- ~~**当前选中档位不在可用集合内时**（如基线升级后某档变为 `null`）：入口强度段仍**如实显示**该档位词（反映会话实际值）；**不得**静默改写 `session.thinkingEffort`~~ **已修订（2026-10-01，真机反馈）**：原「如实显示无效档 + 浮层不渲染」的组合造成割裂——收起态显示「中」而浮层列表无「中」、无任何选中项。现改为**解析层降级**：`resolveSessionThinkingBinding` 接受可用集合，生效档位不被支持时沿枚举**向下**取最近可用档（依据 v1.4 实测「low ≈ medium」，行为最接近且无成本意外；off 恒可用兜底），**仍不改写** `session.thinkingEffort` 存储值（UI 不越权保留）。防御兜底：若生效档位仍抵达组件（如调用方未接降级解析），以「`{{档位}} · 当前`」禁用格插入序列原位，悬浮提示不可选原因。
- **不可用档位不渲染（§10）**：`availability.unsupported` 命中的档位**直接从列表中剔除**，不做"渲染但禁用"。依据：当前基线最少也有 **2 档**（§2.6），不会出现"只剩一个按钮"的失衡。
- **可用档位仅 2 个**（当前基线的最少情况，如 `gpt-5-pro` = `off`/`high`、`openai/o3-mini-high` = `off`/`high`；**5 档口径下 `deepseek-v4-pro` 为 3 档**，见 §2.6）：只渲染这 2 项；容器左对齐、不拉伸占满（§5.2）。
- **`source: 'unknown'`（整个 map 键缺失）**：按 R3 fail-open，渲染**全部 5 档**（副作用见 §2.6「fail-open 的副作用」）。
- **回归不变**：本 FR 只影响**渲染哪些档位**；`session:update` 载荷、继承/覆盖语义、写 `null` 的行为一律不变（FR4）。

### FR11 档位枚举扩展为 5 档（**仅新增 `max`**）

> 依据：只把 `max` 放进 UI，`minimal` / `xhigh` **不加**（§10）。本项**修订**了 `thinking-effort-settings-requirement.md` §4.1 的决策（该档为已定稿状态，须同步修订，§7.3）。

**① 枚举与常量扩展（仅 1 个新档位）**

| 位置 | 现状 | 改后 |
|------|------|------|
| `src/shared/agent/invocation.ts:86` | `AgentReasoningEffort = 'off' \| 'low' \| 'medium' \| 'high'` | `'off' \| 'low' \| 'medium' \| 'high' \| 'max'`（**+1 项**） |
| `src/shared/thinkingEffort.ts` | `THINKING_EFFORT_LEVELS = ['off','low','medium','high']` | `['off','low','medium','high','max']`（**顺序即 UI 顺序**，由弱到强） |
| `src/shared/thinkingAvailability.ts:11` | `PRODUCT_EFFORTS = ['low','medium','high']` | `['low','medium','high','max']`（**4 项，仍不含 `off`**——`off` 恒可用，§2.6 R2）。建议同时重命名为 `EXCLUDABLE_EFFORTS` 以免与「产品档位」混淆 |

**② SDK 类型边界：✅ 无需处理（本次的关键简化）**

§2.6 已核：SDK（`@anthropic-ai/sdk@0.79.0`）的 `OutputConfig.effort` 白名单为 `'low' | 'medium' | 'high' | 'max' | null`——**`max` 本就在内**。因此 `buildThinkingWireParams`（`electron/effortFallback.ts:12`）**无需任何改动**：

```ts
// 现状代码即可支持 max —— off 走 disabled，其余档（含 max）走 adaptive + output_config.effort
if (effort === 'off') return { thinking: { type: 'disabled' } }
return { thinking: { type: 'adaptive' }, outputConfig: { effort } }
```

- **不需要** `as OutputConfig['effort']` 转换，**不需要** `@ts-expect-error`，**不需要** `any`。
- **上游不认时的兜底**：若某网关不认 `max`，由既有 §7.4 fail-soft 兜底（400 + `output_config` → 去强度重试一次 + memo 记忆），**该路径无需改动**。

**③ 连带影响（不止 composer）**

| 位置 | 影响 |
|------|------|
| 设置页全局强度下拉（`ModelsSettingsTab.tsx:183`，`THINKING_EFFORT_LEVELS.map`） | **自动**从 4 项变 5 项。属预期内的顺带变化；`max` 文案取 `最高`（§10） |
| DB 会话档位校验（`operations.ts:100/209/327` 经 `isThinkingEffort`） | 扩展后 DB 自动接受 `max`。列类型为 `TEXT` 且**无 CHECK 约束**（`schema.ts:326`），**无需迁移** |
| 全局配置键 `config.thinkingEffort` | 同上，需确认档位校验分支同步放宽（§7.3 待核） |
| `ThinkingLevelMap` 类型（`modelBaseline.ts:5`） | 扩展后 `max` 已被枚举覆盖，可把冗余联合简化为 `\| 'minimal' \| 'xhigh'`（**顺带修掉「类型未声明 `xhigh`」这一既有偏差**） |
| i18n | **仅新增 1 档文案**（`max`），见 §6.5 |
| 既有测试 | `thinkingEffort.test.ts` 需反转 **1 行**；`effortFallback.test.ts` 补 `max` 断言（§7.2） |

**④ 兼容性**

| 方向 | 行为 |
|------|------|
| 旧数据 → 新版 | ✅ 无影响：旧值 `off/low/medium/high` 仍是合法值；`resolveGlobalThinkingEffort` / `deriveThinkingEffortFromLegacyEnabled` 的迁移语义不变（`true`→`medium`） |
| 新版 → 旧版（用户降级） | ⚠️ **优雅降级**：旧版 `isThinkingEffort('max')` 返回 `false` → 该会话档位被视为「未设置」→ **回落到继承全局**。**不崩**，但该会话覆盖会丢失。属可接受代价，须在文档明示 |
| 默认档不变 | ✅ 全局默认仍为 `medium`（`normalizeThinkingEffort(cfg.thinkingEffort, 'medium')`），**不因扩张而改变**——否则所有未调整会话的成本会突变 |
| 远程 / Butler lane | ✅ 不受影响：仍恒 `off`（既有 lane 决策） |

**⑤ 非目标（避免范围继续膨胀）**

- **不**引入 `max` 之外的档位（`minimal` / `xhigh` 明确**不加**，§10）；
- **不**改 `off` 的语义（零成本档、子调用默认、远程/Butler lane 恒 `off`）；
- **不**因为新增高档位而修改默认档或自动选档逻辑；
- **不**收紧 fail-open 语义（§10）；
- **不**在本次收敛 `toolChatLoop.ts:1342` 的整体 `as`（技术债，独立处理）。

### FR12 修正 `displayName` 生成规则

> 依据：一并修掉既存偏差，规则来源 `llm-multi-service-model-config-requirement.md` §9.3（§10）。

- `buildChatModelOptions`（`src/shared/llmModelConfig.ts:253`）的 `displayName` 生成规则改为：

| 条件 | `displayName` |
|------|---------------|
| 该 `model.name` 在当前可用池中**仅出现 1 次**（只有 1 个启用服务支持） | `{model.name}`（**无前缀**），如 `glm-5.3` |
| 该 `model.name` 被 **≥2 个**启用服务同时支持 | `{serviceName}-{model.name}`（**带前缀**），如 `Deep-deepseek-v4-pro` |

- **实现要点**：需**两遍**处理——先收集全部 `(service, model)` 候选，统计每个 `model.name` 的出现次数，再据此决定各条目的前缀。**不得**在单层循环内直接拼前缀（现实现即此，故有偏差）。
- **服务名规范化**：沿用 `service.name.trim()`；连接符固定单连字符 `-`（§9.3）。
- **建议（降低耦合）**：顺带在 `ChatModelOption` 上产出 `serviceAmbiguous: boolean`，使「是否歧义」成为**显式契约**而非「从 displayName 是否含 `-` 反推」；FR3 的服务段判定**复用同一字段**，保证两处规则一致（§2.3 末 / §6.2）。
- **不改变**：`ChatModelOption` 其余字段（`serviceId` / `serviceName` / `modelId` / `modelName` / `model`）语义不变；`session:update` 写入的仍是 `modelName` + `serviceId`（§FR4 不受影响）。
- **本需求内的用途**：入口 `title` 直接消费 `displayName`（FR5）；收起态 chip 仍用 `modelName`（＋可选服务段），**不**用 `displayName` 作主文案。
- **回归重点**：3 个测试文件的断言反转（§7.2）；**浮层列表渲染实测不受影响**（其用 `serviceName`/`modelName` 分开渲染，已核对源码）。

---

## 5. 交互规格

### 5.1 状态矩阵

| 状态 | 入口 chip 表现 | 浮层 |
|------|----------------|------|
| 收起态（idle）+ 模型可用 | `模型名 · 中`（歧义时 `模型名（服务名） · 中`）+ chevron | 关闭 |
| 点击打开 | 加 `.composer-model-chip--open`（chevron 旋转 180°） | 模型分区在上、强度分区在下 |
| 选中模型 | 模型段立即变为新模型名（强度段不变） | **立即关闭**（§10；与现状一致） |
| 选中档位 | 强度段立即变为新档位（模型段不变） | **立即关闭**（§10） |
| 模型不支持 Thinking | 无变化（不禁用） | 强度分区禁用 + 说明文案 |
| 会话模型不可用 | 警告色 | 正常，列表可选 |
| 无可用模型 | 文案回退（FR3） | 模型分区空态文案 |
| running（发送中） | 不变（chip 照常可点，模型/强度按 FR4「下次发送生效」） | 同上 |

### 5.2 视觉与尺寸（建议值，实施时以设计确认为准）

| 项 | 规格 |
|----|------|
| 入口 chip 内部结构 | 模型段 `.composer-model-chip__label`（**含可选服务段**，可收缩、`min-width:0` + 省略号）→ 分隔符 `.composer-model-chip__sep`（`·`）→ 强度段 `.composer-model-chip__effort`（`flex-shrink: 0`、不可截断，色 `var(--sa-text-tertiary)`、字重 400）→ chevron |
| 入口 chip 宽度上限 | 保持 `max-width: 220px`（§10）；宽度不足时靠**模型段（含服务段）截断**兜底（FR3） |
| 入口 chip 宽度变化 | 切换模型 / 档位后 chip 宽度随之变化，会触发 `checkOverflow` 重测（重测依赖数组已含该 slot，见 FR7） |
| 强度段视觉权重 | 弱于模型段（tertiary 色 + 常规字重），保证「一眼看到档位」但**不**与模型名抢注意力 |
| 浮层宽 | 模型分区沿用 `min-width: 260px / max-width: 360px`；强度分区同宽 |
| 模型分区高 | 内容超限时**模型分区内滚动**（沿用 `.composer-model-picker` 的 `max-height` + 细滚动条策略，注意 `components.css` 的滚动条白名单已包含该类名） |
| 总高上限 | ≤ 400px（模型区 ~240 + 分隔线 + 强度区 ~92 + 内边距）。5 档时强度区为 **2 行**，须确保笔记型窗口高度下不溢出视口 |
| Popover 定位 | `placement="topLeft"`（沿用两控件的既有位置），靠近视口上沿时由 antd 自动翻转 |
| 动画 | 沿用 antd 默认；`prefers-reduced-motion` 下 chip chevron 过渡禁用（既有规则保留） |
| 分隔线 | 1px `var(--sa-border)`，左右不留缝（或按设计内缩 8px） |
| 分区标题 | 12px `var(--sa-text-tertiary)`；**两个分区都显示**（「模型」/「思考强度」） |
| **强度分区布局（横向，N 档自适应）** | 容器 `display:flex; flex-wrap:wrap; gap:4px`；档位项 `flex:1 1 0; min-width:52px`（中文 2 字标签 + 内边距的下限）→ **档位数变化时自动等分**，**禁止**写死固定等分（如 `calc(25% - 3px)`） |
| **5 档时的换行（全档模型）** | 单行容量 ≈ `(236 - 4×4) / 5 ≈ 44px` < `min-width: 52px` → **必然换行**。按 `min-width:52px + gap:4px` 计，每行最多 **4 项**（4×52 + 3×4 = 220 ≤ 236）→ 5 档落为 **4 + 1 两行**（最后一行左对齐，**不拉伸**补满） |
| 强度分区档位数 = 2–3 | 单行即可容纳；项仍受 `min-width` 约束，**不**被拉伸到占满整行（避免"2 个巨大按钮"的失衡）；容器左对齐 |
| 不可用档位处理 | **不渲染**（§10）——`availability.unsupported` 命中的档位不出现在列表中，因此**无禁用态样式需求**；如需解释"为什么少了一档"，用强度分区标题的 `title` |

#### 5.2.1 收起态宽度估算（确认「仍净下降」）

强度段移入 chip 后，宽度收益是否仍成立需要算清（G4 的前提）：

| 组成 | 现状（两个 chip） | 本需求（单 chip） |
|------|------------------|-------------------|
| 服务名前缀 | 有（`Deep-` / `OpenAI-` / `火山CodingPlan-` ≈ 26–90px） | **无前缀**；但歧义时会以**括号形式**出现（`（Deep）`，§10） |
| 模型名 | 有 | 有 |
| 强度文本 | `默认（中）`（≈52px） | ` · 中`（≈26px） |
| 各自的水平内边距 + 边框 | 两个 chip ≈ 26px × 2 | 一个 chip ≈ 26px |
| 两者之间的 `gap` | 8px | 并入同一 chip，**无** |

**无歧义时**：净变化 ≈ −(服务名前缀 26–90px) − (chip 内边距 26px) − (gap 8px) + (强度文本 26px) ＝ **净省约 34–98px**。

**有歧义时（服务段回归）**：服务段以 `（{serviceName}）` 回归，约 34–110px → 净收益相应缩水，**极端情况下（长服务名）可能接近打平**。因此：
- A16 的「净下降」结论**仅保证无歧义场景**；
- 歧义场景的收益由**「合并两个 chip 省的 padding + gap（≈34px）」**提供下限，方向仍为「不增宽」；须在真机验收中区分两种场景（A16a）。

> 说明：该估算只针对 chip 部分；状态区文案宽度不变。模型名本身两态相同，不计入差值。

### 5.3 主流程

```
[收起态] 入口显示「claude-opus-5-5 · 中 ▾」（歧义时如「deepseek-v4-pro（Deep） · 高 ▾」）；用户点击
   → 弹出浮层（模型分区 + 强度分区，当前选中项高亮，等于全局档位的档位带「· 默认」）
   → 用户点击「Claude Sonnet 4.5」(Deep)
        → handleModelSelect → session:update
        → 浮层关闭，模型段变为「claude-sonnet-4-5」（强度段保持「中」）
        → 若新模型 supportsThinking === false：下次打开时强度分区为禁用态
   → 用户点击「高」
        → handleThinkingSelect('high') → session:update
        → 浮层关闭（选完即关，§10），强度段立即变为「高」
```

### 5.4 边界交互

- 列表滚动到底 / 顶：不关闭浮层（`overscroll-behavior: contain` 已在该类名上生效）。
- 会话切换（侧边栏切走）：浮层关闭，入口文案**（模型段与强度段）**随新会话绑定刷新。
- 会话在浮层打开期间被创建（首次发送触发代建）：不影响浮层；草稿语义不变（`thinking-effort-settings-requirement.md` §5.2）。
- 远程会话（飞书 / 微信来源）：无 composer，本入口不存在，不受影响。

---

## 6. 技术方案

### 6.1 组件划分

| 方案 | 说明 | 评价 |
|------|------|------|
| **A（推荐）** | 新增 `ComposerModelThinkingPicker.tsx`，内部承担「入口 chip + 一体化浮层」；把原两个 `*Picker` 的**列表内容**作为同一文件内的子组件（如 `ModelSection` / `EffortSection`）；随后删除 `ComposerModelPicker.tsx`、`ComposerThinkingPicker.tsx` | 单一职责边界清晰（「composer 偏好入口」），测量 ref 只需一个 |
| B | 保留原两组件，仅去掉其 chip、把 content 导出，由新父组件拼装 | 组件间耦合（Popover 在子组件内），需拆 Popover 与列表，改动面更大 |
| C | 直接把两个组件内联进 `MessageInput` | 违反 `MessageInput` 现有职责（它只负责输入/发送与状态区），且 `MessageInput` 已 20KB+ |

**推荐 A**。测试文件同步替换为 `ComposerModelThinkingPicker.test.tsx`（§7.2）。

### 6.2 Props 契约

```tsx
// src/renderer/components/Chat/ComposerModelThinkingPicker.tsx
type Props = {
  cfg: AppConfig

  // ── 收起态主文案（FR3）＋ 模型分区 ──
  /** 收起态模型段：仅模型名，不含服务名前缀（FR3） */
  modelName: string
  /**
   * 收起态**服务段**（§10）：仅当同名模型被 ≥2 个启用服务支持时传入（如 `Deep`）。
   * 缺省 / 空 → 不渲染括号（FR3）。
   * ⚠️ 其「是否歧义」的判定应与 `displayName`（FR12）**同源**——建议直接消费
   * `ChatModelOption.serviceAmbiguous`，避免两处规则漂移（§2.3 末）。
   */
  modelServiceName?: string
  /** hover 完整信息：`{服务名}-{模型名}`（FR5） */
  modelDisplayName: string
  /** 当前会话模型不可用（警告态） */
  modelUnavailable?: boolean
  onSelectModel: (option: ChatModelOption) => void

  // ── 收起态强度段（FR3）＋ 强度分区 ──
  /** 当前生效档位（会话覆盖或全局默认）：同时用于收起态强度段（恒定显示，§10） */
  effort: AgentReasoningEffort
  /** 是否存在会话级覆盖 */
  effortOverridden: boolean
  /** 全局默认档位（决定浮层中哪一项带 `· 默认` 标记） */
  globalEffort: AgentReasoningEffort
  /** 当前模型不支持 Thinking：仅禁用强度分区（FR6） */
  effortDisabled?: boolean
  effortDisabledReason?: string
  /** null = 清除覆盖（回到继承） */
  onSelectEffort: (effort: AgentReasoningEffort | null) => void

  // ── 档位集合（FR10：数据驱动，不得写死 4 档）──
  /**
   * 该模型的可用档位集合（当前基线 2–5 项，按产品枚举顺序 off→low→medium→high→max）。
   * 调用方应传入**已剔除不可用档位**的列表（不渲染不可用档位，§10）。
   * 缺省（undefined）= 尚未拿到 availability，按 fail-open 渲染全部 **5 档**（§2.6 R3 / FR11）。
   */
  availableEfforts?: AgentReasoningEffort[]
}
```

> **已移除**：原草案的 `unsupportedEfforts`。定为「不渲染」（§10）后，组件只需**可用集合**，无需知道被剔除的是哪些档位（"不渲染"不需要禁用态样式）。
>
> ⚠️ **档位键已扩展为 5 个**（FR11，仅 +`max`）：`AgentReasoningEffort` 现在包含 `max`。组件内**不得**假设档位固定为 4 个或 5 个——应按传入的 `availableEfforts` 渲染（FR10）。

> 模型列表数据在组件内用既有 `listChatModelOptions(cfg)` 取得（与现 `ComposerModelPicker` 一致），不新增数据通道。
>
> 收起态 chip 文本由组件自行组装：`{modelName}` ＋ `{（serviceName）?}` ＋ `t('composer.prefs.chipSeparator')` ＋ `t('composer.thinking.' + effort)`（服务段与档位词规则见 FR3 与 §6.5）。`modelName` 与 `effort` 均已在 `ChatView` 的 `sessionBinding` / `thinkingBinding` 中解析完毕（`ChatView.tsx:130-138`）；**歧义判定**用既有 `listChatModelOptions(cfg)` 统计同名服务数即可（FR3），无需新增数据通道。

### 6.3 `MessageInput` slot 收敛

| 现状 | 改法 | 理由 |
|------|------|------|
| `modelSlot?: ReactNode`（`:30`）+ `thinkingSlot?: ReactNode`（`:32`） | 收敛为**单个** `prefsSlot?: ReactNode`（语义：模型与强度合并入口） | 两个 slot 的存在本身会诱导实现者继续放两个控件；单 slot 与 FR1 强绑定 |
| `modelChipRef`(`:94`) + `thinkingChipRef`(`:95`) | 只保留一个 chip ref | 测量逻辑简化（FR7） |
| `checkOverflow` 的 chip/effort 两项预算（`:328-340`） | 合并为一项 | 同上 |
| 依赖数组含 `modelSlot, thinkingSlot`(`:362`) | 改为 `prefsSlot` | 保持重测触发语义 |
| 渲染 `:471-472` 两行 | 合并为一行 | — |

**兼容说明**：该 Props 变更只影响 `ChatView.tsx:955-976` 与 `MessageInput.test.tsx:115-128` 两处调用方（已核对，无其他引用）。**改名单 slot 的理由**：单 slot 使「两个常驻 chip」在**类型层面写不出来**，为本需求 FR1「只保留一个入口」提供结构性保障；且那条「thinking slot 在 model slot 之后」的旧断言本就须删（两个 slot 已不存在），改名**不产生额外成本**。

### 6.4 CSS 改动点

| 文件 | 改动 |
|------|------|
| `src/renderer/theme/layout.css:1550-1628` | **保留** `.composer-model-chip*` 全部规则（合并入口继续用其视觉）；**新增**强度段与分隔符样式：`.composer-model-chip__effort { flex-shrink: 0; color: var(--sa-text-tertiary); font-weight: 400; }`、`.composer-model-chip__sep { flex-shrink: 0; color: var(--sa-text-tertiary); }`；确认 `.composer-model-chip__label`（已有 `min-width: 0`）独自承担收缩；补注释说明该 chip 语义已扩展为「模型 + 强度」 |
| `src/renderer/theme/config-settings.css:1646-1790` | 新增复合浮层容器与分区样式：`.composer-prefs-popover .ant-popover-inner { padding: 0 }`、`.composer-prefs__section`、`.composer-prefs__section-title`、`.composer-prefs__divider`、`.composer-prefs__models`（滚动容器，沿用 min/max-width 与 max-height）、`.composer-prefs__efforts`（档位横向容器：`display:flex; flex-wrap:wrap; gap:4px`，档位项 `flex:1 1 0; min-width:52px`，选中态沿用 `--active` 配色 `var(--sa-accent)`）。⚠️ **`flex:1` 等分 + `min-width` + `flex-wrap` 三者配合才能适配可变档位数（FR10）**；禁止写 `width: calc(25% - 3px)` 之类的固定等分硬编码——**5 档时必须能换行**（§5.2） |
| `src/renderer/theme/components.css` | 细滚动条白名单：若滚动容器类名由 `.composer-model-picker` 改名为 `.composer-prefs__models`，需同步加入该白名单（`:31`、`:53`、`:74`、`:95`、`:116`、`:136` 六处选择器组） |
| `config-settings.css:1696-1730` | 原 `.composer-thinking-picker__list/__item/--active` 样式按新形态调整（横排）或随组件删除后清理；`.composer-thinking-chip--disabled-wrapper` 随「整体禁用」取消而废弃 |

> 复用优先：模型列表项样式（`.composer-model-picker__item` / `__service` / `__model` / 徽章）可直接挂在复合浮层的模型分区内，避免重写一套。

### 6.5 i18n 变更（zh-CN / en-US 双份）

**新增（`chat` 命名空间）**

| key | zh-CN | en-US |
|-----|-------|-------|
| `composer.prefs.label` | `模型与思考强度` | `Model & thinking effort` |
| `composer.prefs.aria` | `模型与思考强度，当前模型 {{model}}，思考强度 {{effort}}` | `Model and thinking effort, current model {{model}}, thinking effort {{effort}}` |
| `composer.prefs.chipSeparator` | ` · ` | ` · ` |
| `composer.prefs.modelServiceSuffix` | `（{{service}}）` | ` ({{service}})` |
| `composer.prefs.modelSection` | `模型` | `Model` |
| `composer.prefs.effortSection` | `思考强度` | `Thinking effort` |
| `composer.prefs.effortDisabled` | `该模型不支持 Thinking，切换模型后可调整` | `This model does not support thinking; switch model to adjust` |
| `composer.prefs.unknownModel` | `未配置模型` | `No model configured` |
| `composer.prefs.entryTitle` | `{{displayName}} · 思考强度：{{effort}}` | `{{displayName}} · Thinking effort: {{effort}}` |

> **`entryTitle` 的 `{{displayName}}`（FR12）**：直接取 `ChatModelOption.displayName`——修正后无歧义时为纯模型名，有歧义时含服务名前缀，**无需**在文案层再拼服务名。

> **`composer.prefs.modelServiceSuffix`（§10）**：zh-CN 用**全角括号**（与英文半角括号区分，适配中文排版）；该键**仅在歧义时**参与拼接，非歧义时不产出任何文本（不留空括号）。

**沿用（不改）**：`composer.thinking.off/low/medium/high`（**收起态强度段直接复用这组键**，不为 chip 另造一套档位文案）、`composer.thinking.inheritWithGlobal`、`composer.thinking.defaultSuffix`、`composer.thinking.label`、`composer.thinking.aria`、`composer.thinking.notSupported`、`modelPicker.empty`、`modelPicker.unavailableHint`。

**必须新增（FR11：枚举扩为 5 档，仅 +`max`）——`chat.json` 与 `config.json` 各一套**

| key 后缀 | zh-CN（建议） | en-US（建议） | 说明 |
|---|---|---|---|
| `max` | `最高` | `Max` | 最强档 |

- 落点：`chat.json` 的 `composer.thinking.max`（收起态强度段 + 浮层强度分区共用）与 `config.json` 的 `models.effort.max`（设置页全局强度下拉）。
- 与既有四档构成五级梯度：`关闭 < 低 < 中 < 高 < 最高`。
- ⚠️ 档位文案总数由 4 变 **5**；两语言各 5 项须对齐（`npm run i18n:check`）。

**旧键处理（§10）**：`modelPicker.selectModelAria` / `modelPicker.switchModel` 的语义已从「模型」扩展为「模型 + 强度」，**删除这两个旧键**，改由新增的 `composer.prefs.*` 承担（两键均为本仓库内部使用，无外部消费者）。删除后须跑 `npm run i18n:check` 与 `i18n:generate-types`。

> ⚠️ **档位数量可变（FR10）**：档位键共 **5 个**（FR11），但**不新增也不删除**键的存在形式——即使某模型只有 2–3 档可用，也复用这 5 个键，按实际档位**逐项**取词。**禁止**建立"固定档位数组"式的文案映射。

### 6.6 可用档位集合的获取方式（**方案 A**）

**问题本质**：强度分区要显示「这个模型可用的档位」，但 composer **拿不到**该信息，故现网写死 4 档（§2.6 依赖缺口）。需要一个数据来源。

**数据链现状（已核）**：

```
res/resource/model-baseline.json      282 KB / 1046 模型
        │ import
        ▼
src/shared/modelBaseline.ts           → MODEL_BASELINE
        ▼
src/shared/thinkingAvailability.ts    → resolveThinkingAvailability()
        ▼
electron/toolChatLoop.ts:1004         ← 唯一消费点（运行时 fail-soft）
        ✗ 断在此处
renderer（ChatView / ComposerThinkingPicker）— 拿不到
```

| 方案 | 做法 | 优点 | 真实代价 |
|------|------|------|----------|
| **A ✅（已定）** | renderer 直接 `import { resolveThinkingAvailability }`，传 `{ effortUnsupportedByMemo: false }`，由 `unsupported` 反推 `availableEfforts` | ① **零 IPC 改动**；② **JSON 已在 renderer bundle 内**（证据链：`sessionModelBinding.ts:9` → `llmModelConfig.ts:3` → `modelBaseline.ts:1` → `model-baseline.json`，renderer 早已为模型参数加载此 282 KB）；③ 纯函数 + `useMemo` → **切模型即时重算**（满足 E15 与 A24） | 拿不到主进程的运行期 memo（`electron/effortFallback.ts` 的 `unsupportedMemo`：key = `${llmServiceId}\|${model}`）→ UI 比运行时**乐观一点**：baseline 未标 `null` 但上游实际拒绝 `output_config` 时，该档仍显示可选，用户选了以后由 **§7.4 运行时降级**兜底。**不是错误，只是提示不完美** |
| B | 主进程 `turnExecutionConfig` 携带 `availableEfforts`，随执行快照下传 | 理论上含 memo | ❌ **满足不了 E15**：执行快照只在 **turn 执行时**产生，用户**切换模型后、发消息前** renderer 拿不到新快照 → 档位集合**滞后**。且主进程的 effort 是 **per-turn 派生**的（`migrateBuiltinModelName` 归一、`model = vision.modelName` 视觉路由替换、凭据失败重绑），"同源"对象本身有歧义。要即时就得**再补通道** → 退化为方案 C |
| C | 新增 IPC（如 `llm:get-thinking-availability`） | 可含 memo，语义最完整 | 新增通道 + 缓存失效策略（memo 变化需通知 renderer）；成本最高 |

**决策理由**：

1. **A 的数据早已在 renderer bundle 中**——不是"新增依赖"，而是"接上已存在但未消费的数据源"；
2. **B 的"严格同源"是伪优点**：快照天然滞后于模型切换，且 per-turn 派生使"同源"无明确指代；
3. **本需求定位为 UI 合并**，不宜顺带扩张 IPC 面（与 §1.5 非目标一致）。

**接口分层（重要）**：组件只依赖 `availableEfforts` **入参**（§6.2），数据获取与组件解耦。将来若产品要求"严格同源 + 含 memo"，可改走方案 C —— **组件一行不用改**，只换上游取值逻辑。

**方案 A 实施注意（模型名对齐，真实坑）**：

- renderer 的 `chatModelName` 来自 `cfg.models` 的当前名（`resolveSessionModelBinding` → `findChatModelOption`，`sessionModelBinding.ts:59-65`）；主进程查 baseline 用的是**归一后**的名字（`turnExecutionConfig.ts:53` 的 `migrateBuiltinModelName`）。
- 边角情况：会话存旧内置名（如 `deepseek-v4-flash`）且当前配置无匹配时，renderer 可能查不到 → 返回 `unknown` → fail-open **全 5 档**。
- **建议**：renderer 查询前也走一次 `migrateBuiltinModelName`（`src/shared/llmModelConfig.ts:126` 已导出，renderer 可 import），与主进程对齐。
- 落点：在 `sessionModelBinding.ts` 新增 `resolveAvailableThinkingEfforts(cfg, session, draft)`（与既有 `resolveSessionThinkingBinding` 同构的纯函数），在 `ChatView` 用 `useMemo` 计算后经 `prefsSlot` 传入。

---

## 7. 影响面与兼容

### 7.1 代码改动清单（预期）

| 文件 | 改动类型 |
|------|----------|
| `src/renderer/components/Chat/ComposerModelThinkingPicker.tsx` | **新增**（合并入口 + 浮层） |
| `src/renderer/components/Chat/ComposerModelPicker.tsx` | **删除**（或保留列表子组件，见 §6.1 方案 B） |
| `src/renderer/components/Chat/ComposerThinkingPicker.tsx` | **删除**（同上） |
| `src/renderer/components/Chat/ChatView.tsx:52-55,955-976` | 改：import 与两个 slot → 一个 slot；`handleModelSelect` / `handleThinkingSelect` **不动** |
| `src/renderer/components/Chat/MessageInput.tsx:30,32,76-77,94-95,313-342,362,471-472` | 改：slot 收敛 + 测量逻辑简化 |
| **（新增，FR10）** `src/renderer/components/Chat/ChatView.tsx` | 改：解析当前模型的可用档位集合并传入 `prefsSlot`。**方案 A**：调用共享的 `resolveThinkingAvailability(chatModelName, { effortUnsupportedByMemo: false })`（`src/shared/thinkingAvailability.ts`），由 `unsupported` 反推集合 |
| **（新增，FR10）** `src/renderer/services/sessionModelBinding.ts` | 改：新增纯函数 `resolveAvailableThinkingEfforts(modelName)`（与既有 `resolveSessionThinkingBinding` 同构），内部先 `migrateBuiltinModelName` 对齐名字，再算可用集合 |
| `src/renderer/theme/config-settings.css:1646-1790` | 改：复合浮层样式 |
| `src/renderer/theme/components.css`（滚动条白名单） | 改：类名同步 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/chat.json` | 改：新增 / 修订键 |
| **（FR11）** `src/shared/agent/invocation.ts:86` | 改：`AgentReasoningEffort` 由 4 档扩为 **5 档**（**仅 +`max`**） |
| **（FR11）** `src/shared/thinkingEffort.ts` | 改：`THINKING_EFFORT_LEVELS` 扩为 **5 项**（`off/low/medium/high/max`，**顺序即 UI 顺序**）；`isThinkingEffort` / `normalizeThinkingEffort` 自动跟随（均基于该常量） |
| **（FR11）** `src/shared/thinkingAvailability.ts:11` | 改：`PRODUCT_EFFORTS` 由 3 项扩为 **4 项**（+`max`，**仍不含 `off`**——`off` 恒可用）；建议重命名为 `EXCLUDABLE_EFFORTS` |
| **（FR11）** `electron/effortFallback.ts:12` `buildThinkingWireParams` | ✅ **无需改动**：SDK 的 `OutputConfig.effort` 白名单**已含 `max`**，现网代码直接支持（§2.6 / FR11 ②）。**不需要任何类型转换 / `as`** |
| **（FR11）** `src/renderer/components/Config/ModelsSettingsTab.tsx:183` | **无需改代码**（已 `map(THINKING_EFFORT_LEVELS)`），但下拉**自动**从 4 项变 5 项——文案取 `最高`（§10） |
| **（FR11）** `src/renderer/i18n/resources/{zh-CN,en-US}/config.json` | 改：`models.effort.*` 新增 **`max`**（1 个键） |
| **（FR11）** `src/shared/modelBaseline.ts:5` | 改（可顺带）：`max` 已被枚举覆盖，可把 `ThinkingLevelMap` 的联合简化为 `\| 'minimal' \| 'xhigh'`（顺带修掉「类型未声明 `xhigh`」的既有偏差） |
| **（FR11）** `electron/database/operations.ts`（`:100/209/327`） | **无需改**：经 `isThinkingEffort` 校验，自动接受 `max`；列类型 `TEXT` 无 CHECK（`schema.ts:326`），**无需迁移** |
| **（FR11）待核** `electron/appIpc.ts` | 核：`config:set` 是否存在**硬编码档位枚举**的校验分支（`thinking-effort-settings-requirement.md` §7.3 记为待实现项；本次 grep 未在该文件命中 `thinkingEffort`，**实施前须确认校验落点**） |
| **（FR12）** `src/shared/llmModelConfig.ts:253` `buildChatModelOptions` | **改**：`displayName` 由「**一律**加 `{serviceName}-` 前缀」改为「**仅当该 `model.name` 被 ≥2 个启用服务支持时**才加前缀」（落实 §9.3）。实现要点：需**两遍**处理——先收集全部候选、统计每个 `model.name` 的出现次数，再决定各条目的前缀。**建议顺带**产出 `ChatModelOption.serviceAmbiguous: boolean`（§2.3 末），供 FR3 复用 |
| **（FR12）** `src/shared/modelBaseline.ts` / 其他 `displayName` 消费方 | **不改**（除 `buildChatModelOptions` 外无第二处生成逻辑；消费方核查见 §2.3 表） |

### 7.2 测试改动清单

| 测试文件 | 处理 |
|----------|------|
| `src/renderer/components/Chat/ComposerThinkingPicker.test.tsx` | **迁移**为 `ComposerModelThinkingPicker.test.tsx` 的强度分区用例（断言档位文本、`· 默认` 标记、点默认项回调 `null`、禁用态提示）。⚠️ 原断言的**固定 4 档文本序列**须改写为按传入 `availableEfforts` 断言（FR10） |
| `src/renderer/components/Chat/MessageInput.test.tsx:115-128` | **改写**：由「thinking slot 在 model slot 之后」→「合并 slot 存在且位于状态区之前」 |
| `src/renderer/components/Chat/ComposerModelThinkingPicker.test.tsx` | **新增**：① 收起态 chip 文案＝模型名（不含服务名前缀）**＋当前档位文案**；② 打开后同时渲染模型分区与强度分区；③ 模型项含服务名副文案与徽章；④ 无可用模型时模型分区空态、强度分区仍可用；⑤ `supportsThinking === false` 时入口可点、强度分区禁用；⑥ 选中模型 / 档位分别回调且浮层关闭；⑦ 档位切换后 chip 强度段即时更新；⑧ 继承与覆盖两态 chip **都**显示档位词（不出现「默认（中）」这类括注）；⑨ **（FR10）** `availableEfforts` 传 2 项 → 只渲染 2 项；不传 → fail-open 渲染 **5 项**（§2.6 R3）；⑩ **（FR11）** 传入含 `max` 的集合 → 正确渲染「最高」档并按 `max` 回调 |
| **（FR11）** `src/shared/thinkingEffort.test.ts` | **必须改（仅 1 行反转 + 1 行序列）**：① `:12` 的 `expect(THINKING_EFFORT_LEVELS).toEqual(['off','low','medium','high'])` → **5 项** `['off','low','medium','high','max']`；② `:19-20` 中 `expect(isThinkingEffort('max')).toBe(false)` **改为 `true`**；⚠️ **`expect(isThinkingEffort('xhigh')).toBe(false)`（`:19` 或其邻近行）保持 `false` 不变**——`xhigh` 不在本次枚举（建议同步改掉该用例名，去掉其中「xhigh/max not exposed」的旧前提，仅对 `max` 解禁）；③ `:35` 的 `normalizeThinkingEffort('xhigh','off')` 期望 **仍为 `'off'`（不用改）**——`xhigh` 依旧非法 |
| **（FR11）** `electron/effortFallback.test.ts` | 改：`:23-36` 的 wire 映射用例补 `max` 断言（`buildThinkingWireParams('max')` → `outputConfig.effort === 'max'`），并保留 `off` 无 `output_config` 的断言 |
| ⚠️ 其他档位枚举消费方的测试 | 需按 **5 档**复核：凡断言 `THINKING_EFFORT_LEVELS` 长度或档位文案为 4 项的测试（含 `configModalSnapshot.test.ts` 若含档位快照）均须更新 |
| **（FR12）** `src/shared/llmModelConfig.test.ts:257-265` | **必须改（断言反转）**：用例名「`buildChatModelOptions` **always uses service prefix** in displayName」的前提已被推翻。① `:261` 对**同名跨服务**（`deepseek-v4-pro` × 2 服务）的期望 `['Deep-deepseek-v4-pro','Volcano-deepseek-v4-pro']` **保持不变**（歧义 → 仍带前缀）；② `:264` 对**唯一服务**的期望 `'Deep-deepseek-flash'` **须改为 `'deepseek-flash'`**（无前缀）；③ 建议**补**一条「唯一服务不加前缀」的显式用例，并**改用例名**为「prefixes only when the model name is ambiguous」 |
| **（FR12）** `src/renderer/services/sessionModelBinding.test.ts:69/84/97-100/106` | **必须改（多处断言反转）**：① `:69` `expect(binding.displayName).toBe('Default-deepseek-flash')` → **`'deepseek-flash'`**；② `:84` 同上 → **`'deepseek-flash'`**；③ `:87` 用例名「lists **service-prefixed** display names for all options」须改名，`:97-100` 的断言（同名跨服务 → 两个带前缀值）**保持不变**；④ `:103` 用例名「**prefixes single-service options as well**」的前提被推翻 → 改名并把它断言反转为 **`expect(...).toBe('glm-5.3')`**（`:106`） |

运行策略遵循 `AGENTS.md`：开发中只跑定向测试（`npm exec vitest run <文件>`），收尾再全量。

### 7.3 需同步修订的既有文档

| 文档 | 修订点 |
|------|--------|
| ⚠️ **`docs/requirement/thinking-effort-settings-requirement.md` §4.1 / §2.3** | **该档为已定稿状态，本需求修订其档位范围决策**：原文「与契约保持四档，**不新增 `max` / `xhigh`**」须改为「**新增 `max`（共 5 档）；`xhigh` / `minimal` 仍不暴露**」，并补 `max` 的语义与文案。**这是本需求对外影响最大的一处修订**，须经该档确认 |
| 同档 §5.1 / §5.4 | 设置页全局强度下拉由 4 项变 **5 项**（`Select` 的 `options` 自动跟随 `THINKING_EFFORT_LEVELS`），文案表补 `max` 一档 |
| 同档 §7.3 映射表 | 由 4 行扩为 **5 行**（+`max` → `{ effort: 'max' }`）。**无需**记录类型转换——`max` 在 SDK 白名单内（§2.6） |
| 同档 §7.4 | 无需改动；建议在该档记一笔：`max` 若被某些网关忽略，属**静默失效**（而非 400），详见本档 §2.6「fail-open 的副作用」 |
| `docs/requirement/thinking-effort-settings-requirement.md` §5.2 | 入口位置 / 触发 / 展示态：由「模型 chip 之后的独立强度控件」改为「与模型合并的单一入口 + 浮层下分区」；**展示态**由「未覆盖显示 `默认（中）`、覆盖显示档位词」改为「**收起态恒定显示档位词**（不区分继承 / 覆盖），继承信息移入浮层 `· 默认` 标记与入口 `title`」；「禁用」语义改为「仅强度分区禁用」 |
| 同档 §5.4 | i18n 表：补 `composer.prefs.*`，标注 `modelPicker.switchModel/selectModelAria` 语义变更，并记录档位词（`composer.thinking.*`）现被收起态 chip 复用 |
| 同档 §2.7 / §5.2.1 的「落位空间」论据 | 增补一笔：合并入口后 footer 左段占用进一步下降，`statusCollapsed` 折叠更少触发（该档自身的历史取舍仍成立，不改键位） |
| `docs/requirement/llm-multi-service-model-config-requirement.md` §9.2 / §9.3 | ① §9.2「当前展示」由「展示名（服务名-模型名）」改为「**收起态 = 模型名（＋歧义时的服务段）＋ 当前推理强度**；服务名前缀与徽章信息在浮层内展示」；② **§9.3 的「展示名规则」由「规定」升级为「已实现」**——原实现与该规定不一致的偏差，已由本需求（FR12）修正，须在该档标注实现状态与生效版本 |
| `docs/requirement/composer-hint-responsive-requirement.md` | 已标注废弃，保持；如引用其文案需同步指向本档 |

---

## 8. 边界与异常

| # | 情况 | 期望行为 |
|---|------|----------|
| E1 | 模型名为超长字符串（如 `claude-3-5-sonnet-20241022` 等带日期版本号） | **模型段**省略号截断；**强度段不受影响**（FR3 截断优先级）。`max-width: 220px` 保持（§10）；`title` 给全量信息 |
| E1a | 宽度极窄，模型段已截到只剩几个字符 | 仍保证强度段完整可见（极端情况允许模型段退化为 `de… · 中`）。这是**刻意取舍**，服务于「强度随时可查」的目标 |
| E2 | 同名模型出现在多个启用服务 | **（§10）**：模型段后**缀全角括号服务名**（`deepseek-v4-pro（Deep）`）。⚠️ **不得**用 `·` 作分隔（强度段专用）。歧义消除后 `title` 与浮层仍保留完整信息 |
| E2a | 服务段导致 chip 超宽（长服务名，如 `火山CodingPlan`） | 服务段**随模型段一同参与截断**（同属 `.composer-model-chip__label` 的收缩范围）；**强度段仍不被截断**（FR3 优先级不变）。极端下允许截为 `deepseek…（火…） · 中` |
| E3 | `sessionBinding.option === undefined`（绑定失效） | 入口警告色 + `modelPicker.unavailableHint`；浮层正常 |
| E4 | 可用模型池为空 | `modelPicker.empty` 空态；入口文案按 FR3 回退 |
| E5 | `supportsThinking === false` | 入口可点；强度分区禁用 + `composer.prefs.effortDisabled` 提示；**不清空**已存会话档位（切回支持模型即按原值生效，遵循 §7.1 运行时语义） |
| E6 | `session:update` 失败 | 强度：`message.error(formatUserFacingError(...))`（沿用现状）；模型：沿用现状无显式 toast（不在本需求范围扩大） |
| E7 | 浮层打开时会话被切换 / 关闭 | 浮层关闭，按新会话重算绑定（§5.4） |
| E8 | 浮层打开时配置变更导致模型列表变化（设置页保存） | 列表实时重算（`listChatModelOptions(cfg)` 为纯函数 + `useMemo`，随 `cfg` 更新） |
| E9 | 极窄窗口 | 浮层由 antd 约束在视口内；入口 chip 不因窄而变形（`flex-shrink: 0` 保持），宽度不足表现为**模型段截断 + 强度段保留**，而非 chip 消失 |
| E10 | 首次会话尚未创建（composer 先渲染） | 草稿语义不变：模型与强度均可先选，随代建会话写入（§6.2 既有 `draft*` 机制） |
| E11 | 高低 DPI / 缩放 | 浮层使用固定 px 尺寸（与现网一致），不引入新的媒体查询依赖 |
| E12 | **该模型可用档位仅 2 个**（当前基线最少情况，如 `gpt-5-pro` = `off`/`high`、`openai/o3-mini-high` = `off`/`high`） | 强度分区只渲染这 2 项；容器左对齐、不拉伸占满；若某项即当前全局档位的 `· 默认` 槽位，标记照常显示。（§2.6 ②：当前基线**不存在** 1 档模型） |
| E13 | **整个 `thinkingLevelMap` 键缺失**（`source: 'unknown'`，如 `claude-haiku-4-5`） | fail-open：渲染全部 **5 档**（§2.6 R3）。**不得**因缺数据而禁用整个强度分区。⚠️ 副作用：这些模型可能实际不支持 `max`，用户选了会由 §7.4 兜底（§2.6「fail-open 的副作用」） |
| E13a | **map 存在但个别档位键缺失**（如 `claude-opus-4-6` 仅有 `max` 键） | **视为可用**，渲染全部 **5 档**——只有**显式 `null`** 才剔除（§2.6 判定语义）。⚠️ 实现**不得**写成"键不存在即不支持" |
| E13b | **`"off": null`**（如 `claude-fable-5`、`glm-5.2` 的 `"off": "none"`） | **不影响**——`off` 不在 `PRODUCT_EFFORTS`/`EXCLUDABLE_EFFORTS` 内，恒可用（§2.6 R2） |
| E14 | **基线升级后，原选中档位被改为显式 `null`**（如 `high` 被排除） | 收起态强度段仍**如实显示**该档位词（反映会话实际值）；浮层内该档位**不再渲染**（§10）；**不**自动改写 `session.thinkingEffort`（运行时降级由 §7.4 负责） |
| E15 | **不同模型/服务商的档位集合不同** | 切换模型后，强度分区**立即**按新模型的可用集合重算（`availableEfforts` 随 `chatModelName` 变化，方案 A 纯函数可即时）；收起态强度段不受影响（仍显示会话/全局档位值） |
| E16 | **档位数 > 4**（**本需求主场景：5 档**） | 横向容器 `flex-wrap: wrap` 自动换行，**5 档按 §5.2 的容量计算落为 4+1 两行**，不溢出、不裁切。⚠️ **必须实测**（A25） |

---

## 9. 验收标准

### 9.1 收起态（可自动化断言）

| # | 验收项 |
|---|--------|
| A1 | composer footer 左段**只存在一个**偏好入口控件（不存在第二个强度 chip） |
| A2 | 入口文案的**模型段**＝当前模型名，**不含**服务名前缀（如 `deepseek-v4-pro`，而非 `Deep-deepseek-v4-pro`） |
| A2a | 入口文案含**当前生效档位**文案（如 `claude-opus-5-5 · 中`；示例须自洽，见 FR3），且**继承与覆盖两态都显示** |
| A2b | 切换档位后，入口**强度段立即更新**（无需重开浮层、无需重发消息） |
| A2c | 可用宽度不足时：**模型段（含服务段）被省略号截断、强度段完整可见**（人工验收——jsdom 不渲染真实布局） |
| A2d | **（§10）** 同名模型被 ≥2 个启用服务支持时，入口显示 `模型名（服务名） · 档位`；**仅 1 个服务支持时，不得出现括号** |
| A3 | 入口 `title` 含 `{服务名}-{模型名}` 与当前强度文案（含是否继承全局） |
| A4 | 会话模型不可用时入口带警告态类名 |
| A5 | 无可用模型时入口文案按 FR3 回退，且仍可点击 |

### 9.2 浮层

| # | 验收项 |
|---|--------|
| A6 | 点击入口弹出**单个**浮层，同一浮层内同时包含模型列表与强度档位区 |
| A7 | 浮层内模型项含模型名 + 服务名副文案 + 快速 / 视觉徽章；当前绑定项呈现选中态 |
| A8 | 强度分区渲染的档位项**等于**传入的可用档位集合（**不固定为 4**）：等于当前全局档位的一项带 `· 默认` 标记；未覆盖时该项为选中态 |
| A9 | 点击「`X · 默认`」项回调 `null`（清除覆盖），其余档位回调对应值 |
| A9a | **（§10）** 选中任一模型或任一档位后浮层**立即关闭**（两种选择行为一致，无双标） |
| A10 | `supportsThinking === false`：浮层**可打开**，强度分区禁用并显示提示；模型列表可正常选择 |
| A11 | 模型列表超长时仅模型分区内滚动，浮层整体不超出视口 |

### 9.3 行为不变（回归）

| # | 验收项 |
|---|--------|
| A12 | 选模型后 `session:update` 载荷仍为 `{ model: modelName, llmServiceId: serviceId }`；入口文案随之更新 |
| A13 | 选档位后 `session:update` 载荷仍为 `{ thinkingEffort }`（默认项为 `null`） |
| A14 | 无会话时两者均以草稿形式保留，并在首个会话创建时一并写入 |
| A15 | 运行时档位 → provider 映射、`supportsThinking` 降级路径无任何改动（相关既有测试全绿） |

### 9.4 空间收益（人工验收，需真机）

| # | 验收项 |
|---|--------|
| A16 | 同一窗口宽度下，合并前后对比：footer 左段总占用**仍净下降**（**无歧义场景** ≈34–98px，估算依据见 §5.2.1）——即使强度文本已移入 chip |
| A16a | **（§10）** **有歧义场景**（服务段回归）：净收益缩水但仍**不增宽**（下限由合并省下的 padding + gap ≈34px 提供）；长服务名极端情况允许接近打平，**不得为负**（真机验收，需构造同名跨服务配置） |
| A17 | 「运行状态文案被迫折叠为 22px 图标」的窗口宽度阈值**右移**（即更早的宽度下状态文案仍可展开） |
| A18 | 拖动左/右侧栏改变可用宽度时，状态区折叠的切换无闪烁、无布局抖动 |

### 9.5 无障碍

| # | 验收项 |
|---|--------|
| A19 | 入口具备 `aria-haspopup` / `aria-expanded`，且 `aria-label` 同时描述模型与强度 |
| A20 | 键盘可达：Tab 进入浮层可遍历两分区；Esc 关闭并归还焦点到入口 |
| A21 | 读屏可识别强度分区及其选中项（`radiogroup` / `radio` + `aria-checked`） |

### 9.6 档位集合数据驱动（FR10，可自动化断言）

| # | 验收项 |
|---|--------|
| A22 | 传入 `availableEfforts = ['off','high']` → 强度分区**只渲染 2 项**（且**不含** `low/medium/max`，验证「不渲染」，§10）；**不传** → fail-open 渲染 **5 项** |
| A22a | 对 `claude-opus-4-6`（map 仅有 `max` 键）→ 渲染**全 5 档**（键缺失不排除，§2.6 / E13a）；对 `gpt-5-pro`（`low`/`medium`/`max` 显式 `null`）→ 只渲染 **2 档**（`off`/`high`） |
| A22b | **（§2.6）** fail-open 路径：`claude-haiku-4-5`（无 `thinkingLevelMap`）→ 渲染 **5 档**（含 `max`） |
| A22c | **（FR11）** 5 档枚举生效：`THINKING_EFFORT_LEVELS` 含 `max`；`isThinkingEffort('max')` 返回 **true**（`thinkingEffort.test.ts` 原断言须反转）；⚠️ `isThinkingEffort('xhigh')` **仍须返回 `false`**（该断言**保持不变**） |
| A22d | **（FR11）** `buildThinkingWireParams('max')` → `output_config = { effort: 'max' }`，**无需任何类型转换**；`off` 仍产出 `{ thinking: { type: 'disabled' } }` 且**不带** `output_config` |
| A23 | 全仓**无**「把 `THINKING_EFFORT_LEVELS` 直接 map 成 UI 项」的硬编码路径（用于本组件）；档位文案按**实际档位键**逐项取词 |
| A24 | 切换到档位集合不同的模型后（如 5 档模型 → `gpt-5-pro` 2 档），强度分区项数**随之变化**且**无需发消息**（验证方案 A 的即时性）（人工验收 + 单测覆盖） |
| A25 | 档位项数变化时，横向容器**不溢出、不裁切**：**5 档须正确换行为 2 行**（4+1）；2–3 项不拉伸占满（人工验收，jsdom 不渲染真实布局） |

> **A26 删除留痕（2026-09-30）**：原 A26（「SDK 类型转换单点验收」——验证 `buildThinkingWireParams` 对扩展档位的类型转换）已随 §FR11 的方案收敛**删除**：仅新增 `max`，而 SDK `OutputConfig.effort` 白名单（`messages.d.ts:708`）本就含 `max`，**无需任何类型转换**（该事实已并入 A22d 验收）。故验收项编号自 A25 直跳 A27。

### 9.7 展示名规则（FR12，可自动化断言）

| # | 验收项 |
|---|--------|
| A27 | **唯一服务支持**的模型 → `displayName === modelName`（**无** `{serviceName}-` 前缀）；**≥2 服务支持**的同名模型 → 每条 `displayName` **均带**前缀 |
| A27a | 断言反转到位（§7.2）：`llmModelConfig.test.ts` 的「always uses service prefix」用例改名并反转唯一服务断言；`sessionModelBinding.test.ts` 的 `:69/:84/:106` 三处改为无前缀，**同名跨服务断言（`:97-100`）保持不变** |
| A27b | **不回归**：浮层模型列表渲染正常（其用 `serviceName` + `modelName` 分开渲染，不读 `displayName`）；设置页与配置快照无变化 |

---

## 10. 决策记录

| # | 事项 | 结论 | 正文落点 |
|---|------|------|----------|
| OQ-1 | 收起态是否显示强度 | **恒定显示**当前档位（不区分继承 / 覆盖） | FR3 / §5.1 / A2a |
| OQ-2 | 浮层分区标题 | 两个分区**都显示**（「模型」/「思考强度」） | FR2 / §5.2 / §6.5 |
| OQ-3 | 强度分区形态 | **横向**；档位集合数据驱动，**不得写死档位数** | FR10 / §2.6 / §5.2 / §6.6 |
| OQ-4 | 选中后浮层行为 | **立即关闭**（模型与档位行为一致） | FR2 / §5.1 / §5.3 / A9a |
| OQ-5 | 同名跨服务是否提示服务名 | **提示**：以全角括号缀服务名（`（Deep）`），仅歧义时出现 | FR3 / §3 / §5.2.1 / §6.2 / §6.5 / E2 |
| OQ-6 | 旧 i18n 键 | 新增 `composer.prefs.*` 后**删除** `modelPicker.switchModel` / `selectModelAria` | §6.5 |
| OQ-7 | 文案用词 | 沿用**「思考强度」**，不改「推理强度」 | §3 / §6.5 |
| OQ-8 | `MessageInput` slot | `modelSlot` + `thinkingSlot` 收敛为单个 **`prefsSlot`** | §6.3 / §7.1 / §7.2 |
| OQ-9 | `displayName` 规则偏差 | **一并修正**：唯一支持 → 无前缀；≥2 服务支持 → 带前缀 | FR12 / §2.3 / §7.1 / §7.2 / §7.3 / §9.7 |
| OQ-10 | 入口 chip 宽度上限 | 保持 **`max-width: 220px`** | §5.2 / E1 / E2a |
| OQ-11 | 暴露哪些上游档位 | **仅新增 `max`**（共 5 档）；`minimal` / `xhigh` **不加** | FR11 / §2.6 / §5.2 / §6.5 / §7.1 / E16 |
| OQ-12 | 不可用档位 | **不渲染**（从列表剔除，非「渲染但禁用」） | FR10 / §5.2 / §6.2 / A22 |
| OQ-13 | 可用档位集合来源 | **renderer 自算**（方案 A：零 IPC，数据已在 bundle） | §6.6 / §7.1 / FR10 / A24 |
| OQ-14 | fail-open 是否收紧 | **不收紧**（键缺失 = 全部档位可用，保持现状） | §2.6 |
| OQ-15 | `max` 档文案 | **`最高`**（en-US `Max`） | §6.5 |




---

## 11. 相关文件

**需求 / 设计文档**

- `docs/requirement/thinking-effort-settings-requirement.md`（强度档位来源；§5.2 会话级覆盖，需按 §7.3 修订）
- `docs/requirement/llm-multi-service-model-config-requirement.md`（§9 聊天区模型选择器、§9.3 展示名规则，需按 §7.3 修订）
- `docs/requirement/composer-hint-responsive-requirement.md`（已废弃，历史参考）
- `docs/requirement/chat-message-ui-requirement.md`、`docs/requirement/context-usage-ring-requirement.md`（footer 右段同区控件，仅作布局上下文）

**实现文件**

- `src/renderer/components/Chat/ComposerModelPicker.tsx`、`ComposerThinkingPicker.tsx`（待合并 / 删除）
- `src/renderer/components/Chat/MessageInput.tsx`（slot 收敛、`checkOverflow` 简化）
- `src/renderer/components/Chat/ChatView.tsx`（slot 组装、`handleModelSelect` / `handleThinkingSelect`）
- `src/renderer/services/sessionModelBinding.ts`（`resolveSessionModelBinding` / `resolveSessionThinkingBinding` / `listChatModelOptions`）
- `src/shared/thinkingAvailability.ts`（**FR10 核心数据源**：`resolveThinkingAvailability` / `ThinkingAvailability` / `PRODUCT_EFFORTS`）
- `src/shared/modelBaseline.ts`（`MODEL_BASELINE` / `ThinkingLevelMap`）与 `res/resource/model-baseline.json`（逐模型 `thinkingLevelMap`）
- `electron/toolChatLoop.ts:1004-1010`（availability 现有唯一消费点：运行时 fail-soft 短路）
- `electron/effortFallback.ts`（`memoizeEffortUnsupported` / `isEffortUnsupportedByUpstream`，运行期记忆）
- `src/shared/agent/invocation.ts:86`（`AgentReasoningEffort` 枚举边界）
- `electron/turnExecutionConfig.ts`（`resolveThinkingEffort`，运行时档位解析）
- `src/shared/llmModelConfig.ts`（`buildChatModelOptions`、`ChatModelOption.displayName`；**FR12** 修正规则）
- `src/shared/llmModelConfig.test.ts`、`src/renderer/services/sessionModelBinding.test.ts`（**FR12** 断言反转，§7.2）
- `src/shared/thinkingEffort.ts`（`THINKING_EFFORT_LEVELS`）
- `src/renderer/components/Config/ConfigModelOption.tsx`（`ConfigModelBadges` 徽章复用）
- `src/renderer/theme/layout.css`、`config-settings.css`、`components.css`
- `src/renderer/i18n/resources/{zh-CN,en-US}/chat.json`

**测试**

- `src/renderer/components/Chat/ComposerThinkingPicker.test.tsx`（迁移）
- `src/renderer/components/Chat/MessageInput.test.tsx`（§7.2 改写）
- 新增 `src/renderer/components/Chat/ComposerModelThinkingPicker.test.tsx`
