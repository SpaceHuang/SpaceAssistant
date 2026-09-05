# LLM 服务模型列表动态拉取 — 需求规格

**版本：** 1.4
**日期：** 2026-09-05
**状态：** 已实现（v1.2）
**关联文档：** [skills-requirement.md](./skills-requirement.md)（无直接耦合，仅同级参考）

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-09-05 | 初稿：支持从 LLM 服务（供应商）API 动态拉取其支持的模型列表，替代完全依赖用户手工维护 |
| 1.1 | 2026-09-05 | 新增服务级拉取结论缓存（`fetchedModelIds/fetchedAt`）与失效模型检测（§6.1-6.3）；补入 Kimi / 火山方舟实测验证记录与错误解析硬约束（§5.1、§5.5） |
| 1.2 | 2026-09-05 | 已按本文档实现（TDD）。实现偏差说明：§6.4 中 `name` 恒取 API 返回的 id（不采用 `display_name`）——目录去重与服务勾选均以 `name` 为匹配键，用展示名会导致重复拉取产生重复模型；`displayName` 仅随拉取结果透传，暂不入库 |
| 1.3 | 2026-09-05 | 拉取应用语义由并集改为**替换**（应用前自动清空当前勾选，§6.4、§6.2 同步修订）；空结果视为不确定，不动勾选与缓存；`config:test-connection` 支持传入草稿模型目录（拉取后未保存也能测新模型） |
| 1.4 | 2026-09-05 | 依代码评审（docs/review/llm-service-model-fetch-code-review-v1.md）修订：§5.4 改为分页拉全（`has_more`+`after_id`，上限 10 页/1000 条），不完整结果降级为「只合并不替换、不做失效判定」（§6.4）；baseUrl 变更即作废拉取缓存（§6.1）；迁移重命名冲突跳过（§6.3）；错误分类新增 `invalid-base-url`，错误联合类型在 `src/shared/llmModelConfig.ts` 单点定义 |

---

## 目录

1. [概述](#1-概述)
2. [现状与问题](#2-现状与问题)
3. [目标与非目标](#3-目标与非目标)
4. [设计原则](#4-设计原则)
5. [拉取协议与兼容性策略](#5-拉取协议与兼容性策略)
6. [数据模型变更](#6-数据模型变更)
7. [IPC 与模块边界](#7-ipc-与模块边界)
8. [用户交互流程](#8-用户交互流程)
9. [失败与降级行为](#9-失败与降级行为)
10. [非功能需求](#10-非功能需求)
11. [迁移与兼容](#11-迁移与兼容)
12. [验收标准](#12-验收标准)
13. [待解决问题](#13-待解决问题)
14. [相关文件](#14-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 的大模型设置中，模型目录（`AppConfig.models`）是全局共享的：每个 LLM 服务（`LlmServiceProfile`，即「供应商」= name + baseUrl + API Key）只通过 `supportedModelIds` 引用全局目录中的模型。内置默认列表 `DEFAULT_MODELS`（`src/shared/domainTypes.ts`）对所有服务一视同仁，用户新增模型完全靠手填。

事实上不同供应商支持的模型差异很大，当前「哪些模型真正可用」全靠用户自觉维护，容易出现：

- 新用户面对 12 个内置模型不知道该给当前供应商勾选哪几个；
- 供应商上线新模型后用户无从得知；
- 勾选了供应商不支持的模型，运行时才以 API 报错形式暴露。

### 1.2 本需求范围

| 在范围内 | 不在范围内 |
|----------|------------|
| 从服务的模型列表 API 动态拉取该服务支持的模型 id | 修改 LLM 调用协议（仍统一走 Anthropic SDK） |
| 拉取结果合并进全局模型目录并自动勾选到该服务 | 模型上下文/输出上限等参数的精确探测（API 拿不到，用默认值兜底） |
| 失败时的降级与用户可见提示 | 定时自动刷新、模型下线自动清理（见待解决问题） |
| 兼容 Anthropic 官方与主流 Anthropic 兼容网关 | 供应商类型识别 / 预设供应商模板（可作为后续迭代） |

## 2. 现状与问题

- `ModelEntry`（`src/shared/domainTypes.ts`）为全局模型目录，字段：`id / name / maximumContext / maxTokens / isFast / isVision / enabled`。
- `LlmServiceProfile`：`id / name / baseUrl / apiKeyPresent / supportedModelIds[]`，无协议类型字段。
- 服务卡片中「支持模型」为 antd `Select mode="multiple"`，候选来自全局 `enabled` 模型（`LlmServiceCard.tsx`）；「重置」按钮仅重置回 `DEFAULT_MODELS`，不联网。
- 主进程无任何拉取模型列表的代码；`config:test-connection` 仅发一条 `messages.create` ping。
- 主进程全部 LLM 调用经 `createAnthropicClient(apiKey, baseURL)` 走 Anthropic 协议。

## 3. 目标与非目标

**目标：**

1. 用户在服务卡片上可一键从该服务拉取其支持的模型列表。
2. 拉取到的模型自动合并进全局模型目录（已存在的 id 不重复创建），并勾选进该服务的 `supportedModelIds`。
3. 拉取失败不破坏现有手填流程，错误原因对用户可见、可理解。
4. 对 Anthropic 官方 API 与主流 Anthropic 兼容网关（new-api、litellm 等）均可工作。

**非目标：**

- 不引入供应商枚举/模板体系；
- 不改动模型目录全局共享的基本架构；
- 不保证所有自建网关都能拉取成功（尽力而为 + 兜底）。

## 4. 设计原则

- **尽力而为、静默兜底**：模型列表拉取是便利性增强，不是可靠功能基线。任何一步失败都回退到现有手填/默认列表，不阻塞配置保存。
- **最小侵入**：不改 `ModelEntry` 结构，不改全局目录架构，只增加「拉取 → 合并 → 勾选」的一条通路。
- **宽容解析**：第三方网关返回字段常不符合官方 schema，只依赖 `id` 字段，其余一律忽略或兜底。
- **不加协议字段**：服务配置维持「无类型」。Anthropic 风格与 OpenAI 风格端点采用试探式请求（见 §5），避免给用户增加理解成本。

## 5. 拉取协议与兼容性策略

### 5.1 端点

对服务的 `baseUrl` 依次尝试（任一成功即停止）：

1. `GET {baseUrl}/v1/models`（若 baseUrl 已以 `/v1` 结尾则直接 `{baseUrl}/models`）
2. 响应按两种格式宽容解析：
   - Anthropic 风格：`{ data: [{ id, ... }], has_more, ... }`
   - OpenAI 风格：`{ data: [{ id, object: "model", ... }] }`
   - 二者 `data[].id` 结构一致，解析逻辑可统一：取 `data` 数组中各元素的 `id` 字符串。
3. baseUrl 归一化：去除尾斜杠；已含 `/v1` 结尾则直接拼 `/models`，否则补 `/v1/models`（实测 Kimi 不带 `/v1` 返回 404，此规则为硬约束）。
4. **错误解析仅依赖 HTTP 状态码**（401/403 → unauthorized，404 → not-found，超时/连接失败 → timeout/network，2xx 但结构不符 → invalid-response）。错误响应体 schema 各厂商不一致（见 §5.5 实测），**禁止严格反序列化错误体**，至多提取 `message` 类字段做展示。

### 5.2 认证头

同时携带两种认证头，兼容只认其一的网关：

- `x-api-key: <key>`
- `Authorization: Bearer <key>`
- `anthropic-version: 2023-06-01`

已知背景：Anthropic 官方标准为 `x-api-key`（无 Bearer），但部分网关（如 new-api 旧版本）只认 Bearer；多带一个头对官方 API 无副作用。

### 5.3 兼容范围说明

- Anthropic 官方：完整支持，返回 `data[].id / display_name / created_at`。
- Anthropic 兼容网关：因 Claude Code 依赖该端点做模型发现（`x-api-key` + `GET /v1/models`），主流网关大多已实现，但存在只认 Bearer、字段不符 schema 等变体 → 由 §5.2 与宽容解析覆盖。
- 纯 OpenAI 兼容服务（baseUrl 指向 OpenAI 风格网关）：`GET /models` + Bearer 通常可用，同一请求路径即可覆盖。
- 完全不实现模型列表端点的服务：返回 404/401 → 走 §9 降级。

### 5.4 超时与限制

- 请求超时 10s，不可重试（用户可再点一次）。
- 按 Anthropic 分页协议翻页拉全：每页 `limit=100`，`has_more=true` 时以 `after_id=last_id` 翻页，最多 10 页；总量上限 1000 个模型 id（防止异常响应撑爆目录）。
- 页数/总量耗尽仍未拉完 → `truncated=true`，结果视为**不完整**：调用方只合并新增模型、不替换勾选、不更新拉取缓存、不做失效判定（避免把不完整列表当权威全集误删真实模型）。

### 5.5 实测验证记录（2026-09-05）

对两家真实供应商做了无 Key / dummy Key 探测，方案成立：

| 服务 | baseUrl | 探测结果 |
|------|---------|----------|
| Kimi coding | `https://api.kimi.com/coding/` | `GET /coding/v1/models` 无 Key 返回 401（端点存在）；`x-api-key` 与 `Bearer` 均被接受并进入 Key 校验；不带 `/v1` 的 `/coding/models` 返回 **404** |
| 火山方舟 coding | `https://ark.cn-beijing.volces.com/api/coding` | `GET /api/coding/v1/models` 无 Key 返回 401（端点存在）；`x-api-key` 与 `Bearer` 均被接受（Bearer 深入到 Key 格式校验）；不带 `/v1` 的路径也挂了路由（401） |

实测修正/确认的约束：

1. baseUrl 归一化（§5.1 第 3 条）是硬约束——Kimi 对不带 `/v1` 的路径直接 404；按严格方实现即可兼容宽松方。
2. 双认证头策略（§5.2）在两家均验证有效。
3. 错误体 schema 三家三样：Anthropic 官方 `{"type":"error","error":{...}}`、Kimi `{"error":{"message","type"}}`、火山 `{"error":{"code","message","param","type"}}` → 错误分类仅依赖 HTTP 状态码（§5.1 第 4 条）。
4. 未验证项：带真实 Key 时成功响应的 `data[].id` 结构（无 Key 走不到该分支），待实现后联调确认。

## 6. 数据模型变更

### 6.1 服务级拉取结论缓存（新增字段）

`LlmServiceProfile` 新增两个可选字段，作为「该服务实际支持哪些模型」的本地缓存结论：

| 字段 | 类型 | 说明 |
|------|------|------|
| `fetchedModelIds` | `string[] \| undefined` | 最近一次拉取成功时服务返回的模型 id 集合（原样缓存，不含已下线推断） |
| `fetchedAt` | `number \| undefined` | 最近一次拉取成功的时间戳（ms） |

- 仅拉取**成功且完整**时更新；失败、超时、空结果、截断结果均不清空旧缓存（避免一次网络抖动或不完整响应冲掉有效结论）。
- baseUrl 变更即服务指向改变，旧缓存作废：草稿层（`updateServiceDraft`）与持久层（`persistLlmServices`）双重清除。
- 缓存随服务配置走现有 `config:set` 持久化路径落库，无独立存储。
- 字段可选，旧配置无此字段时视为「从未拉取」，UI 不展示失效标记。

### 6.2 失效模型检测（基于缓存结论）

纯函数（放 `src/shared/llmModelConfig.ts`，如 `diffFetchedModels(supportedIds, fetchedIds)`）计算三类集合：

| 集合 | 含义 | 处理 |
|------|------|------|
| `supported ∩ fetched` | 服务确认可用 | 正常 |
| `supported − fetched` | **疑似已下线**（如内置的 kimi-k2.6 而服务已只提供 kimi-k2.7-code） | UI 打「可能已失效」标记，提供一键移除；**不自动删模型**。注意：拉取应用为替换语义（§6.4），拉取后勾选恒为 fetched 子集，该差集只出现在「上次拉取后用户又手动勾选了别的模型」的场景 |
| `fetched − supported` | 服务支持但未勾选（新上线模型） | 拉取为替换语义，成功后该集合为空；仅在用户手动取消勾选后出现 |

不自动删目录条目的原因：网关返回可能不全（分页、权限过滤、实现裁剪），自动删会误伤；失效判定只是「提示级」结论，决策权留给用户。

### 6.3 内置模型过期的处理边界

- `DEFAULT_MODELS` 内置列表本身**不随拉取结果改写**——它是新用户的初始目录，不是任何单一服务的真实清单；内置模型是否过时由发版更新解决。
- 拉取缓存结论解决的是「**用户配置侧**」的过期感知：内置模型被勾选进某服务后，一旦该服务拉取结果不再包含它，即按 §6.2 标记。
- 主进程在拉取成功并合并后，将 `fetchedModelIds / fetchedAt` 一并返回给渲染进程；若用户点「保存」，缓存随服务草稿一起持久化。

### 6.4 拉取结果 → `ModelEntry` 映射

拉取结果 → `ModelEntry` 的映射规则（主进程或渲染进程完成，建议放 `src/shared/` 纯函数便于测试）：

| 字段 | 取值 |
|------|------|
| `id` | API 返回的模型 id |
| `name` | 同 id（Anthropic 返回的 `display_name` 可用时优先采用） |
| `maximumContext` / `maxTokens` | 若 id 命中内置标签表（`BUILTIN_MODEL_TAG_DEFAULTS`，`src/shared/llmModelConfig.ts`）则用之，否则取 `DEFAULT_MODEL_MAX_CONTEXT / MAX_TOKENS` 兜底 |
| `isFast` / `isVision` | 同上，命中内置表则用之，否则 `false` |
| `enabled` | `true` |

合并语义（**替换式**：拉取成功后在应用新列表前自动清空当前勾选，以服务端返回为准）：

- id 已存在于全局目录：不新建、不覆盖用户已改过的字段，仅确保 `enabled=true` 并纳入勾选；
- id 不存在：按上表新建并纳入勾选；
- 已在 `supportedModelIds` 但本次未拉到的模型：**从勾选移除**（目录条目保留），并在成功提示中报告移除数量；
- 返回空列表视为「不确定」：不动勾选与拉取缓存，避免网关异常返回空时清空用户勾选。

## 7. IPC 与模块边界

- 新增主进程模块 `electron/llmModelListFetcher.ts`：负责发请求、双认证头、宽容解析、超时；返回 `{ ok: true, models: Array<{ id, displayName? }> } | { ok: false, error: FetchError }`，错误分类：`unauthorized / not-found / timeout / network / invalid-response`。
- 凭据获取复用 `resolveTestConnectionCredentials`（`electron/llmServiceResolver.ts`），支持「已保存服务」与「草稿中未保存的 baseUrl+Key」两种入参（参照 `config:test-connection` 既有模式）。
- 新增 IPC 通道 `llm:fetch-service-models`（invoke），handler 注册在 `electron/appIpc.ts`；preload 在 `electron/preload.ts` 暴露 `llmFetchServiceModels`，类型声明补进 `src/shared/api.ts`。
- 合并/映射纯逻辑放 `src/shared/llmModelConfig.ts`（新增 `mergeFetchedModels(models, fetched, serviceSupportedIds)` 之类纯函数），主进程与渲染进程复用，便于单测。
- 日志：拉取成功/失败经 `agentLogger` 记录（脱敏后），不落 API Key 与模型列表全量正文。

## 8. 用户交互流程

服务卡片（`LlmServiceCard.tsx`）「支持模型」多选区域旁新增「从服务拉取」按钮：

1. 点击 → 按钮进入 loading，调用 `llmFetchServiceModels`；
2. 成功：
   - 新模型合并进全局目录（`ModelsSettingsTab` 的 `addModel` 路径批量复用）；
   - 该服务 `supportedModelIds` 草稿更新为「原有 ∪ 拉取结果」；
   - Select 中可见新勾选项；给出成功提示「已拉取 N 个模型（新增 M 个）」；
   - 同时更新该服务的 `fetchedModelIds / fetchedAt` 缓存（随「保存」落库），并按 §6.2 计算差集：疑似下线的已勾选模型在 Select 选项上展示「可能已失效」标记与一键移除入口；未勾选的新上线模型在提示中列出；
3. 失败：按错误分类给出 i18n 提示（如「该服务未提供模型列表接口，请手动添加」），目录、草稿与既有拉取缓存均不变；
4. 结果仍需用户点击服务卡片的「保存」才持久化（与现有草稿机制一致，不引入隐式落库）。

i18n：新增文案放 `config` 命名空间（`src/renderer/i18n/resources/{locale}/config.json`），key 形如 `config.llmService.fetchModels.*`，zh-CN 为源，补 en-US，跑 `npm run i18n:check`。

## 9. 失败与降级行为

| 场景 | 行为 |
|------|------|
| 404 / 端点不存在 | 提示「服务不支持模型列表查询」，引导手填 |
| 401 / 403 | 提示检查 API Key |
| 超时 / 网络错误 | 提示网络问题，可重试 |
| 200 但结构无法解析 | 按 `invalid-response` 提示，不落任何变更 |
| 返回空列表 | 视为成功但「新增 0 个」，提示用户 |
| baseUrl 未填 / Key 未配 | 按钮禁用并带 tooltip 说明 |

所有失败均不影响现有模型目录与该服务既有 `supportedModelIds`。

## 10. 非功能需求

- 拉取请求超时 10s，不阻塞 UI 其它操作；
- 不打断既有 `config:test-connection` 行为；
- 新增逻辑单测覆盖：解析函数（Anthropic/OpenAI/畸形/空四种响应）、合并函数（新增/已存在/保留未返回项）、fetcher 错误分类（mock fetch）。

## 11. 迁移与兼容

- 无数据迁移：不改存储结构；
- 旧配置文件行为不变；未使用本功能的服务不受任何影响；
- `validateLlmServices`（要求至少一个 supportedModelId）语义不变，拉取只是达成该校验的新途径。

## 12. 验收标准

1. 配置一个真实 Anthropic 官方 baseUrl+Key，点击「从服务拉取」，模型目录新增 claude 系列模型且自动勾选到该服务；
2. 配置一个 Anthropic 兼容网关（如 new-api），同上可拉取；
3. 配置一个不实现模型列表端点的 baseUrl，拉取失败，有明确提示，目录与草稿不变；
4. 重复拉取不产生重复模型；已手改过的模型字段不被覆盖；
5. 拉取后需点「保存」才持久化；放弃草稿则目录与 `fetchedModelIds` 缓存均不变；
6. 某服务已勾选模型不在最近一次拉取结果中时，UI 展示「可能已失效」标记，且不会被自动移除；
7. 拉取失败不清空已有的 `fetchedModelIds` 缓存；
8. `npm exec vitest run` 相关测试通过，`npm run i18n:check` 通过，`npm run build:electron:incremental` 与 `npm run typecheck:renderer` 通过。

## 13. 待解决问题

1. 是否需要「定时/启动时自动刷新」？本期不做，观察手动拉取的使用反馈。
2. 「可能已失效」是否需要在聊天侧（模型选择器）也透出标记？本期仅设置页。
3. 是否在「添加模型」Popover 中也提供拉取入口？本期入口仅放服务卡片。
4. 缓存结论是否带 TTL（如超过 30 天视为不可信、淡化失效标记）？本期不做，`fetchedAt` 先落数据，后续按反馈决定。

## 14. 相关文件

- `src/shared/domainTypes.ts` — `ModelEntry` / `LlmServiceProfile` / `DEFAULT_MODELS`
- `src/shared/llmModelConfig.ts` — 内置标签表、新增合并纯函数
- `src/shared/api.ts` — 新增 IPC 类型
- `electron/llmModelListFetcher.ts` — 新增：拉取与解析
- `electron/llmServiceResolver.ts` — 复用凭据解析
- `electron/appIpc.ts` / `electron/preload.ts` — IPC 注册与桥接
- `src/renderer/components/Config/LlmServiceCard.tsx` — 拉取按钮入口
- `src/renderer/components/Config/ModelsSettingsTab.tsx` — 批量合并入口
- `src/renderer/i18n/resources/{zh-CN,en-US}/config.json` — 文案
