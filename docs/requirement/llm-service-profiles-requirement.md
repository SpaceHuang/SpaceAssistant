# 多套大模型服务与设置页重构 — 需求规格

**版本：** 1.1  
**日期：** 2026-05-24  
**状态：** 待评审  
**关联文档：** [settings-requirement.md](./settings-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-05-24 | 初稿 |
| 1.1 | 2026-05-24 | 优化「大模型服务」Tab 为一站式服务卡片布局 |

---

## 目录

1. [概述](#1-概述)
2. [现状分析](#2-现状分析)
3. [设置界面重构](#3-设置界面重构)
4. [多套大模型服务](#4-多套大模型服务)
5. [数据模型与存储](#5-数据模型与存储)
6. [迁移策略](#6-迁移策略)
7. [API / IPC 变更](#7-api--ipc-变更)
8. [运行时行为](#8-运行时行为)
9. [验收标准](#9-验收标准)
10. [相关文件](#10-相关文件)

---

## 1. 概述

### 1.1 背景

当前设置中的「大模型」页仅支持配置 **一套** API Key 与 Base URL。实际使用中，用户可能同时订阅多套 Coding Plan（或同时使用官方 API、第三方代理等多条线路），需要在不同服务之间快速切换，而无需反复修改 Key 与地址。

同时，「大模型」Tab 内容过多（服务凭证、模型列表、生成参数等堆叠在同一页），影响可读性与操作效率。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 支持配置 **多套** 大模型服务（每套包含名称、API Key、Base URL） |
| G2 | 用户可在设置中 **随时切换当前生效的大模型服务** |
| G3 | 将原「大模型」Tab 拆分为 **「大模型服务」** 与 **「默认大模型设置」** 两个 Tab |
| G4 | 「测试连接」仅出现在大模型服务页，用于验证 **当前编辑/选中的服务** 配置是否正确 |
| G5 | 平滑迁移现有单套配置，升级后行为与现网一致 |

### 1.3 非目标

- 不为每套服务维护 **独立的模型列表**（模型列表仍为全局默认配置，见 §4.4）
- 不支持会话级绑定不同服务（所有会话共用「当前激活服务」）
- 不支持服务配置的导入/导出
- 不在聊天界面提供快捷切换服务的入口（首版仅在设置中切换）

---

## 2. 现状分析

### 2.1 设置界面（`ConfigModal.tsx`）

| 项目 | 现状 |
|------|------|
| Tab 结构 | 通用 / **大模型** / 工具 / Skill |
| 大模型 Tab 内容 | API Key、Base URL、模型列表、Temperature、最大输出 tokens、默认开启 Thinking |
| 底部操作栏 | 取消 / **测试连接** / 保存（测试连接对所有 Tab 可见） |

### 2.2 配置存储（`electron/appIpc.ts`）

| 键 | 说明 |
|----|------|
| `secrets.apiKeyEnc` | 唯一 API Key，经 `safeStorage` 加密 |
| `config.baseUrl` | 唯一 Base URL |
| `config.models` | 全局模型列表 JSON |
| `config.temperature` 等 | 全局生成参数 |

### 2.3 调用链

聊天、工具循环、Plan 模式、会话标题建议等模块均通过 `getApiKey()` + `config.baseUrl` 创建 Anthropic 客户端。改造后需统一从 **当前激活的大模型服务** 读取凭证。

---

## 3. 设置界面重构

### 3.1 Tab 结构（改造后）

设置 Modal 宽度仍为 560px。原「大模型」Tab 拆为两个 Tab，整体 Tab 顺序如下：

| Tab key | 名称 | 包含内容 |
|---------|------|----------|
| `general` | 通用 | 工作目录、界面主题、默认聊天模式、并行会话上限（与现网一致） |
| `llm-service` | **大模型服务** | 服务列表、新增/编辑/删除、切换激活服务、**测试连接** |
| `llm-defaults` | **默认大模型设置** | 模型列表（含恢复默认、添加模型）、Temperature、最大输出 tokens（兜底）、默认开启 Thinking |
| `tools` | 工具 | 与现网一致 |
| `skills` | Skill | 与现网一致 |

### 3.2 「大模型服务」Tab 布局

#### 3.2.1 设计原则

| 原则 | 说明 |
|------|------|
| **一体式卡片** | 每套服务的名称、API Key、Base URL、测试连接放在 **同一张卡片** 内，避免「列表 + 独立编辑区」造成的映射断裂 |
| **一卡一状态** | 每张卡片维护各自的表单草稿（按 `serviceId` 索引）；切换「当前使用」或展开其他卡片时，**不丢失** 已在其他卡片中输入但未保存的内容 |
| **当前使用可识别** | 激活卡片带高亮边框与「当前使用」标记；切换 Radio 后自动展开目标卡片并滚入视口 |
| **折叠降噪** | 非激活且未在编辑的卡片默认 **收起**，仅展示摘要；需要对比或修改时再展开 |

Tab 顶部说明文案（`extra`）：「每套服务包含独立的 API Key 与 Base URL。勾选「当前使用」的服务将用于所有聊天请求。」

#### 3.2.2 整体结构

```
┌──────────────────────────────────────────────────────────┐
│ 每套服务包含独立的 API Key 与 Base URL。勾选「当前使用」…  │
│                                                          │
│ ┌─ 服务卡片 A（当前使用 · 展开）───────────────────────┐ │
│ │ (●) 当前使用   [Cursor Coding Plan A________]  [删除] │ │
│ │ ─────────────────────────────────────────────────────  │ │
│ │ API Key（留空则不修改）                                │ │
│ │ [••••••••••••••••••••••••••••••••••••••••••••••••]   │ │
│ │ 已配置 Key · 输入新值将覆盖                            │ │  ← apiKeyPresent 时
│ │ Base URL（可选，留空为 Anthropic 官方）                │ │
│ │ [https://api.example.com/anthropic________________]   │ │
│ │                                      [测试连接]       │ │
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─ 服务卡片 B（收起）──────────────────────────────────┐ │
│ │ ( ) 当前使用   Anthropic 官方              [∨] [删除] │ │
│ │ 官方默认 · Key 已配置                                  │ │  ← 摘要行
│ └──────────────────────────────────────────────────────┘ │
│                                                          │
│ [+ 添加服务]                                             │
└──────────────────────────────────────────────────────────┘
         ↑ 卡片列表区域 max-height ~360px，超出可滚动
```

#### 3.2.3 服务卡片规格

每张卡片分为 **标题行** 与 **详情区**（可展开/收起）。

**标题行（始终可见）：**

| 元素 | 规格 |
|------|------|
| 当前使用 Radio | 单选；选中即切换 `activeLlmServiceId`（保存前仅 UI 态） |
| 服务名称 | 展开时为 Input；收起时显示为纯文本标题 |
| 展开/收起 | 右侧 chevron 按钮；激活卡片默认展开且不可收起（避免找不到 Key） |
| 删除 | 图标按钮；唯一一套服务时禁用并 tooltip「至少保留一套服务」 |

**详情区（展开时可见，字段均属于本卡片）：**

| 字段 | 控件 | 说明 |
|------|------|------|
| API Key | `Input.Password` | 占位 `sk-ant-...`；留空不修改已存 Key |
| Key 状态提示 | 辅助文案 | `apiKeyPresent` 为 true 时显示「已配置 Key · 输入新值将覆盖」；否则「尚未配置 Key」 |
| Base URL | Input | 占位「默认 Anthropic 官方」 |
| 测试连接 | Button | 仅测试 **本卡片** 的 Key + Base URL（见 §4.3） |

**卡片视觉：**

| 状态 | 样式 |
|------|------|
| 当前使用 + 展开 | 主题色左边框（2px）+ 浅蓝背景（`#f0f7ff` 或主题 token） |
| 非当前使用 + 收起 | 默认边框；摘要行 12px 灰色 secondary 文本 |
| 新建未保存 | 虚线边框 + 名称占位「新服务」 |

#### 3.2.4 展开 / 收起规则

| 触发 | 行为 |
|------|------|
| 打开设置弹窗 | **当前使用** 的卡片展开；其余收起 |
| 切换「当前使用」Radio | 新卡片 **自动展开**；原激活卡片 **自动收起**（若用户正在其他卡片内编辑，该卡片保持展开） |
| 点击 chevron | 切换本卡片展开/收起；**当前使用** 的卡片不允许收起 |
| 点击「+ 添加服务」 | 底部插入新卡片并展开；不自动设为当前使用 |

> **并行编辑：** 用户可同时展开多张卡片（例如对比两套 Base URL）。仅「当前使用」Radio 决定哪套服务生效；展开状态互不排斥。

#### 3.2.5 摘要行（收起态）

收起时在标题行下方显示一行摘要（单行 ellipsis）：

| 条件 | 摘要格式 |
|------|----------|
| 有 Base URL | `{baseUrl}` · Key 已配置 / 未配置 Key |
| 无 Base URL | 官方默认 · Key 已配置 / 未配置 Key |

#### 3.2.6 列表滚动

- 卡片列表容器 `max-height: 360px`，`overflow-y: auto`
- 切换「当前使用」或添加服务后，目标卡片 `scrollIntoView({ block: 'nearest' })`

### 3.3 「默认大模型设置」Tab 布局

自原「大模型」Tab **移入** 以下内容（交互与 [settings-requirement.md §3.3–§3.5](./settings-requirement.md) 保持一致）：

| 区块 | 内容 |
|------|------|
| 模型列表标题行 | 左侧「模型列表」；右侧 **恢复默认**、**添加模型** 按钮 |
| 模型列表 | `ModelList` 组件，行为不变 |
| Temperature | InputNumber，0 ~ 2，步长 0.1 |
| 最大输出 tokens（兜底） | InputNumber；说明文案不变 |
| 默认开启 Thinking | Switch |

**不包含** API Key、Base URL、测试连接。

### 3.4 底部操作栏（改造后）

| 按钮 | 行为 |
|------|------|
| 取消 | 关闭设置弹窗，不保存 |
| 保存 | 校验所有 Tab 字段后保存配置 |

**移除** 底部全局「测试连接」按钮。测试连接仅存在于「大模型服务」Tab 内（见 §4.3）。

### 3.5 保存与校验

- 点击「保存」时 **一次性提交** 所有卡片的草稿 + 默认大模型设置（与现网整页保存模式一致）
- 每张卡片的 `name`、`baseUrl`、可选 `apiKey` 随 `llmServices` / `llmServiceKeys` 一并提交
- 至少需存在 **一套** 大模型服务，且必须有一套处于 **激活** 状态
- 「默认大模型设置」Tab：至少启用一个模型（与现网校验一致）
- 新建卡片（临时 id）保存时必须有 API Key；已有卡片 API Key 留空表示 **不修改**
- 关闭弹窗或切换 Tab 不单独弹确认；未保存修改在再次打开设置时 **丢弃**（与现网一致）

---

## 4. 多套大模型服务

### 4.1 概念定义

**大模型服务（LlmServiceProfile）**：一组可独立使用的 API 接入配置，包含用户可读名称、API Key、Base URL。应用任意时刻仅有 **一个激活服务**，所有 LLM 请求使用该服务的凭证。

典型用例：

| 服务名称（用户自定义） | Base URL 示例 | 说明 |
|------------------------|---------------|------|
| Cursor Coding Plan A | `https://api.example.com/anthropic` | 订阅套餐 A |
| Cursor Coding Plan B | `https://api.other.com/v1` | 订阅套餐 B |
| Anthropic 官方 | （留空） | 直连官方 |

### 4.2 服务数据结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | UUID，唯一标识 |
| `name` | string | 显示名称，同一用户配置内不可重复，1~32 字符 |
| `baseUrl` | string | Base URL，可为空（表示官方默认地址） |
| `apiKeyPresent` | boolean | 是否已配置 Key（读取配置时返回，不含明文） |
| `createdAt` | string | ISO 8601，可选，便于排序 |
| `updatedAt` | string | ISO 8601，可选 |

API Key **明文不落库到 JSON 配置**，仍使用 `safeStorage` 加密存储（见 §5.2）。

### 4.3 服务管理交互

| 操作 | 行为 |
|------|------|
| 添加服务 | 点击「+ 添加服务」，列表底部追加 **展开的新卡片**（临时 id）；名称默认空，需用户填写 |
| 编辑名称 / Key / URL | 在 **对应卡片详情区** 内直接修改；无需单独的「编辑」按钮 |
| 删除服务 | 卡片标题行删除按钮，Modal 二次确认；若删的是激活项，**列表第一项** 自动设为当前使用并展开 |
| 切换当前使用 | 点击卡片 Radio；目标卡片自动展开并滚入视口；持久化在「保存」时生效 |
| 测试连接 | 点击 **该卡片内** 的「测试连接」，使用本卡片当前的 Key（留空则用已存 Key）+ Base URL |

**测试连接按钮位置与范围：**

- 位于 **每张服务卡片详情区** 右下角（展开态可见）
- **不在** Modal 底部 footer 出现
- **不在**「默认大模型设置」「通用」「工具」「Skill」等 Tab 出现
- 各卡片的测试连接 **互不干扰**，只验证本卡片配置

测试连接 loading 态、成功/失败 Toast 文案与现网一致（「连接成功」/ 错误信息）。

#### 4.3.1 前端状态结构（建议）

```typescript
/** 按 serviceId 索引的卡片草稿，打开设置弹窗时从 cfg 初始化 */
type LlmServiceDraft = {
  id: string
  name: string
  baseUrl: string
  apiKeyDraft: string       // 仅内存，不落库；空串表示不修改已存 Key
  apiKeyPresent: boolean    // 来自服务端，只读
  expanded: boolean
}

type LlmServiceTabState = {
  drafts: Record<string, LlmServiceDraft>
  activeId: string
  order: string[]           // 卡片展示顺序
}
```

- 切换 Radio / 展开收起 **只改 UI 态**，不重置其他卡片的 `apiKeyDraft`
- 保存成功后重新 `configGet` 并重建 drafts，清空所有 `apiKeyDraft`

### 4.4 服务与模型列表的关系

| 维度 | 策略 |
|------|------|
| 模型列表 | **全局唯一**，存放在「默认大模型设置」，所有服务共用 |
| 切换服务 | 仅切换 API Key + Base URL；模型名称、Temperature 等不变 |
| 测试连接所用模型 | 全局模型列表中第一个 `enabled: true` 的模型；若无则提示「请先在默认大模型设置中启用至少一个模型」 |

**设计理由：** 多套 Coding Plan 通常代理同一套 Anthropic 兼容模型名；将模型列表与服务解耦可避免重复维护，且符合用户将模型列表归入「默认大模型设置」的划分。

### 4.5 限制

| 项目 | 限制 |
|------|------|
| 服务数量上限 | 10 套（可配置常量，首版硬编码） |
| 服务名称 | 必填，trim 后非空，不可与同列表其他服务重名 |
| Base URL | 校验规则与现网 `assertValidOptionalAnthropicBaseUrl` 一致 |
| API Key | 新建服务时必填；编辑时留空表示不修改 |

---

## 5. 数据模型与存储

### 5.1 AppConfig 变更（`domainTypes.ts`）

```typescript
export interface LlmServiceProfile {
  id: string
  name: string
  baseUrl: string
  apiKeyPresent: boolean
  createdAt?: string
  updatedAt?: string
}

export interface AppConfig {
  /** @deprecated 兼容字段，等于激活服务的 baseUrl；新代码请读 llmServices */
  baseUrl: string
  /** @deprecated 兼容字段，等于激活服务是否已配置 Key */
  apiKeyPresent: boolean

  /** 大模型服务列表 */
  llmServices: LlmServiceProfile[]
  /** 当前激活服务 id */
  activeLlmServiceId: string

  model: string
  defaultModel: string
  models: ModelEntry[]
  temperature: number
  maxTokens: number
  thinkingEnabled: boolean
  // ... 其余字段不变
}
```

### 5.2 持久化键（`spaceassistant-data.json`）

| 键 | 类型 | 说明 |
|----|------|------|
| `config.llmServices` | JSON 字符串 | 服务列表（**不含** API Key 明文） |
| `config.activeLlmServiceId` | string | 激活服务 id |
| `secrets.llmServiceKeys` | JSON 字符串 | `{ [serviceId: string]: base64EncryptedKey }` |
| `config.baseUrl` | string | **保留**，写入时同步为激活服务的 baseUrl（向后兼容） |
| `secrets.apiKeyEnc` | string | **保留**，写入时同步为激活服务的 Key（向后兼容） |

加密方式与现网 `electron/secureApiKey.ts` 相同（Electron `safeStorage`）。

### 5.3 读写规则

**读取（config:get）：**

1. 解析 `llmServices` + `activeLlmServiceId`
2. 对每个 service.id 查 `secrets.llmServiceKeys[id]` 是否存在，填充 `apiKeyPresent`
3. 将激活服务的 `baseUrl` / `apiKeyPresent` 同步到顶层 `baseUrl` / `apiKeyPresent`（兼容旧 UI/逻辑）

**写入（config:set）：**

1. 更新 `llmServices`、`activeLlmServiceId`
2. 若 payload 携带某服务的 `apiKey` 且非空，更新 `secrets.llmServiceKeys[id]`
3. 将激活服务的凭证 **镜像** 到 `secrets.apiKeyEnc` 与 `config.baseUrl`
4. 默认大模型字段（models、temperature 等）逻辑不变

---

## 6. 迁移策略

应用启动或首次 `config:get` 时执行一次性迁移：

```
若 config.llmServices 不存在或为空：
  1. 读取 secrets.apiKeyEnc、config.baseUrl
  2. 创建默认服务：
     id = 新 UUID
     name = "默认服务"
     baseUrl = 现有 config.baseUrl
     apiKey = 现有 secrets.apiKeyEnc（若存在）
  3. 写入 config.llmServices、[id]
  4. 设置 activeLlmServiceId = id
  5. 写入 secrets.llmServiceKeys[id] = apiKeyEnc（若存在）
```

迁移后用户无感知，可在设置中重命名或继续添加新服务。

**回滚安全：** 保留 `secrets.apiKeyEnc` 与 `config.baseUrl` 镜像，旧版本若读取仍可获得激活服务凭证。

---

## 7. API / IPC 变更

### 7.1 `config:get`

返回字段增加 `llmServices`、`activeLlmServiceId`（见 §5.1）。

### 7.2 `config:set`

`payload` 增加：

```typescript
{
  llmServices?: LlmServiceProfile[]  // 不含 apiKey 明文
  activeLlmServiceId?: string
  /** 按服务 id 更新 Key；仅当用户输入新 Key 时携带 */
  llmServiceKeys?: { [serviceId: string]: string }
}
```

保留现有 `apiKey`、`baseUrl` 字段的写入能力（内部转为更新激活服务），避免一次改动所有调用方。

### 7.3 `config:test-connection`

增加可选参数，用于测试 **指定服务** 而非仅激活项：

```typescript
configTestConnection(options?: {
  serviceId?: string      // 默认 activeLlmServiceId
  apiKey?: string         // 编辑区临时 Key；留空则用已存储 Key
  baseUrl?: string        // 编辑区 Base URL
}): Promise<{ success: boolean; error?: string }>
```

渲染进程在某张卡片点击「测试连接」时，传入 **该卡片** 的 `serviceId`、`baseUrl`，以及卡片内 `apiKeyDraft`（若非空）。

### 7.4 内部凭证解析

新增 helper（建议 `electron/llmServiceResolver.ts`）：

```typescript
getActiveLlmService(db): { id, name, baseUrl, getApiKey(): Promise<string | null> }
```

`toolChatLoop`、`claudeStreamHandlers`、`planOrchestrator`、`sessionTitleSuggest` 等统一通过该 helper 获取凭证，避免散落读取旧键。

---

## 8. 运行时行为

### 8.1 聊天与工具

| 场景 | 行为 |
|------|------|
| 发送消息 | 使用 **保存后的** 激活服务凭证 |
| 切换服务后未保存 | 聊天仍使用 **上一次保存** 的激活服务 |
| 保存并切换服务 | 后续新请求使用新服务；进行中的流式请求不中断 |
| 无 API Key | 与现网一致，发送前提示「请先配置 API Key」 |

### 8.2 设置弹窗打开时

- 从 `configGet` 加载 `llmServices` 与 `activeLlmServiceId`
- 为每个服务创建卡片草稿；**所有 API Key 输入框初始为空**（占位提示「留空则不修改」）
- **当前使用** 的卡片 `expanded: true`，其余 `expanded: false`
- 卡片顺序与持久化 `llmServices` 数组顺序一致

### 8.3 ChatView 前置校验

现有 `cfg.apiKeyPresent` 检查保持不变（顶层字段由激活服务同步）。

---

## 9. 验收标准

### 9.1 设置页结构

- [ ] 设置中存在「大模型服务」「默认大模型设置」两个 Tab，原「大模型」Tab 已移除
- [ ] 模型列表、恢复默认、添加模型仅出现在「默认大模型设置」
- [ ] Temperature、最大输出 tokens、默认开启 Thinking 仅出现在「默认大模型设置」
- [ ] Modal 底部 **无** 测试连接按钮
- [ ] 每套服务的 API Key、Base URL、测试连接位于 **同一张服务卡片** 内
- [ ] 不存在独立的「服务列表 + 底部编辑区」分栏布局

### 9.2 多套服务

- [ ] 可添加至少 2 套服务，每套在独立卡片中配置名称、Key、Base URL
- [ ] 切换「当前使用」Radio 后，目标卡片自动展开，Key/URL 字段即对应该服务
- [ ] 在卡片 A 输入 Key 后切换到卡片 B 再切回，卡片 A 的未保存输入 **仍在**
- [ ] 保存并切换当前使用后，后续聊天请求走新服务
- [ ] 可展开多张卡片并行查看；收起态摘要正确显示 Base URL 与 Key 状态
- [ ] 可删除非唯一服务；删除激活项后第一项自动成为当前使用并展开
- [ ] 服务名称重复时保存失败并提示
- [ ] 达到 10 套上限时禁止继续添加并提示

### 9.3 测试连接

- [ ] 每张展开卡片的详情区内有独立「测试连接」按钮
- [ ] 测试仅使用 **该卡片** 的 Key + Base URL，不影响其他卡片
- [ ] 新建未保存卡片可用临时 Key + Base URL 测试（不写库）
- [ ] 其他 Tab 不出现测试连接入口

### 9.4 迁移与兼容

- [ ] 从旧版单 Key 配置升级后，自动生成「默认服务」且行为与升级前一致
- [ ] `config.baseUrl`、`apiKeyPresent` 顶层字段与激活服务保持同步

### 9.5 安全

- [ ] API Key 不以明文写入 `spaceassistant-data.json`
- [ ] 日志与 agentLogger sanitize 对新 Key 字段同样脱敏

---

## 10. 相关文件

| 文件 | 改动类型 |
|------|----------|
| `src/shared/domainTypes.ts` | 新增 `LlmServiceProfile`，扩展 `AppConfig` |
| `src/shared/api.ts` | 扩展 config IPC 类型 |
| `electron/appIpc.ts` | 迁移、读写、test-connection 参数化 |
| `electron/secureApiKey.ts` 或新建 `llmServiceResolver.ts` | 多 Key 存取 |
| `electron/preload.ts` | 暴露更新后的 IPC |
| `src/renderer/components/Config/ConfigModal.tsx` | Tab 拆分、服务卡片 UI |
| `src/renderer/components/Config/LlmServiceCard.tsx` | 新建：单张服务卡片组件 |
| `src/renderer/components/Config/useLlmServiceDrafts.ts` | 新建：卡片草稿状态 hook |
| `electron/toolChatLoop.ts` | 使用激活服务凭证 |
| `electron/claudeStreamHandlers.ts` | 同上 |
| `electron/plan/planOrchestrator.ts` | 同上 |
| `electron/sessionTitleSuggest.ts` | 同上 |
| `docs/requirement/settings-requirement.md` | 更新 Tab 结构说明（引用本文档） |

---

**文档版本**: v1.1  
**创建日期**: 2026-05-24  
**更新日期**: 2026-05-24 — 大模型服务 Tab 改为一站式卡片布局  
**适用范围**: SpaceAssistant 大模型服务配置与设置界面
