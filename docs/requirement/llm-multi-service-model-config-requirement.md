# 多套 API 服务 × 模型能力配置 — 需求规格

**版本：** 1.3  
**日期：** 2026-06-17  
**状态：** 已定稿  
**关联文档：** [llm-service-profiles-requirement.md](./llm-service-profiles-requirement.md)、[settings-ui-refinement-requirement.md](./settings-ui-refinement-requirement.md)、[settings-requirement.md](./settings-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-06-17 | 初稿：服务级模型勾选、多服务并行启用、视觉标签、三类优选默认模型 |
| 1.1 | 2026-06-17 | 产品确认 OQ-1～OQ-7；补充聊天区模型选择器、会话模型绑定、禁用模型自动 prune |
| 1.2 | 2026-06-17 | 服务名与模型名展示分隔符统一为单连字符 `-` |
| 1.3 | 2026-06-17 | 明确快速与视觉标签可同时存在、互不排斥 |

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [目标与非目标](#3-目标与非目标)
4. [概念模型](#4-概念模型)
5. [设置页 UI 规格](#5-设置页-ui-规格)
6. [大模型列表与标签](#6-大模型列表与标签)
7. [三类优选默认模型](#7-三类优选默认模型)
8. [运行时解析规则](#8-运行时解析规则)
9. [聊天区模型选择器](#9-聊天区模型选择器)
10. [数据模型与存储](#10-数据模型与存储)
11. [迁移与兼容](#11-迁移与兼容)
12. [验收标准](#12-验收标准)
13. [已决事项（原 OQ）](#13-已决事项原-oq)
14. [相关文件](#14-相关文件)

---

## 1. 概述

### 1.1 背景

当前「大模型」设置页（`ModelsSettingsTab`）具备以下局限：

| 局限 | 说明 |
|------|------|
| 服务与模型解耦但不精细 | 多套 API 服务共用全局模型列表，**无法声明某服务实际支持哪些模型** |
| 单服务激活 | 「当前使用」为 **Radio 单选**，同一时刻仅一套服务的 Key / Base URL 生效 |
| 单一默认模型 | 仅一个「默认大模型」下拉框（`isDefault`），无法区分语言 / 快速 / 视觉三类使用场景 |
| 标签不完整 | 模型仅有「快速」标签，缺少「视觉」能力标识 |
| 列表 UI 已精简 | [settings-ui-refinement-requirement.md](./settings-ui-refinement-requirement.md) 将模型列表收拢为单个下拉框，无法满足「服务内模型选择与下方列表一致展示」的需求 |

用户实际场景：同时订阅多套 Coding Plan / 代理，各套餐支持的模型子集不同；希望 **并行启用** 多个服务，使 **各服务所勾选模型的并集** 成为可用模型池；并按场景自动或手动选用合适的默认模型。

### 1.2 本需求要解决的问题

| # | 用户诉求 | 本需求对应能力 |
|---|----------|----------------|
| R1 | 每个 API 服务可配置其支持的模型（多选） | 服务卡片内「支持模型」多选 |
| R2 | 服务内模型选择与下方大模型列表展示一致 | 共用 `ModelEntry` 数据源 + 统一 `ConfigModelOption` 渲染（含标签） |
| R3 | 可同时勾选多个「当前使用」的 API 服务 | `activeLlmServiceIds: string[]` |
| R4 | 大模型列表增加「视觉」标签 | `ModelEntry.isVision`；与「快速」**可同时**存在（§6.1） |
| R5 | 默认大模型拆为三类优选 | 语言 / 快速语言 / 视觉 三个独立下拉框 |
| R6 | 聊天区可选择具体模型（含服务来源） | 点击弹出可选列表；同模型多服务时加服务名前缀 |

---

## 2. 现状分析

### 2.1 数据模型（`src/shared/domainTypes.ts`）

```typescript
export interface ModelEntry {
  id: string
  name: string
  maximumContext: number
  maxTokens: number
  isDefault: boolean   // 当前唯一「默认大模型」标记
  isFast: boolean
  enabled: boolean
}

export interface LlmServiceProfile {
  id: string
  name: string
  baseUrl: string
  apiKeyPresent: boolean
  // 无 supportedModels 字段
}

export interface AppConfig {
  llmServices: LlmServiceProfile[]
  activeLlmServiceId: string          // 单选
  defaultModel: string
  models: ModelEntry[]
}
```

### 2.2 内置模型（`DEFAULT_MODELS`）

共 11 个预置模型，来源 `res/resource/modes.md`（仅含 `is_fast_model`，**无视觉字段**）：

| 模型名称 | isFast（现网） | isVision（§6.4） | 展示 |
|----------|----------------|------------------|------|
| kimi-k2.6 | 否 | 是 | 视觉 |
| glm-5.1 | 否 | 是 | 视觉 |
| minimax-m2.7 | 否 | 是 | 视觉 |
| deepseek-v4-pro | 否 | 否 | 无 |
| deepseek-v4-flash | 是 | 否 | 快速 |
| claude-sonnet-4-6 | 否 | 是 | 视觉 |
| claude-opus-4-7 | 否 | 是 | 视觉 |
| claude-haiku-4-5 | 是 | 是 | **快速+视觉** |
| gpt-5.5 | 否 | 是 | 视觉 |
| gemini-3.1-pro | 否 | 是 | 视觉 |
| gemini-3.1-flash-lite | 是 | 是 | **快速+视觉** |

> **说明：** `isFast` 与 `isVision` **独立**，可同时为 true（见 §6.1）。DeepSeek V4 Pro / Flash **不支持**图片输入（`isVision: false`）。

### 2.3 UI 现状（`ModelsSettingsTab.tsx`）

- **API 服务区**：`LlmServiceCard` — Radio 单选「当前使用」+ Key / URL / 测试连接；**无模型选择**
- **大模型设置区**：单个「默认大模型」Select + 恢复默认 / 添加模型 Popover；**无完整模型列表**
- **标签展示**：`ConfigModelOption` 仅渲染「快速」胶囊；改造后须同时支持「视觉」及 **双标签并列**

### 2.4 运行时现状

- `getActiveLlmService()` 返回 **唯一** 激活服务的凭证（`electron/llmServiceResolver.ts`）
- 主聊天、Skill 路由、标题生成等均通过 `config.baseUrl` + 激活服务 Key 调用
- `isFast` 字段存在于数据层，**尚无统一的「快速模型解析」运行时入口**（Skill 路由默认使用会话模型）
- **无视觉模型自动切换逻辑**；图片附件相关能力在飞书集成设计中有预留，尚未与设置页联动

---

## 3. 目标与非目标

### 3.1 目标

| # | 目标 |
|---|------|
| G1 | 每套 API 服务可 **多选** 其支持的模型（模型 id 列表） |
| G2 | 服务内模型选择与「大模型列表」 **同源、同展示**（名称 + 上下文/输出 + 快速/视觉标签） |
| G3 | 「当前使用」改为 **多选**；可用模型池 = 所有已勾选服务所支持模型的 **并集** |
| G4 | `ModelEntry` 增加 `isVision`；与 `isFast` **独立**，内置模型按 §6.4 默认标注（含双标签项） |
| G5 | 将单一「默认大模型」拆为 **三类优选默认模型** 下拉框，并施加标签约束 |
| G6 | 恢复/新增 **大模型列表** 区块，作为全局模型目录与服务内选择的参照 |
| G7 | 平滑迁移：旧配置升级后行为可预期，不丢失 Key 与服务 |
| G8 | 聊天区 **新增** 模型选择入口：点击弹出列表，可选所有启用服务支持的模型；同模型多服务时展示服务名前缀 |
| G9 | 禁用模型时 **自动** 从各服务 `supportedModelIds` 移除 |

### 3.2 非目标

- 不为每个模型维护 **独立的 API Key**（仍归属服务）
- 不在本需求中实现 **聊天输入框的图片附件上传**（仅配置层标记视觉模型；实际上下文注入另开需求）
- 不支持「同模型名、不同服务、不同 maxTokens」的 per-service 参数覆盖（仍读全局 `ModelEntry`）
- 不在聊天界面提供 **API 服务管理**（服务增删改仍在设置页）
- 不自动从服务商 API **拉取模型列表**（仍为用户勾选 + 手动添加自定义模型）

---

## 4. 概念模型

### 4.1 三层结构

```
┌─────────────────────────────────────────────────────────────┐
│  大模型列表（全局目录 ModelEntry[]）                          │
│  · 定义模型 id / name / 上下文 / 输出 / 快速 / 视觉 / 启用    │
└───────────────────────────┬─────────────────────────────────┘
                            │ 引用 model id
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   服务 A              服务 B              服务 C
   supportedModelIds   supportedModelIds   supportedModelIds
   [勾选] 当前使用      [勾选] 当前使用      [ ] 未启用
        └───────────────────┬───────────────────┘
                            ▼
              可用模型池 = ⋃(启用服务的 supportedModelIds)
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   优选语言模型         优选快速语言模型      优选视觉模型
   (无标签约束)         (必须 isFast)        (必须 isVision)
```

### 4.2 「当前使用」语义变更

| 维度 | 现网 | 改造后 |
|------|------|--------|
| 控件 | Radio 单选 | **Checkbox 多选** |
| 存储 | `activeLlmServiceId: string` | `activeLlmServiceIds: string[]` |
| 最少数量 | 1 | **至少 1 个** 服务处于「当前使用」 |
| 凭证 | 唯一激活服务 | 按 **§8.2 服务解析规则** 为每次 LLM 调用选择具体服务 |

### 4.3 可用模型

**可用模型（Available Model）**：同时满足：

1. `ModelEntry.enabled === true`
2. 存在至少一个 **「当前使用」** 的服务，且该服务的 `supportedModelIds` 包含此模型 id

不可用模型不出现在：三类优选下拉框、聊天区模型选择器（§9）、测试连接模型候选（见 §8.4）。

---

## 5. 设置页 UI 规格

设置页仍为单一 Tab「大模型」（`ModelsSettingsTab`），分 **两个 section**（与现网一致），内容扩展如下。

### 5.1 Section A — API 服务

#### 5.1.1 区块说明文案

| 语言 | 文案（建议） |
|------|--------------|
| zh-CN | 每套服务包含独立的 API Key 与 Base URL。**可勾选多个「当前使用」的服务**；仅各服务所支持的模型会进入可用模型池。 |
| en-US | Each service has its own API key and base URL. **You may enable multiple services at once**; only models supported by enabled services become available. |

#### 5.1.2 服务卡片结构（展开态）

在现有 Key / URL / 测试连接 **之上或之下** 增加「支持模型」区域：

```
┌─ 服务卡片 ─────────────────────────────────────────────┐
│ [✓] 当前使用   [服务名称___________]  [删除]          │
│ ─────────────────────────────────────────────────────  │
│ 支持模型                                    [全选][清空]│
│ ┌──────────────────────────────────────────────────┐  │
│ │ ▼ 多选下拉 / 可滚动 Checkbox 列表                  │  │
│ │   ⚡ claude-haiku-4-5  [快速] [视觉]                 │  │
│ │   ⚡ deepseek-v4-flash  [快速]                         │  │
│ │   👁 kimi-k2.6         [视觉]                         │  │
│ │   deepseek-v4-pro                                  │  │
│ │   ...                                              │  │
│ └──────────────────────────────────────────────────┘  │
│ API Key ...                                            │
│ Base URL ...                                           │
│ [测试连接]                                             │
└────────────────────────────────────────────────────────┘
```

#### 5.1.3 「支持模型」控件规格

| 需求点 | 描述 |
|--------|------|
| 数据源 | 全局 `models` 中 **`enabled === true`** 的条目（与服务是否已勾选无关） |
| 选项展示 | 复用 `ConfigModelOptionContent`（`compact` 或完整模式与产品稿一致）；须含 **快速 / 视觉** 标签 |
| 选中态 | 绑定 `LlmServiceProfile.supportedModelIds: string[]` |
| 默认选中 | **新建服务**：默认勾选 **全部** 已启用模型（降低配置成本） |
| 最少选择 | 保存时每个 **「当前使用」** 的服务至少勾选 **1** 个模型；未勾选当前使用的服务可为 0 |
| 全选 / 清空 | 可选快捷按钮，仅作用于本卡片 |
| 排序 | 与 §6.3 大模型列表一致（快速优先，其余保持目录顺序） |

> **与 R2 对齐：** 服务内下拉/列表的每一行，与下方「大模型列表」中对应条目的 **名称、元信息、标签** 一致。

#### 5.1.4 「当前使用」控件

| 需求点 | 描述 |
|--------|------|
| 控件 | `Checkbox` 替代 `Radio` |
| 视觉 | 多个服务可同时带 `llm-service-card--active` 高亮样式 |
| 删除服务 | 若删除项在 `activeLlmServiceIds` 中，从数组移除；若数组为空，**自动将列表第一项** 设为当前使用 |
| 折叠摘要 | 收起态摘要增加「已支持 N 个模型」 |

### 5.2 Section B — 大模型设置

自上而下顺序：

1. **三类优选默认模型**（§7）
2. **大模型列表**（§6）
3. **默认开启 Thinking**（保持现网 Switch）

#### 5.2.1 与现网差异

| 现网 | 改造后 |
|------|--------|
| 单一「默认大模型」下拉 | **三个** 下拉框（§7） |
| 无列表，仅下拉 + 添加 Popover | **恢复大模型列表** + 添加 Popover |
| Popover 仅「快速」复选框 | Popover 增加 **「视觉」** 复选框 |

---

## 6. 大模型列表与标签

### 6.1 标签语义（快速 × 视觉）

`isFast` 与 `isVision` 为 **两个独立布尔字段**，**互不排斥**。同一条 `ModelEntry` 可出现以下四种组合：

| isFast | isVision | 列表展示 | 典型用例 |
|--------|----------|----------|----------|
| 否 | 否 | 无标签 | `deepseek-v4-pro` |
| 是 | 否 | 仅「快速」 | `deepseek-v4-flash`（快速但不支持图片） |
| 否 | 是 | 仅「视觉」 | `kimi-k2.6`、`claude-sonnet-4-6` |
| **是** | **是** | **「快速」+「视觉」并列** | `claude-haiku-4-5`、`gemini-3.1-flash-lite` |

**UI 要求：**

- 标签区 **同时渲染** 两个胶囊（若均为 true）；顺序固定：**快速** 在前，**视觉** 在后，中间留 4px 间距
- 设置页下拉、服务「支持模型」选择器、聊天区模型列表 **均须** 支持双标签展示，不得互斥隐藏
- 「添加模型」Popover 中「快速」「视觉」为 **两个独立 Checkbox**，可同时勾选
- 三类优选下拉框的标签约束 **仅作用于对应下拉**（快速优选要求 `isFast`；视觉优选要求 `isVision`）；**不** 要求互斥——例如 `claude-haiku-4-5` 可同时出现在快速优选与视觉优选的候选列表中

### 6.2 数据结构变更

```typescript
export interface ModelEntry {
  id: string
  name: string
  maximumContext: number
  maxTokens: number
  isDefault: boolean      // @deprecated 迁移后废弃，见 §11
  isFast: boolean         // 与 isVision 独立，可同时为 true
  isVision: boolean       // 与 isFast 独立，可同时为 true
  enabled: boolean
}
```

### 6.3 大模型列表 UI

恢复可视化列表（参考 [settings-requirement.md](./settings-requirement.md) §3.1.3，并做以下调整）：

| 元素 | 规格 |
|------|------|
| 第一行 | 启用 Switch + 模型名称 + 标签区 + 删除按钮（仅用户添加的模型可删；内置模型不可删，可禁用） |
| 标签区 | 「快速」「视觉」胶囊 **独立控制、可同时出现**（见 §6.1）；视觉标签使用 **区分色**（建议蓝/紫系，与快速橙色区分） |
| 第二行 | 上下文 / 输出 tokens 元信息 |
| 行内编辑 | **不提供** 行内「默认 / 快速 / 视觉」复选框；快速与视觉标签 **只读展示**，仅在「添加模型」Popover 中设置（已决 OQ-4） |
| 排序 | 快速模型置顶（`sortModelsFastFirst` 扩展：快速组内仍保持原序；非快速组内视觉标签不影响排序） |
| 空态 | 无启用模型时，三个优选下拉显示空态文案 |

#### 6.3.1 添加模型 Popover

| 字段 | 要求 |
|------|------|
| 模型名称 | 同现网 |
| 最大上下文 / 最大输出 | 同现网 |
| 快速模型 | 复选框，同现网；与「视觉」**独立**，可同时勾选 |
| **视觉模型** | 新增复选框：`标注为视觉模型（支持输入并理解图片）`；与「快速」**独立**，可同时勾选 |
| 默认 | 新模型 `isFast` / `isVision` 默认均为 **false** |

#### 6.3.2 恢复默认

点击「恢复默认」时：

- 模型列表重置为 `DEFAULT_MODELS`（含 `isFast` / `isVision` 默认值，见 §6.4）
- 三类优选默认模型重置为 §7.2 内置优选
- 各服务的 `supportedModelIds` **不自动修改**（避免覆盖用户服务配置）；若服务原勾选 id 已不存在，保存时校验提示

### 6.4 内置模型标签默认值

实现时在 `DEFAULT_MODELS` 中按下列组合写入 `isFast` / `isVision`（**非互斥**）：

| 模型名称 | isFast | isVision | 备注 |
|----------|--------|----------|------|
| kimi-k2.6 | 否 | **是** | 仅视觉 |
| glm-5.1 | 否 | **是** | 仅视觉 |
| minimax-m2.7 | 否 | **是** | 仅视觉 |
| deepseek-v4-pro | 否 | 否 | 无标签 |
| deepseek-v4-flash | **是** | 否 | 仅快速（不支持图片） |
| claude-sonnet-4-6 | 否 | **是** | 仅视觉 |
| claude-opus-4-7 | 否 | **是** | 仅视觉 |
| claude-haiku-4-5 | **是** | **是** | **双标签** |
| gpt-5.5 | 否 | **是** | 仅视觉 |
| gemini-3.1-pro | 否 | **是** | 仅视觉 |
| gemini-3.1-flash-lite | **是** | **是** | **双标签** |

同步更新 `res/resource/modes.md`，增加 `is_vision_model` 列（与 `is_fast_model` 并列；两列 **独立**，可同时为 1）。

### 6.5 标签 UI 组件

| 项 | 规格 |
|----|------|
| i18n key | `config.models.visionBadge` → zh: `视觉`，en: `Vision` |
| 添加 Popover | `config.models.add.visionLabel` |
| CSS 类名 | `config-model-badge--vision` |
| 展示位置 | `ConfigModelOptionContent`、`ConfigModelSelectValue`、大模型列表行、服务「支持模型」选择器、聊天区模型列表 |
| 双标签 | 当 `isFast && isVision` 时，**同一行内** 并排展示两个胶囊，不得合并为单一标签 |

---

## 7. 三类优选默认模型

### 7.1 字段定义

替换单一 `defaultModel` / `isDefault`：

| 配置字段 | 类型 | UI 标签（zh-CN） | 选项约束 |
|----------|------|------------------|----------|
| `preferredLanguageModelId` | `string`（ModelEntry.id） | **优选默认语言大模型** | 来自 **可用模型池**，无标签要求 |
| `preferredFastLanguageModelId` | `string` | **优选快速语言大模型** | 可用模型池中 **`isFast === true`** 的条目 |
| `preferredVisionModelId` | `string` | **优选视觉大模型** | 可用模型池中 **`isVision === true`** 的条目 |

下拉选项展示规则与现网默认模型 Select 相同（`ConfigModelOptionContent` + `ConfigModelSelectValue`）。

### 7.2 内置优选默认值（恢复默认 / 首次安装）

当对应模型存在于 **可用模型池** 时，默认选中下表模型；若不可用（未启用 / 无服务支持），则按 §7.3 回退。

| 配置项 | 优先匹配的模型 name | 备注 |
|--------|---------------------|------|
| 优选默认语言大模型 | `deepseek-v4-pro` | 与现网 `isDefault` 一致 |
| 优选快速语言大模型 | `deepseek-v4-flash` | 必须带快速标签 |
| 优选视觉大模型 | `kimi-k2.6` | 已决：沿用现网内置名 `kimi-k2.6`（非 2.7） |

### 7.3 回退策略

当用户配置的优选模型 **不在可用模型池** 中（服务变更、模型禁用、取消勾选等）：

| 场景 | 行为 |
|------|------|
| 保存设置时 | **不阻断保存**；运行时按回退链解析（§8.3） |
| UI 提示 | 对应下拉框下方显示 hint：`当前所选模型不可用，运行时将自动回退`（i18n） |
| 恢复默认 | 重新按 §7.2 写入三个 id |

**运行时回退链（同一类型内）：**

1. 用户配置的 `preferred*ModelId`（若可用）
2. §7.2 内置 name 对应 id（若可用）
3. 可用模型池中 **符合标签约束** 的第一项（列表顺序：快速优先排序规则）
4. 若仍无：语言类回退到任意可用模型；快速 / 视觉类回退到 `null` 并由调用方降级（见 §8.3）

### 7.4 移除 `isDefault`

| 项 | 处理 |
|----|------|
| `ModelEntry.isDefault` | 标记 `@deprecated`，迁移后恒为 `false` |
| `config.defaultModel` | 迁移为 `preferredLanguageModelId` 的 name 镜像（兼容只读旧代码），新代码读 id 字段 |
| UI | 移除对 `isDefault` 的写入 |

---

## 8. 运行时解析规则

### 8.1 可用模型池计算

```typescript
function getAvailableModels(
  models: ModelEntry[],
  services: LlmServiceProfile[],
  activeServiceIds: string[]
): ModelEntry[] {
  const activeSet = new Set(activeServiceIds)
  const supportedIds = new Set<string>()
  for (const s of services) {
    if (!activeSet.has(s.id)) continue
    for (const id of s.supportedModelIds) supportedIds.add(id)
  }
  return models.filter((m) => m.enabled && supportedIds.has(m.id))
}
```

### 8.2 服务凭证解析（同一模型多服务支持）

当请求使用模型 `M` 时，需要解析 `(serviceId, apiKey, baseUrl)`：

**已决策略（OQ-3）：**

1. 若调用方已指定 `serviceId`（如聊天区用户选择了带服务前缀的条目，见 §9），**直接使用该服务**凭证
2. 否则，在 `activeLlmServiceIds` 中按 **服务列表展示顺序** 遍历
3. 取第一个满足 `supportedModelIds` 包含 `M.id` 且已配置 Key 的服务
4. 若无匹配，返回明确错误：`当前无可用服务支持模型「{name}」`

### 8.3 三类优选模型的使用场景

| 场景 | 使用配置 | 说明 |
|------|----------|------|
| 主聊天（纯文本） | `preferredLanguageModelId` | 新会话默认模型、未指定模型时的会话模型 |
| Skill LLM 路由 | `preferredFastLanguageModelId` 优先 | 覆盖 `skills.routing.model` 为空时的默认值；若无可用快速模型则回退语言优选 |
| 会话标题生成 | `preferredFastLanguageModelId` 优先 | 与路由同类轻量任务 |
| 含图片附件的消息 | `preferredVisionModelId` | **本需求仅定义配置与解析**；实际上下文组装在后续需求实现 |
| 测试连接 | 见 §8.4 | |

> 会话级模型由 §9 聊天区选择器设置，存储 **serviceId + modelId**；未手动选择时，新会话默认使用语言优选（§7）解析出的绑定。

**飞书远程默认模型（OQ-7）：** `FeishuConfig.remoteDefaultModelId` 仍可在飞书设置中独立配置；当该字段为空或未匹配可用模型时，**回退到语言优选**（`preferredLanguageModelId` 解析结果），而非快速或视觉优选。

### 8.4 测试连接

| 项 | 规则 |
|----|------|
| 使用模型 | 该服务 `supportedModelIds` 与可用模型的交集内，优先 `preferredLanguageModelId`；否则交集首项 |
| 前置校验 | 服务至少勾选 1 个支持模型且已配置 Key |
| 凭证 | 始终使用 **被测服务** 的 Key + URL（不受多服务激活影响） |

### 8.5 兼容字段镜像

保留 `config.baseUrl` / `secrets.apiKeyEnc` 镜像，规则调整为：

- 镜像源 = `activeLlmServiceIds[0]` 对应服务（列表顺序第一项）
- 只读旧模块仍可工作；新模块调用 `resolveLlmCredentialsForModel(modelId, serviceId?)`

---

## 9. 聊天区模型选择器

### 9.1 背景

现网聊天区 **无** 模型选择 UI；会话模型来自配置默认项或历史数据。本需求 **新增** 入口，使用户可在对话中切换「用哪套服务的哪个模型」。

### 9.2 入口与交互

| 需求点 | 描述 |
|--------|------|
| 位置 | 聊天输入区或 composer 工具栏（与上下文环、发送按钮同一视觉层级；具体锚点实现时与现网布局对齐） |
| 触发 | **点击** 当前模型展示区域，弹出 **可选模型列表**（Popover / Dropdown，非设置页 Select） |
| 当前展示 | 显示当前会话生效的 **展示名**（见 §9.3）；未创建会话或未选定时显示语言优选对应展示名 |
| 选择效果 | 更新 **当前会话** 的模型绑定并持久化到 `session.model` + 新增 `session.llmServiceId`（见 §10.1） |
| 范围 | 列表项 = §8.1 **可用模型池** 展开为 **服务 × 模型** 条目（每个启用服务与其 `supportedModelIds` 的笛卡尔子集） |

### 9.3 展示名规则

对每个 `(service, model)` 候选生成 **展示名（displayName）**：

| 条件 | 展示名 |
|------|--------|
| 该 `model.name` 在可用池中 **仅出现 1 次**（只有一个服务支持） | `{model.name}`，例如 `deepseek-v4-pro` |
| 该 `model.name` 被 **≥2 个** 启用服务同时支持 | `{serviceName}-{model.name}`，例如 `Deep-deepseek-v4-pro`、`火山CodingPlan-deepseek-v4-pro` |

说明：

- 服务名取 `LlmServiceProfile.name`（trim 后）；与模型名之间固定使用 **单连字符 `-`** 连接
- 列表项副文案仍展示上下文 / 输出 tokens 及快速、视觉标签（复用 `ConfigModelOptionContent`）
- 排序：先按服务列表顺序，再按 §6.2 模型排序规则

### 9.4 会话存储

```typescript
/** Session 扩展（domainTypes.ts） */
interface Session {
  /** 模型 id（ModelEntry.id）；保留字段名 model 存 model name 时迁移见 §11 */
  model: string
  /** 新增：本次会话使用的 API 服务 id；缺省时按 §8.2 顺序解析 */
  llmServiceId?: string
}
```

| 场景 | 行为 |
|------|------|
| 用户从列表选中 `火山CodingPlan-deepseek-v4-pro` | 写入 `session.llmServiceId = 火山CodingPlan.id`，`session.model = deepseek-v4-pro`（model **name**，与现网一致） |
| 用户选中无歧义条目 `kimi-k2.6` | 写入对应唯一服务的 `llmServiceId` + model name |
| 新建会话 | 默认绑定 = 语言优选模型 + §8.2 解析出的 serviceId（无歧义时同 §8.2 第一条） |
| 发送消息 / 流式聊天 | 主进程使用 `session.llmServiceId`（若有）+ `session.model` 解析凭证，**不再**仅依赖全局 `activeLlmServiceIds[0]` |

### 9.5 空态与禁用

| 条件 | UI |
|------|-----|
| 可用池为空（无启用服务或未勾选支持模型） | 入口可点击但列表为空态；hint 引导用户前往设置 |
| 当前会话所选绑定已不可用 | 入口展示警告态；发送前尝试回退到语言优选或提示用户重选 |

---

## 10. 数据模型与存储

### 10.1 `LlmServiceProfile` 扩展

```typescript
export interface LlmServiceProfile {
  id: string
  name: string
  baseUrl: string
  apiKeyPresent: boolean
  /** 该服务支持的模型 id 列表（引用全局 ModelEntry.id） */
  supportedModelIds: string[]
  createdAt?: string
  updatedAt?: string
}
```

### 10.2 `AppConfig` 变更摘要

```typescript
export interface AppConfig {
  llmServices: LlmServiceProfile[]
  /** @deprecated 迁移自 activeLlmServiceId */
  activeLlmServiceId?: string
  activeLlmServiceIds: string[]

  /** @deprecated 迁移自 defaultModel / isDefault */
  defaultModel?: string
  preferredLanguageModelId: string
  preferredFastLanguageModelId: string
  preferredVisionModelId: string

  models: ModelEntry[]
  // ... 其余不变
}
```

### 10.3 持久化键

| 键 | 类型 | 说明 |
|----|------|------|
| `config.llmServices` | JSON | 服务数组，含 `supportedModelIds` |
| `config.activeLlmServiceIds` | JSON 字符串 | `string[]` |
| `config.preferredLanguageModelId` | string | 模型 id |
| `config.preferredFastLanguageModelId` | string | 模型 id |
| `config.preferredVisionModelId` | string | 模型 id |
| `config.activeLlmServiceId` | string | **保留只读**，迁移后不再写入 |
| `config.defaultModel` | string | **保留只读**，等于语言优选 model name |

---

## 11. 迁移与兼容

### 11.1 升级步骤（主进程启动或 config:get 时执行）

1. **`activeLlmServiceId` → `activeLlmServiceIds`**
   - 若新键不存在：设为 `[activeLlmServiceId]`；若旧键也不存在，取 `llmServices[0].id`

2. **服务 `supportedModelIds`**
   - 若某服务缺字段：设为当时全局 `models` 中所有 `enabled: true` 的 id（与现网「全模型可用」行为一致）

3. **`ModelEntry.isFast` / `isVision`**
   - 缺字段：按 §6.4 内置表 **独立** 补全；不得因其一为 true 而推断另一项；未知自定义模型默认均为 `false`

4. **默认模型三分**
   - `preferredLanguageModelId` ← 原 `isDefault: true` 条目 id，或 name 匹配 `config.defaultModel`，或 `deepseek-v4-pro`
   - `preferredFastLanguageModelId` ← name 为 `deepseek-v4-flash` 的 id（若存在）
   - `preferredVisionModelId` ← name 为 `kimi-k2.6` 的 id（若存在）

5. **`isDefault` 清理**
   - 全部置 `false`，后续不再使用

6. **会话 `llmServiceId`**
   - 旧会话无 `llmServiceId`：首次发送时按 §8.2 顺序解析；不批量改写历史会话

### 11.2 校验与副作用（config:set）

**校验：**

| 规则 | 错误提示 |
|------|----------|
| `activeLlmServiceIds.length >= 1` | 至少选择一个当前使用的服务 |
| 每个当前使用服务的 `supportedModelIds.length >= 1` | 服务「{name}」须至少支持一个模型 |
| `supportedModelIds` 仅含存在的 model id | 含无效模型引用 |
| 三个 preferred*ModelId 必须存在于 `models` | 无效的模型 id |
| 快速 / 视觉优选的 id 必须满足标签 | 所选模型不具备快速/视觉能力 |

**保存时自动 prune（已决 OQ-5）：**

- 当某模型 `enabled` 设为 `false`（或从列表删除自定义模型）时，**自动**从所有服务的 `supportedModelIds` 中移除对应 id
- 若移除导致某「当前使用」服务支持列表为空，**阻断保存**并提示用户为该服务重新勾选模型

---

## 12. 验收标准

### 12.1 API 服务

- [ ] 服务卡片可 multi-select 支持模型；选项与下方大模型列表名称、元信息、标签一致
- [ ] 「当前使用」可勾选多个服务；至少保留一个
- [ ] 新建服务默认勾选全部已启用模型
- [ ] 保存后重启应用，服务支持模型与激活列表持久化正确

### 12.2 大模型列表

- [ ] 列表展示启用开关、快速/视觉标签、元信息、自定义模型删除
- [ ] 添加模型 Popover 可同时勾选快速与视觉；恢复默认后 §6.4 标签组合正确（含 `claude-haiku-4-5`、`gemini-3.1-flash-lite` **双标签**）
- [ ] `ConfigModelOption` 在下拉、列表、服务选择器、聊天列表中均支持 **快速+视觉并列** 展示
- [ ] DeepSeek V4 Pro / Flash：**Pro 无标签**；Flash **仅快速、无视觉**
- [ ] 禁用模型后保存，各服务 `supportedModelIds` 自动移除该 id

### 12.3 三类优选默认模型

- [ ] 三个独立下拉框；快速下拉仅含 `isFast` 可用模型；视觉下拉仅含 `isVision` 可用模型
- [ ] 恢复默认后：语言 → deepseek-v4-pro，快速 → deepseek-v4-flash，视觉 → kimi-k2.6
- [ ] 取消某模型所有服务支持后，UI 显示不可用 hint，运行时按 §7.3 回退

### 12.4 运行时

- [ ] 主聊天使用语言优选（在无会话 override 时）
- [ ] Skill 路由 / 标题生成使用快速优选（可回退）
- [ ] 对同一模型，凭证来自 §8.2 解析的第一个匹配服务
- [ ] 测试连接使用本服务支持模型交集内的优选语言模型

- [ ] 用户从聊天区显式选择带服务前缀的条目时，凭证来自所选 `llmServiceId`（不依赖 §8.2 顺序）

### 12.5 聊天区模型选择器

- [ ] 聊天区有点击入口，弹出可选模型列表（现网原先无此控件）
- [ ] 列表 = 所有「当前使用」服务 × 其支持模型的并集展开
- [ ] 同模型仅一个服务支持时展示 `model.name`；多服务支持时展示 `{serviceName}-{model.name}`
- [ ] 选择后写入 `session.llmServiceId` + `session.model`；新建会话默认语言优选

### 12.6 飞书

- [ ] `remoteDefaultModelId` 未配置或无效时，回退语言优选

### 12.7 迁移

- [ ] 旧数据库升级后：原激活服务仍在激活列表；supportedModelIds 为全启用模型；原 defaultModel 映射到语言优选

---

## 13. 已决事项（原 OQ）

| ID | 问题 | 决定 |
|----|------|------|
| **OQ-1** | 优选视觉默认模型名 | **沿用 `kimi-k2.6`**，不改为 2.7 |
| **OQ-2** | DeepSeek V4 Pro / Flash 是否支持图片 | **不支持**；`isVision: false` |
| **OQ-3** | 同模型多服务时的凭证策略 | 未指定服务时按 **服务列表顺序取第一个**；聊天区显式选择时 **用所选服务** |
| **OQ-4** | 列表行内能否改标签 | **否**；仅在「添加模型」Popover 设置，列表只读展示 |
| **OQ-5** | 禁用模型是否自动从服务支持列表移除 | **是**；保存时 prune（§11.2） |
| **OQ-6** | 聊天区模型选择 | **新增**点击弹出列表；可选 = 启用服务支持的全部模型；多服务同模型时 **`{serviceName}-{model.name}`** 前缀（§9） |
| **OQ-7** | 飞书远程默认模型 | 可独立配置；**缺省时回退语言优选** |

---

## 14. 相关文件

| 文件 | 变更类型 |
|------|----------|
| `src/shared/domainTypes.ts` | `ModelEntry.isVision`、`Session.llmServiceId`、`LlmServiceProfile.supportedModelIds`、`AppConfig` 新字段 |
| `res/resource/modes.md` | 增加 `is_vision_model` 列（DeepSeek 为 0） |
| `src/renderer/components/Config/ModelsSettingsTab.tsx` | 三区 UI：服务 / 优选 / 列表 |
| `src/renderer/components/Config/LlmServiceCard.tsx` | Checkbox、支持模型多选 |
| `src/renderer/components/Config/llmServiceDrafts.ts` | 多激活 id、supportedModelIds 草稿 |
| `src/renderer/components/Config/ConfigModelOption.tsx` | 视觉标签、排序 |
| `src/renderer/components/Chat/` | **新增**模型选择入口与 Popover 列表（如 `ComposerModelPicker`） |
| `electron/llmServiceResolver.ts` | 多服务、按 model + 可选 serviceId 解析凭证 |
| `electron/appIpc.ts` | config:get/set、迁移、聊天 IPC 传 serviceId |
| `electron/feishu/feishuSessionResolver.ts` | 远程默认缺省回退语言优选 |
| `src/renderer/i18n/resources/*/config.json` | 新文案 |
| `src/renderer/i18n/resources/*/chat.json` | 模型选择器文案 |
| `electron/skills/skillRouter.ts` | 快速模型默认解析 |
| `electron/sessionTitleSuggest.ts` | 快速模型默认解析 |

---

*文档结束*
