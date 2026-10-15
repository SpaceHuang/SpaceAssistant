# 模型基线接入（参数基线 · Thinking 事前判定 · 静默溢出检测）— 需求规格

**版本：** 1.3
**日期：** 2026-09-25
**状态：** 实施完成；§6 R2 端点实测待裁决
**关联文档：** [llm-multi-service-model-config-requirement.md](./llm-multi-service-model-config-requirement.md)、[llm-service-model-fetch-requirement.md](./llm-service-model-fetch-requirement.md)、[thinking-effort-settings-requirement.md](./thinking-effort-settings-requirement.md)、[context-injection-refactor-plan.md](../develop/context-injection-refactor-plan.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-09-25 | 初稿：三个工作包一批交付 —— A 参数基线、B Thinking 档位事前判定、C 静默上下文溢出检测 |
| 1.1 | 2026-09-25 | 按静态评审修订：保护用户参数迁移、统一缓存用量口径、将成功响应检测前置到所有可见副作用之前 |
| 1.2 | 2026-09-25 | 按 v1.1 复审修订：分离回答提交与真实调用用量记录，溢出后重试仍统计两次调用消耗 |
| 1.3 | 2026-09-26 | 移除新安装的预置模型目录，模型可用项仅来自用户添加或 API 服务发现 |

**工作包状态：**

| 包 | 名称 | 状态 | 依赖 |
|----|------|------|------|
| A | 模型参数基线 | 已实现并通过自动化验收 | 无 |
| B | Thinking 档位事前判定 | 已实现并通过自动化验收；R3 真实请求语义验证待补 | 依赖 A 的 `thinkingLevelMap` |
| C | 静默上下文溢出检测 | 已实现并通过自动化验收 | 依赖 A 修正的 `contextWindow` |

---

## 目录

1. [概述](#1-概述)
2. [工作包 A · 模型参数基线](#2-工作包-a--模型参数基线)
3. [工作包 B · Thinking 档位事前判定](#3-工作包-b--thinking-档位事前判定)
4. [工作包 C · 静默上下文溢出检测](#4-工作包-c--静默上下文溢出检测)
5. [交付顺序与依赖](#5-交付顺序与依赖)
6. [统一风险与待决](#6-统一风险与待决)
7. [相关文件汇总](#7-相关文件汇总)

---

## 1. 概述

### 1.1 共同动机

三个工作包围绕同一件事：**把「可以从模型元数据静态获知的事实」从运行时试错/手写维护中搬出来。**

| 包 | 现状 | 问题 |
|----|------|------|
| A | 容量参数手写在两处（`domainTypes.ts` / `modes.md`），无同步机制 | 已漂移；模型迭代必须改代码 |
| B | 模型是否接受某 Thinking 档位，靠发请求被拒后记忆 | 每次进程重启都要付失败往返 |
| C | 溢出只从**抛出的错误**识别 | 两类溢出返回「成功响应」，完全漏检 |

### 1.2 结论性事实（已实测）

**A 的双份真源已漂移（现存缺陷）**，2026-09-25 逐条比对：

| 模型名 | `modes.md` | `domainTypes.ts` | |
|--------|-----------|------------------|---|
| `deepseek-v4-pro` | 1000000 | **1_048_565** | ❌ |
| `deepseek-flash` | 1000000 | **1_048_565** | ❌ |
| 其余 8 条 | — | — | ✅ |

`1_048_565`（= 1024×1024−11）在两处出现，判定为历史误抄，`1000000` 为正确值。

**另有两处与上游目录口径不一致**（对照 `@earendil-works/pi-ai@0.87.1` 实测读取）：

| 模型名 | 字段 | 上游 | 本仓库 | |
|--------|------|------|--------|---|
| `claude-sonnet-4-6` | `maxTokens` | **128000** | **64000** | ❌ 差 2 倍 |
| `deepseek-flash` | `input` | `["text","image"]` | `isVision: false` | ❌ 判断分歧 |

**上游数据源可行性已验证**（Node 22.16.0 / Electron 35.7.5 实测）：

| 项 | 结果 |
|----|------|
| 加载上游目录 | ✅ 16/17 通过，`engines: >=22.19.0` 为保守声明，非功能门槛 |
| `require()` 加载 | ❌ `No "exports" main defined`（该包 `exports` 只有 `types` + `import`）→ 必须动态 `import()` |
| 静态加载是否拉 SDK | ✅ 不拉（`api/*.lazy` 实测 0ms，实际调用才 523ms） |
| 冷启动 | ⚠️ 核心入口 2134ms —— **本需求只用构建期生成，不进运行时** |

### 1.3 本需求范围

| 在范围内 | 不在范围内 |
|----------|------------|
| 构建期生成参数基线，替代手写参数 | 改「全局目录 + 服务勾选子集」架构 |
| Thinking 档位的事前判定（补充，非替换） | 引入 provider 命名空间 |
| 两类静默溢出的检测 | 改 LLM 调用协议（仍统一走 Anthropic SDK） |
| 三包的迁移、CI 门禁、验收 | 运行时联网刷新基线 |
| — | per-service 参数覆盖、UI 提示（另议） |

**关于 provider 命名空间（明确不做）**：`LlmServiceProfile` 是**用户运行时创建的服务**（name + baseUrl + apiKey），与上游的「provider」（源码定义的固定枚举 + 10 种协议）不是同一概念。本产品核心业务是「同一模型经多个服务出口」（见 `buildChatModelOptions` 的 `{服务名}-{模型名}` 与 `resolveServiceForModel` 的顺序解析），命名空间化会导致同模型多份条目、参数需同步，收益为负。

---

## 2. 工作包 A · 模型参数基线

> **状态：已实现并通过自动化验收** ｜ **依赖：无** ｜ **为 B、C 提供数据**

### 2.1 背景

`ModelEntry` 的 `maximumContext` / `maxTokens` / `isVision` 以手写常量存在于两处，无任何自动同步机制。

### 2.2 问题

**P1 · 双份真源已漂移**（见 §1.2）。

**P2 · 新建条目的兜底值是错的。** `normalizeModelEntry` 未命中时统一填 `DEFAULT_MODEL_MAX_CONTEXT = 200_000` / `DEFAULT_MODEL_MAX_TOKENS = 64_000`（`domainTypes.ts:853-854`）。

后果：用户对某网关执行「从服务拉取」，新建一个此前不在目录的模型（如该网关暴露的 `claude-sonnet-4-6`）时，**该条目拿到 200K/64K 兜底值而非真实容量**，后续上下文预算与环形图全部按错误基准计算。

**P3 · 模型迭代必须改代码。** 新增/修正模型要改 `domainTypes.ts` 并发版，`modes.md` 还要人工同步。

### 2.3 现状数据流与接入点

```
用户手工添加 / API 服务拉取
      │ 生成目录项并关联服务
      ▼
config.models（用户配置的模型目录）
      │
      ├── normalizeModelEntry ── 缺字段时常量兜底
      ├── migrateModelEntries ── 按名改名 + 补标签
      └── mergeFetchedModels  ── 拉取新建条目（走同一兜底）
```

`config.models` 是用户配置的模型目录；新安装初始为空，不会注入产品维护的模型名单。pi-ai 的基线只补充已存在模型的能力参数，不决定模型是否进入可用目录。旧用户已保存的目录与服务关联保持不变。

| 函数 | 位置 | 职责 |
|------|------|------|
| `normalizeModelEntry` | `src/shared/llmModelConfig.ts` | 字段兜底 + 标签补全 |
| `migrateModelEntries` | `src/shared/llmModelConfig.ts` | 改名迁移 + 逐条归一 |
| `migrateMultiServiceModelConfig` | `electron/llmServiceResolver.ts:186` | `config:get` 触发迁移 |
| `mergeFetchedModels` | `src/shared/llmModelConfig.ts` | 拉取结果新建条目 |
| `BUILTIN_MODEL_TAG_DEFAULTS` / `BUILTIN_MODEL_NAME_MIGRATIONS` | `src/shared/llmModelConfig.ts` | 标签表 / 改名表 |

### 2.4 目标与非目标

**目标**

| # | 目标 |
|---|------|
| A-G1 | `maximumContext` / `maxTokens` / `isVision` 不再手写，改由构建期基线提供 |
| A-G2 | 产品代码不维护新安装的预置模型名单或按模型名默认标记 `isFast` |
| A-G3 | 基线未命中时走**人工遗留表**，行为与现状完全一致 |
| A-G4 | 消除 §1.2 已确认的 3 处偏差 |
| A-G5 | 迁移不覆盖用户手改过的参数 |
| A-G6 | CI 能捕获「依赖已更新但基线未重新生成」 |
| A-G7 | 为 B、C 提供 `thinkingLevelMap` 与可信 `contextWindow` |

**非目标**：不改协议（沿用 `llm-service-model-fetch-requirement.md` §1.2「仍统一走 Anthropic SDK」）；不做 per-service 参数覆盖（另开需求，建议形态 `LlmServiceProfile.modelOverrides`）；不引入运行时依赖。

### 2.5 设计原则

- **数据与决策分离**：容量、视觉能力是**事实**（交给上游目录）；新安装的可用模型来自用户服务发现或手工添加。快速用途标签由用户配置，不依据模型名预置。
- **保守不干预**：基线缺失 → 沿用旧值，不猜、不填默认。
- **单点真源**：一份基线 JSON；`modes.md` 不再作为真源。
- **确定性**：同版本同输入重复生成必须字节一致（供 CI 比对）。
- **可审计**：每条记录带来源 provider。

### 2.6 数据源与生成

**依赖声明**（必须 pin 精确版本，不用 `^`）：

```json
"devDependencies": {
  "@earendil-works/pi-ai": "0.87.1"
}
```

> 实测 0.84.4 → 0.85.1 → 0.87.1 间 provider 数 38 → 39 → 41，目录随 minor 变化。用 range 会导致同一份代码在不同时间生成不同基线，破坏 A-G6 的确定性。

**生成脚本** 新增 `scripts/generate-model-baseline.mjs`（沿用仓库 `.mjs` 风格）：

```js
// pi-ai 是 ESM-only，且 exports 只声明 import 条件
const { getBuiltinProviders, getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all')
```

**输出** `res/resource/model-baseline.json`（**入库**）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-25T00:00:00.000Z",
  "piAiVersion": "0.87.1",
  "models": {
    "deepseek-v4-pro": {
      "maximumContext": 1000000,
      "maxTokens": 384000,
      "isVision": false,
      "reasoning": true,
      "thinkingLevelMap": { "minimal": null, "low": null, "medium": null, "high": "high", "max": "max" },
      "sourceProvider": "deepseek"
    }
  }
}
```

| 字段 | 来源 | 说明 |
|------|------|------|
| `maximumContext` | `contextWindow` | 直接采用 |
| `maxTokens` | `maxTokens` | 直接采用 |
| `isVision` | `input.includes('image')` | 推导 |
| `reasoning` / `thinkingLevelMap` | 同名字段 | **供工作包 B 使用** |
| `sourceProvider` | 命中的 provider id | 审计用 |

> **与上游做法的差异（有意选择）**：pi-agent 自身把生成物放 `.gitignore`、CI 每次联网现拉。本仓库不采用，理由：① 桌面应用走发版分发，无需 CI 现拉；② 入库才能 review「`deepseek-flash` 从 `text` 变 `text+image`」这类语义变更；③ 避免上游 fetch 失败卡住发版。

**同名跨 provider 冲突**：同一模型名可能存在于多个命名空间（如 `claude-*` 同时在 `anthropic`、`github-copilot`、`opencode`），参数可能不同。按固定优先级取第一条：

```js
/**
 * 取用优先级（可评审调整）。原则：
 * 1. 官方直连 provider 优先于聚合网关；
 * 2. 网关元数据多为透传，准确性低于官方；
 * 3. 国产 provider 自家条目优先于其海外/聚合变体。
 */
const PROVIDER_PRIORITY = [
  'anthropic', 'openai', 'google', 'google-vertex',
  'deepseek', 'moonshotai', 'moonshotai-cn', 'zai', 'zai-coding-cn',
  'minimax', 'minimax-cn', 'xai', 'mistral',
  // 聚合网关殿后
  'openrouter', 'vercel-ai-gateway', 'opencode', 'opencode-go',
  'github-copilot', 'azure-openai-responses', 'amazon-bedrock'
]
```

未在表中的 provider 排其后，按 id 字典序。

**人工遗留表**：基线**不保证覆盖**当前使用的全部 10 个模型（较新的国产模型可能尚未被收录）。新增 `LEGACY_MODEL_PARAMS`（`src/shared/modelBaseline.ts`），只保留未命中的条目：

```ts
export const LEGACY_MODEL_PARAMS: Record<string, {
  maximumContext: number
  maxTokens: number
  isVision: boolean
}> = { /* 仅为基线未命中的模型保留 */ }
```

**CI 约束**：若某遗留条目已被基线覆盖，`check:model-baseline` 失败并提示删除（防止两处并存再次漂移）。

### 2.7 优先级与覆盖语义

```
用户显式值  >  基线命中  >  人工遗留表  >  常量兜底
```

**`isFast` 不走基线，也不再按名称维护**：上游只有 `cost` 概念，无法等价表示本产品的快速用途；新发现模型默认不标记快速，用户可手工选择。快速优选允许从所有语言模型中选择，标签只用于列表展示与排序。视觉支持由 pi-ai 基线提供。

> 可选增强（不强制）：CI 增加「成本显著低于同族但未标 `isFast`」的提示，供人工复核。

`normalizeModelEntry` 改造：

```ts
export function normalizeModelEntry(entry: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'name'>): ModelEntry {
  const baseline = MODEL_BASELINE[entry.name]           // 生成物
  const legacy = LEGACY_MODEL_PARAMS[entry.name]        // 人工遗留
  const params = baseline ?? legacy
  return {
    id: entry.id,
    name: entry.name,
    maximumContext: entry.maximumContext ?? params?.maximumContext ?? DEFAULT_MODEL_MAX_CONTEXT,
    maxTokens: entry.maxTokens ?? params?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
    isDefault: false,
    isFast: entry.isFast ?? false,
    isVision: entry.isVision ?? params?.isVision ?? false,
    enabled: entry.enabled ?? true
  }
}
```

**行为差异**：`isFast` 不再从模型名称推导；`isVision` 从 pi-ai 基线获取。

### 2.8 数据模型变更

原方案计划将 `DEFAULT_MODELS` 精简为：

```ts
/** 内置模型的「产品决策」部分；容量与视觉能力由 model-baseline 提供 */
export type BuiltinModelSeed = Pick<ModelEntry, 'name' | 'isFast' | 'enabled'>

export const DEFAULT_MODELS: BuiltinModelSeed[] = [
  { name: 'deepseek-v4-pro', isFast: false, enabled: true },
  // ... 共 10 条，不再携带 maximumContext / maxTokens / isVision
]
```

**受影响调用点**（建议抽单一辅助函数，避免 5 处各自实现）：

| 位置 | 现状 |
|------|------|
| 原实现 `electron/appIpc.ts:758` | `DEFAULT_MODELS.map((m, i) => ({ id: String(i+1), ...m }))`（本次已移除） |
| `src/renderer/components/Config/ConfigModal.tsx:280` | 同上 |
| `src/renderer/components/Config/ConfigModal.tsx:552` | 恢复默认 |
| `electron/llmServiceResolver.test.ts:30` | 测试夹具 |
| `src/renderer/services/sessionModelBinding.test.ts:7` | 测试夹具 |

```ts
function buildDefaultModelEntries(): ModelEntry[] { // 原方案示例；最终实现不再创建预置目录。
  return DEFAULT_MODELS.map((seed, i) => normalizeModelEntry({ id: String(i + 1), ...seed }))
}
```

`BUILTIN_MODEL_TAG_DEFAULTS` 仅保留 `isFast`：

该按模型名默认打 `isFast` 标签的表已移除；新发现模型不自动标记，旧配置中用户已保存的标签保留。

### 2.9 迁移

`config.models` 是用户可编辑的全量快照，模型名命中基线不能证明该条目是内置条目，也不能证明当前参数未被用户修改。迁移必须按字段做旧值识别；不得仅因同名且参数不同就写入新基线值。

对本次已知漂移，定义版本化的旧默认值迁移表（建议 `MODEL_PARAM_MIGRATIONS`），每项记录模型名、字段、可识别的旧默认值和新值。仅当对应字段当前值严格等于该项旧默认值时替换；用户将字段改成任何其它值时保留。逐字段独立判断，一个字段符合旧值条件不授权覆盖同条目的其它字段。迁移表的旧值必须来自此前发布的默认配置/基线，且作为迁移代码保留，不能在基线更新时自动重算。

同名自建条目无法仅凭现有 `ModelEntry` 与内置条目区分，因此采用保守规则：只有字段值精确匹配已知旧默认值才迁移；无法判定来源或值不匹配旧默认值时一律保留。若自建条目恰好同名且字段恰好等于旧默认值，现有数据模型仍无法识别其来源；本次迁移不得扩大到对该值不同的覆盖，后续若需彻底区分来源，应另行增加持久化来源标记及兼容迁移。

**本次旧默认值迁移表（含 v3 审查补充）：**

| 模型名 | 字段 | 仅在当前值等于以下旧默认值时替换 | 新值 |
|--------|------|--------------------------------------|------|
| `deepseek-v4-pro` | `maximumContext` | `1048565` | `1000000` |
| `deepseek-flash` | `maximumContext` | `1048565` | `1000000` |
| `claude-sonnet-4-6` | `maxTokens` | `64000` | `128000` |
| `glm-5.3` | `maxTokens` | `128000` | `131072` |
| `glm-5.3-flash` | `maxTokens` | `128000` | `131072` |
| `minimax-m2.7` | `maxTokens` | `204800` | `131072` |
| `gpt-5.5` | `maximumContext` | `1000000` | `272000` |
| `deepseek-flash` | `isVision` | `false` | 保持原值；R2 端点实测后再裁决 |

容量字段按运行时数值比较；仅来源未标记的历史记录允许按旧默认值迁移。来源显式为 `user` 的上下文窗口必须保留，即使其数值恰好等于旧默认。`gpt-5.5` 旧记录从 1,000,000 收敛到新基线 272,000，其它不等于表中旧值的自定义值保留。`deepseek-flash.isVision` 在裁决前不执行自动迁移。`minimax-m2.7.isVision` 暂保留既有 `true` 行为（基线源目录尚未证明具体服务端点的视觉能力），待端点实测后另行裁决。

本次预期修正项：

| 模型名 | 字段 | 现值 | 迁移后 |
|--------|------|------|--------|
| `deepseek-v4-pro` | `maximumContext` | 1_048_565 | **1_000_000，仅旧值匹配时** |
| `deepseek-flash` | `maximumContext` | 1_048_565 | **1_000_000，仅旧值匹配时** |
| `claude-sonnet-4-6` | `maxTokens` | 64_000 | **128_000，仅旧值匹配时** |
| `glm-5.3` / `glm-5.3-flash` | `maxTokens` | 128_000 | **131_072，仅旧值匹配时** |
| `minimax-m2.7` | `maxTokens` | 204_800 | **131_072，仅旧值匹配时** |
| `gpt-5.5` | `maximumContext` | 1_000_000 | **272_000，仅旧值匹配时** |
| `deepseek-flash` | `isVision` | false | **保守保持 false，待裁决**（§6 R2） |
| `minimax-m2.7` | `isVision` | true | **保留 true，待端点实测** |

`kimi-k2.7-code` 的模型能力上限来自 pi-ai 为 262,144，但内置默认请求 `max_tokens` 保留为 98,304，为 262,144 上下文窗口留下可用空间。该请求预算通过模型参数覆盖表纳入新安装、默认恢复和 `modes.md` 生成；对应的已知旧配置 98,304 保持不变。模型能力上限与请求预算用途不同；上下文环显示与主进程相同的当前会话有效请求预算（包括带内置工具时的 16,384 最小值），不直接使用目录能力上限。

`ModelEntry` 增加可选 `maximumContextSource`（`baseline` / `legacy` / `user` / `fallback`）以区分可信参数与通用兜底。已标记为 `user` 的容量始终保留，即使数值等于历史默认值；来源未标记的旧配置可按版本化迁移表修正。新建模型输入容量留空时先匹配模型基线，未命中则标记 `fallback`，不能据此做可信溢出判定。旧版未知模型的 200,000 通用窗口无法证明是用户输入时，迁移为 `fallback`；明确标记为用户输入的同值配置仍保留为可信。桌面、远端和自动化入口共用同一来源解析；缺少可信标记时溢出检测按不可信处理。新安装及确实没有 `config.models` 的旧配置保持空目录，已保存的旧目录按原样迁移参数与服务引用。

### 2.10 CI 集成

`.github/workflows/ci.yml` 的 `test` job 中，紧跟 `typecheck:shared` 之后：

```yaml
- run: npm run check:model-baseline
```

`check-model-baseline.mjs` 职责：

1. 以当前 `node_modules` 中的固定版本重新生成到临时路径；
2. 与 `res/resource/model-baseline.json` 逐字节比对；
3. 不一致 → 非零退出，提示 `npm run model:baseline 后提交`；
4. 校验 `LEGACY_MODEL_PARAMS` 不含已被基线覆盖的条目。

```json
"model:baseline": "node scripts/generate-model-baseline.mjs",
"check:model-baseline": "node scripts/generate-model-baseline.mjs --check"
```

> **本检查不联网**——读的是 `npm ci` 已安装的固定版本包内目录。这是相对上游 `--strict`（fetch 失败即 CI 红）的有意选择：本仓库的基线是**入库的确定产物**，CI 只验证「产物与当前依赖版本一致」。

### 2.11 验收标准（工作包 A）

**生成**

- [ ] `npm run model:baseline` 可重复执行，同版本下输出字节一致
- [ ] 执行时打印覆盖率统计（命中数 / 遗留数 / 总数）
- [ ] 基线 `piAiVersion` 与 `package.json` 的 pin 版本一致

**行为**

- [ ] `deepseek-v4-pro` 的 `maximumContext` 为 `1000000`
- [ ] `claude-sonnet-4-6` 的 `maxTokens` 为 `128000`
- [ ] 老用户只有在字段仍精确等于迁移表列出的旧默认值时才被迁移修正；每个字段独立判断
- [ ] 内置同名条目将 `deepseek-v4-pro.maximumContext` 手动改为 `500000` 后升级仍为 `500000`
- [ ] 同名自建条目参数不等于已登记旧默认值时升级保留原值；未命中迁移表的同名条目也保留
- [ ] 迁移用例覆盖旧默认值命中、手改值不命中、单字段命中而其它字段手改、基线命中但无已知旧值四类情况
- [ ] 基线未命中的模型行为与改造前**完全一致**（回归）
- [ ] `isVision` 取值与改造前一致（除已确认的裁决项）

**拉取联动**

- [ ] 「从服务拉取」新建一个基线命中的模型时，**新建条目直接获得真实容量**（不再得到 200K/64K 兜底值）

**门禁**

- [ ] 手动改动 `model-baseline.json` 任一数值后 `npm run check:model-baseline` 失败
- [ ] `LEGACY_MODEL_PARAMS` 放入已被基线覆盖的模型名时检查失败
- [ ] `npm run build:electron`、`typecheck:shared`、`npm test` 全绿

---

## 3. 工作包 B · Thinking 档位事前判定

> **状态：已实现并通过自动化验收；R3 真实请求语义验证待补** ｜ **依赖 A 的 `thinkingLevelMap`** ｜ **不改 `src/shared/thinkingEffort.ts`**

### 3.1 背景与现状机制

产品 Thinking 档位为 `['off', 'low', 'medium', 'high']`（`THINKING_EFFORT_LEVELS`）。档位到 wire 参数的映射集中在 `buildThinkingWireParams`（`electron/effortFallback.ts`）：

| 档位 | `thinking` | `output_config` |
|------|-----------|-----------------|
| `off` | `{ type: 'disabled' }` | 不发送 |
| `low` / `medium` / `high` | `{ type: 'adaptive' }` | `{ effort: <档位> }` |

现状通过**运行时试探**发现「上游是否接受 `output_config`」：

```
组装请求（含 output_config）→ 发送
   │
   ├─ 上游 400 且点名 output_config
   │     ├─ ① 同轮去强度重试（保留 adaptive，去掉 output_config）
   │     └─ ② 写入进程内记忆 unsupportedMemo（key = llmServiceId + model）
   │
   └─ 后续请求：命中记忆则直接跳过 output_config（首次落一次审计）
```

记忆生命周期：**进程内**，重启即清空。

### 3.2 问题

**代价一**：每次进程重启后，每个 `(service, model)` 组合都要付一次失败往返。一次失败请求包含完整 system prompt、tools、历史（量级可达数十 KB），换来的只是一个 400。

**代价二**：失败往返发生在**用户可见的主聊天路径**。进程启动后首次对话若用 `high` 且该模型不支持，用户会先看到一次重试（`request_retry` / `effort_unsupported`）才拿到结果。

**代价三**：静态可得的结论被推迟到运行时。

### 3.3 数据可得性（实测）

上游目录中每个模型携带 `thinkingLevelMap`：

```json
// deepseek-v4-pro
{ "minimal": null, "low": null, "medium": null, "high": "high", "max": "max" }

// deepseek-flash
{ "minimal": null, "low": "low", "medium": null, "high": "high", "max": "max" }

// claude-opus-4-7
{ "xhigh": "xhigh", "max": "max" }
```

类型 `Partial<Record<ModelThinkingLevel, string | null>>`，语义：

| 形态 | 含义 |
|------|------|
| 值 = `null` | **明确不支持**该档位 |
| 值 = 字符串 | 支持，映射到该上游值 |
| 键缺失 | **未声明**（语义待确认，§6 R3） |

`deepseek-v4-pro` 的 `{ low: null, medium: null, high: 'high' }` 即「只接受 high 及以上」。

### 3.4 目标与非目标

**目标**

| # | 目标 |
|---|------|
| B-G1 | 对**基线明确标注不支持**的档位，首轮即不发 `output_config`，消除 400 往返 |
| B-G2 | 基线未命中 / 未声明时，**行为与现状完全一致** |
| B-G3 | 运行时事实优先于静态预期：记忆命中覆盖基线 |
| B-G4 | 判定可审计（来源标注 `baseline` / `memo` / `unknown`） |
| B-G5 | 不改变既有降级语义：不支持时仍是「保留 adaptive、去掉 `output_config`」 |

**非目标**

- 不改档位集合（仍不暴露 `minimal` / `xhigh` / `max`，沿用 [thinking-effort-settings-requirement.md](./thinking-effort-settings-requirement.md) OQ-1）。
- **不改为「自动换到支持的档位」**——那会改变用户显式选择的行为语义。
- 不引入 per-service 档位配置 UI；不做联网探测。

### 3.5 设计原则

- **保守单向**：只在**明确声明不支持**（值为 `null`）时跳过；任何缺失、未知、异常一律按「支持」处理，退回现状路径。
- **预期 ≠ 事实**：基线描述**模型**能力，实际能力由**服务/网关**决定（网关可能裁剪）。基线只作**事前捷径**，不作**硬约束**。
- **单一判定入口**：所有档位可用性判断收敛到一个纯函数。

### 3.6 档位映射与 `off` 的特殊处理

| 产品档位 | 上游键 | 说明 |
|---------|--------|------|
| `off` | `off` | 语义特殊，见下 |
| `low` / `medium` / `high` | 同名 | 直接对应 |

上游 `minimal` / `xhigh` / `max` 产品不暴露，**忽略**。

`off` 的产品语义是「`thinking` 置 `disabled`、不发 `output_config`」，映射路径与其余三档不同。若上游标注 `off: null`（如 `claude-opus-5`、`claude-fable-5`），含义是**该模型不允许关闭 thinking**；此时产品选 `off` 会发送 `{ type: 'disabled' }`，**可能被拒**。

**本需求处置**：`off: null` **不纳入**本轮判定范围。理由：该失败表现与 `output_config` 被拒不同（不是 400 点名 `output_config`），既有降级链不覆盖；纳入会扩大改动面。记入 §6 待解决问题 R4。

### 3.7 判定与消费

新增纯函数 `src/shared/thinkingAvailability.ts`（纯逻辑无 IO）：

```ts
export type ThinkingSupportSource = 'baseline' | 'memo' | 'unknown'

export type ThinkingAvailability = {
  /** 明确不支持的档位（仅来自基线） */
  unsupported: readonly AgentReasoningEffort[]
  /** 判定依据 */
  source: ThinkingSupportSource
}

/**
 * 判定某模型的档位可用性。绝不抛错。
 * @param modelName - 模型名（与基线 key 对齐）
 * @param opts.effortUnsupportedByMemo - 运行时记忆：该 (service, model) 是否已被上游拒绝过
 */
export function resolveThinkingAvailability(
  modelName: string,
  opts: { effortUnsupportedByMemo: boolean }
): ThinkingAvailability
```

**实现规则**：

1. `effortUnsupportedByMemo === true` → `{ unsupported: ['low','medium','high'], source: 'memo' }`（等价于现状「全部跳过」）
2. 否则查基线 `thinkingLevelMap`：
   - 未命中该模型 → `{ unsupported: [], source: 'unknown' }`
   - 命中：对 `low` / `medium` / `high` 逐个判定，`map[key] === null` → 加入 `unsupported`；来源标注 `'baseline'`
3. 任何异常（字段缺失、类型异常、整体 `null`）→ 退化为 `unknown`

**兜底断言**：`unsupported` 不得包含 `'off'`。

**消费点改造**（`electron/toolChatLoop.ts`，组装 `buildThinkingWireParams` 之前）：

```ts
const availability = resolveThinkingAvailability(model, {
  effortUnsupportedByMemo: isEffortUnsupportedByUpstream(args.llmServiceId, model)
})
// 现状：仅凭记忆决定是否跳过；改造：记忆 OR 基线明确不支持 → 跳过
const skipOutputConfig = availability.source === 'memo'
  || availability.unsupported.includes(reasoningEffort)
```

| 情形 | 改造前 | 改造后 |
|------|--------|--------|
| 记忆命中 | 跳过 + 首次审计 | **不变** |
| 基线明确不支持该档位 | 发请求 → 400 → 重试 | **直接跳过 `output_config`**（保留 adaptive） |
| 基线未声明 | 发请求 → 400 → 重试 | **不变** |
| 基线支持但被上游拒绝 | 发请求 → 400 → 记忆 | **不变** |

**审计**：跳过时落一条，字段至少含 `model` / `llmServiceId` / `requestedEffort` / `reason`（`baseline_unsupported` 或 `memo`）/ `fallback`（固定 `'adaptive'`）。沿用 `consumeEffortMemoizedAudit` 的「首次落一次」模式。

### 3.8 与既有约束的关系（需在评审确认）

`src/shared/thinkingEffort.ts` 有明确约束：

> 复用契约类型 `AgentReasoningEffort`，不新造枚举；服务端另有 `xhigh/max`，本产品不暴露（OQ-1），**校验时不得用 SDK 枚举反推服务端能力。**

| 维度 | 约束所指 | 本需求所做 | 冲突 |
|------|---------|-----------|------|
| 数据性质 | 用「SDK 的枚举定义」反推能力 | 用「模型元数据的具体取值」 | ❌ 前者是类型层面推断，后者是逐模型具体数据 |
| 用途 | 校验（决定是否接受用户输入） | 事前捷径（决定是否发送一个可选字段） | ❌ 不改变输入校验结果 |
| 失败姿态 | fail-loud | fail-open（不确定则照常发送） | ❌ 与现状一致 |

**关键区别**：`unsupported` 只影响「是否发送 `output_config`」这一可选字段，**不影响用户能否选择该档位**。用户选 `high` 而模型不支持时，结果与现状相同（保留 adaptive），只是省掉一次失败往返。

> 建议实现时在 `thinkingAvailability.ts` 文件头复述这段关系，避免后续维护者误判。

### 3.9 验收标准（工作包 B）

**功能**

- [ ] 对基线标注 `low: null` 的模型（如 `deepseek-v4-pro`）选择 `low`：**首轮请求体不含 `output_config`**，且无 `effort_unsupported` 重试事件
- [ ] 同一模型选择 `high`：正常携带 `output_config`
- [ ] 基线未命中的模型：行为与改造前**逐字段一致**（回归）
- [ ] 基线说支持但上游拒绝：仍走现有记忆降级（mock 验证）
- [ ] 记忆命中时优先于基线

**审计**

- [ ] 因基线跳过时落一次审计，`reason` 为 `baseline_unsupported`
- [ ] 连续多轮不重复打点

**边界**

- [ ] `unsupported` 不含 `'off'`
- [ ] `thinkingLevelMap` 缺失 / 为 `null` / 类型异常时返回 `unknown`，不抛错
- [ ] `effort === 'off'` 时不走该阻断路径

**门禁**

- [ ] `thinkingAvailability.test.ts` 覆盖：基线命中 / 未命中 / 记忆优先 / 异常退化 / `off` 排除
- [ ] `typecheck:shared`、`typecheck:renderer`、`npm test` 全绿

---

## 4. 工作包 C · 静默上下文溢出检测

> **状态：已实现并通过自动化验收** ｜ **依赖 A 修正的 `contextWindow`** ｜ **不替换既有 error 路径判定**

### 4.1 背景

`src/shared/overflowRecovery.ts` 提供 `isProviderContextOverflow(error)` 与 `decideOverflowRecovery(input)`：从**抛出的错误**中识别「输入超出模型上下文窗口」，并决定是否重开上下文后重试。

调用点在 `electron/toolChatLoop.ts:1438`，位于 `client.messages.stream(...)` 的 **catch 分支**：

```ts
const recovery = decideOverflowRecovery({
  error: e, retries: overflowRetries, maxRetries: 1, inFlightToolCount: 0, safeBoundary: true
})
if (recovery.action === 'reset_and_retry_provider') { /* recoverBeforeSend + continue */ }
```

**前提假设**：超窗一定以 error 形式暴露。

### 4.2 问题：两类不产生 error 的溢出

| 类型 | 表现 | 后果 |
|------|------|------|
| **A. 静默接受**（如 z.ai） | 请求被接受，`stopReason = 'stop'`（正常结束），但 `usage.input` 已超过模型窗口 | 溢出未被识别，模型在**被上游截断的上下文**上作答，用户看到「正常但答错」 |
| **B. 截断填满**（如 Xiaomi MiMo） | 服务端把超长输入截断至恰好填满窗口，返回 `stopReason = 'length'` 且 `output = 0`（无余量生成） | 被归一为普通 `max_tokens`，不触发恢复；用户看到空回复或需手动重试 |

**共同点**：溢出信号不在 `error` 上，而在**成功响应的 `stopReason` + `usage` 组合**中。

### 4.3 现有判定的边界（不替换）

`isProviderContextOverflow(error)` 已包含较严谨的排除逻辑：

1. 结构化字段：`status === 429` → 否；`type` / `error.type` / `error.code` 匹配 `rate_limit|quota|too_many_requests` → 否；匹配 `context_length|prompt_too_long|input_too_large` → 是；
2. 文本：限流类文案先排除；`hasOutputTokenParameter && !hasContextOverflowText` → 排除（避免把 `max_tokens` 参数错误误判为超窗）。

**结论：现有 error 路径的判定质量高于外部同类实现，本需求不替换它。** 缺口仅在「没有 error 可判」。

### 4.4 关键字段可得性（已核实）

| 字段 | 来源 | 备注 |
|------|------|------|
| `stopReason` | `normalizeStopReason(raw)` → `'max_tokens' \| 'end_turn' \| 'tool_use' \| 'other'` | `electron/stopReason.ts`；上游 `'length'` → `'max_tokens'`，`'stop'` → `'end_turn'` |
| `usage` | `normalizeAnthropicMessageUsage` → `SessionUsage` | 字段 `input_tokens` / `output_tokens?` / `cache_read_input_tokens?` / `cache_creation_input_tokens?` |
| **`contextWindow`** | **`RunToolChatSessionArgs.contextWindow`（`toolChatLoop.ts:518`）** | ✅ **运行时已可得，无需新建链路** |

> `contextWindow` 的准确度依赖工作包 A（修正 `deepseek-v4-pro` 等漂移值）。

### 4.5 目标与非目标

**目标**

| # | 目标 |
|---|------|
| C-G1 | 识别 §4.2 两类溢出，触发与 error 路径**相同**的恢复动作 |
| C-G2 | 复用既有 `overflowRetries` 预算，**不引入新的重试循环** |
| C-G3 | `contextWindow` 缺失或不可信时**不判定**（避免误伤） |
| C-G4 | 判定可审计（命中类型、实际用量、窗口值） |
| C-G5 | 正常 `max_tokens`（有输出）**不误判** |

**非目标**：不替换 `isProviderContextOverflow`；不改主动压缩（`shouldCompact` / `bodyBudget`）触发口径；不改 `outputRecovery` 机制（但需明确边界，§4.8）；不做 UI 提示（另议）。

### 4.6 设计原则

- **启发式，须保守**：类型 B 的「填满 99%」是启发式阈值，宁可漏判也不误判。
- **仅可信窗口参与判定**：`contextWindow` 缺失、非法或来源为通用 fallback 时跳过；窗口来源通过模型参数解析结果显式传递，不能按数值排除，因为 200,000 也是真实模型窗口。
- **只作补充**：仅处理「成功响应」路径；error 路径完全不动。
- **单一出口**：命中后走既有 `recoverBeforeSend` + 重试预算。

### 4.7 判定规则

新增纯函数（放 `src/shared/overflowRecovery.ts`，与既有判定同文件便于对照）。实现复用 `src/shared/contextUsageEstimate.ts` 的 `computeTotalRequestInputTokens(usage)`，该函数依据 `usage.cacheSemantics` 统一处理缓存 token，禁止在静默溢出检测中另写缓存加总公式：

```ts
export type SilentOverflowKind = 'usage-exceeds-window' | 'truncated-input'

export type SilentOverflowResult =
  | { overflow: false }
  | { overflow: true; kind: SilentOverflowKind; inputTokens: number; contextWindow: number }

/**
 * 检测「未以 error 形式暴露」的上下文溢出。
 * 仅使用成功响应的 stopReason + usage，不读错误对象。
 * @param input.contextWindow - 缺失/非法时直接返回未命中
 */
export function detectSilentContextOverflow(input: {
  stopReason: NormalizedStopReason | undefined
  usage: SessionUsage | undefined
  contextWindow: number | undefined
}): SilentOverflowResult
```

**前置条件**（任一不满足即返回 `{ overflow: false }`）：

- `usage` 存在且 `input_tokens` 为有限非负数；
- `contextWindow` 为有限正数，且 `contextWindowTrusted === true`；未提供可信标记一律跳过。数值等于 `DEFAULT_MODEL_MAX_CONTEXT` 本身不构成跳过理由；
- `stopReason` 存在。

**有效输入量**（与 ContextMeter、上下文预算及请求用量统计一致）：

```
inputTokens = computeTotalRequestInputTokens(usage)
```

其中 `cacheSemantics === 'subset'` 时总输入量仅取 `input_tokens`；`cacheSemantics === 'additive'` 时为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。未标注语义时沿用该统一函数现有的兼容推断。审计字段 `inputTokens` 也必须使用此结果。类型 A 的 `>` 和类型 B 的 `>= contextWindow * 0.99` 阈值均以该统一结果判断。

**类型 A：静默接受**

```
stopReason === 'end_turn' && inputTokens > contextWindow
```

**类型 B：截断填满**

```
stopReason === 'max_tokens'
&& output_tokens === 0
&& inputTokens >= contextWindow * 0.99
```

> `0.99` 为启发式阈值。三个条件必须同时满足：仅有 `max_tokens` 或仅有零输出都不足。

类型 B 还要求 `usage.output_tokens === 0` 被明确上报，且已解析回答没有正文、思考或工具输出。缺少 `output_tokens` 是无判据，不等于零。

**明确排除**：

| 场景 | 结果 | 理由 |
|------|------|------|
| `max_tokens` 且 `output_tokens > 0` 或缺失 | 未命中 | 有输出或输出量未知，属正常输出恢复/兼容路径 |
| `stopReason === 'tool_use'` | 未命中 | 正常工具调用 |
| `end_turn` 且 `inputTokens <= contextWindow` | 未命中 | 正常结束 |
| `usage` 缺失 | 未命中 | 无判据 |
| `contextWindow` 缺失 / 非法 / 来源为 fallback | 未命中 | 基准不可信 |
| 可信 `contextWindow === 200_000` | 正常判定 | 真实模型窗口可恰好等于通用 fallback 数值 |

### 4.8 消费点改造与 `outputRecovery` 边界

**新增调用位置与提交协议**：工具调用及其后续执行触发、回答上下文投影和表示最终回答成功的 `llm.response` 必须暂存到终态判定后。桌面正文/思考增量可在可信的 `message_start` 用量确认未超窗后实时暂显，但属于可撤销预览；终态用量若触发溢出，必须立即以 reconciliation 事件恢复到此前已接受回答前缀，不能让被丢弃回答残留在 UI。标准化 `assistant_chunk` 事件台账及远端/自动化回答正文一律暂存到终态接受后，提交时保持上游顺序。远端正文段闭合时可更新活动快照供心跳展示，但快照只能报告状态（例如“已生成一段回复，继续处理中”），不得包含尚未接受的回答正文，因为 IM 心跳消息不可撤回。起始用量缺失或已超窗时，桌面 UI 增量也隔离至终态。

实现必须将单次尝试的工具调用事件及其后续执行触发、回答上下文投影和表示最终回答成功的 `llm.response` 暂存，直到 `finalMessage()` 已返回且静默溢出判定完成后才提交。桌面预览允许依据起始用量暂显，但必须能在终态用量不一致并命中溢出时回撤正文与思考；session event ledger 和远端/自动化回答正文在接受前不可见。远端活动快照仅含阶段状态，可在闭合正文块期间供心跳使用；发生溢出或流错误时恢复到先前已接受的快照。工具不得在判定提交前执行。隔离的标准化事件在终态接受后按源顺序写入台账。

**实际调用用量不随回答一起丢弃**：只要某次模型调用已返回可用 `usage`，无论其回答随后被接受、因静默溢出废弃，还是重试失败，都必须为该 attempt 记录 `request_usage` 与 `usage_step_facts`，纳入 Turn 消耗和 Step 统计。这与每次实际 LLM 调用均计入统计的既有口径一致。被废弃尝试的用量记录须关联其独立 `requestId`（及现有调用链可提供的 step/round 标识），并标记 `resultDisposition: 'discarded_overflow'` 或等价字段；重试请求作为另一 attempt 独立记录。标记用于解释该调用没有对应的可见回答，不得用于从 token、步数或费用聚合中排除它。

因此判定完成后分两条提交路径：溢出命中时，提交该 attempt 的真实用量事实及溢出审计，丢弃回答内容、工具调用和回答上下文投影；未命中时，提交用量事实以及暂存的回答、工具和投影事件。若 `usage` 缺失，则不伪造用量行，但仍按实际调用的既有失败/审计语义处理。

若现有流式协议无法暂存，则需先实现等价的可撤销事务协议：撤销必须覆盖已显示文本、工具调用事件和回答上下文副作用，并保证订阅方不会把撤销前内容作为最终回答；已经发生的调用用量事实不得撤销。单纯在重试后覆盖 UI 文本不满足要求。首选在成功判定前暂存、判定通过后提交。

**命中后动作**（复用既有路径；此时该次尝试尚未提交任何成功副作用）：

1. 落审计事件；
2. 若 `overflowRetries >= maxRetries(1)` → 与 error 路径一致，**失败收口**；
3. 否则 → 调用既有 `recoverBeforeSend(...)` 重开上下文，`overflowRetries += 1`，重新发送。

**预算共用**：与 error 路径共享 `overflowRetries`，保证「一轮内最多恢复一次」的既有语义不被突破。

**与 `outputRecovery` 的边界（需在评审确认）**：`electron/outputRecovery.ts` 已有 `MAX_OUTPUT_RECOVERIES` / `classifyOutputRecovery` / `buildOutputRecoveryMessage`，处理**输出侧**未达预期的情况。类型 B 的表面特征与输出恢复重叠，必须明确优先级：

- **若输出已填满窗口** → 属输入超窗导致无余量，**应走 overflow 恢复**（本包）；
- **若输出远未达预期但输入未填满窗口** → 属输出侧问题，走 `outputRecovery`。

**建议**：本需求判定**优先于** `outputRecovery`（先判输入侧归因），并在实现文档中固化。此点列入 §6 待确认项。

**审计字段**：`kind` / `inputTokens` / `contextWindow` / `model` / `llmServiceId` / `stopReason`。沿用首次落一次模式。

### 4.9 验收标准（工作包 C）

**命中**

- [ ] 类型 A 的 `subset` 用量（如 `input_tokens=100000`、`cache_read_input_tokens=80000`、`cacheSemantics='subset'`、窗口 `150000`）按 `100000` 判断，不因重复计算缓存读取量而触发恢复
- [ ] 类型 A 的 `additive` 用量按 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 判断；覆盖缓存读取量与缓存创建量共同使输入超过窗口的情况
- [ ] 类型 B 的 `subset` / `additive` 用量均通过 `computeTotalRequestInputTokens` 判断 99% 阈值，且 `output_tokens=0`
- [ ] 构造类型 A 响应（`end_turn`，统一计算的输入量 > `contextWindow`）→ 触发恢复，审计 `kind='usage-exceeds-window'`
- [ ] 构造类型 B 响应（`max_tokens`，`output_tokens=0`，统一计算的输入量 ≥ 窗口 99%）→ 触发恢复，审计 `kind='truncated-input'`

**不误判**

- [ ] `max_tokens` 且 `output_tokens > 0` → **不触发**
- [ ] `end_turn` 且 `inputTokens <= contextWindow` → **不触发**
- [ ] `usage` 缺失 → **不触发**
- [ ] `contextWindow` 缺失 / `0` / 负数 / 来源为 fallback → **不触发**
- [ ] 可信 200,000 窗口（真实模型或用户配置）仍按 A/B 条件正常判定；相同数值但来源为 fallback 时跳过
- [ ] `stopReason === 'tool_use'` → **不触发**

**预算与回归**

- [ ] 类型 A 已产生流式文本但尚未提交时命中：该次文本、工具调用、回答投影和成功 `llm.response` 不对 UI/台账可见；该次已返回的 usage 仍按独立 attempt 写入 `request_usage` / `usage_step_facts` 并标记 `discarded_overflow`
- [ ] 普通可信窗口响应在 `message_start` 用量确认未超窗后，provider 继续流动期间已经收到 renderer 正文/思考增量；最终判定前工具调用仍未发布/执行
- [ ] 普通响应的 `assistant_chunk` 事件顺序与上游一致；覆盖 `message_start → block_start → text_delta → block_end` 以及正文和工具块交错场景
- [ ] 远端飞书与微信请求在正文段闭合、`finalMessage()` 尚未返回时能更新可发布的活动快照；快照只显示阶段状态，不泄露未终态接受正文；溢出/流错误后恢复旧快照
- [ ] 上下文环使用当前会话真实请求 `max_tokens`（与主进程同一归一化，内置工具请求不少于 16,384），而不是模型目录最大能力值；Kimi 默认 4,096 会话设置显示 16,384 输出预留，并保留上下文环空闲区
- [ ] 输出截断恢复包含本轮此前已接受的工具轮正文；最终正文对账保留与其内容一致的既有正文分段时间，使工具卡回放顺序不变
- [ ] 类型 B 空输出命中后重试：首次调用和重试调用的可用 usage 均保留并计入 Turn token 消耗与 Step 数；只保留重试结果对应的回答、投影和可见成功事件
- [ ] 对溢出重试构造首次调用与重试调用均有 usage 的用例，断言两者 token 均进入统计、两条 Step 均计数，且用户只看到重试后的回答
- [ ] 被标记 `discarded_overflow` 的 usage 行不会被任何 Token、Step 或费用汇总过滤；该标记仅关联回答处置状态
- [ ] 工具调用在判定提交前不执行；溢出重试不会留下孤儿 `tool_call` 事件
- [ ] 一轮内最多恢复一次（与 error 路径共用 `overflowRetries`）
- [ ] 既有 error 路径行为**逐字段不变**（回归 `overflowRecovery` 全部既有单测）
- [ ] `typecheck:shared`、`typecheck:renderer`、`npm test` 全绿

---

## 5. 交付顺序与依赖

```
工作包 A（参数基线）
   ├──► 工作包 B（thinking）：需要 thinkingLevelMap
   └──► 工作包 C（静默溢出）：需要准确的 contextWindow
```

**B、C 均设计为「A 的数据缺失时行为与现状完全一致」**，因此可并行开发；但**验收需在 A 落地后**——否则 B 的判定恒为 `unknown`、C 的 `contextWindow` 不可信，功能实际不可验证。

建议实施顺序：

1. **A 的 spike**（§6 R1）：输出基线覆盖率，确认 10 个模型中命中几个；
2. **A 实现 + 迁移 + CI 门禁**，验收通过；
3. **B、C 并行实现**（共享 `modelBaseline.ts` 的查询接口）；
4. 三包合并验收：`npm run build:electron`、三个 typecheck、`npm test` 全绿。

---

## 6. 统一风险与待决

### 6.1 风险

| # | 包 | 问题 | 影响 | 处置 |
|---|----|------|------|------|
| **R1** | A | **基线覆盖率未知** | 命中很少则 A 的收益有限 | **实现前先跑 spike** 输出覆盖率；未命中的走 `LEGACY_MODEL_PARAMS`，不影响功能 |
| **R2** | A | `deepseek-flash` 的 `isVision` 三方分歧（上游 `text+image`、本仓库 `false`、另一参考实现单独列 exp 模型）；`minimax-m2.7` 上游元数据为 false，但历史默认值为 true | 影响视觉路由 | **需人工裁决一次**：以实际配置服务端点发图为准；裁决前两模型都保留既有行为，结果写入裁决表 |
| **R3** | B | **`thinkingLevelMap` 的「键缺失」语义待确认** | 若实为「不支持」，按保守原则（视为支持）会漏掉部分跳过机会；反之保守原则正确 | **实现前做语义验证 spike**：取 3–5 个模型，对**键缺失**的档位发真实请求观察。结论明确前坚持保守原则，**不产生错误行为**，只是少省一次往返 |
| **R4** | B | `off: null`（模型不允许关闭 thinking）未纳入 | 选 `off` 时可能被拒，既有降级链不覆盖 | 记入待解决问题，另开需求 |
| **R5** | C | **类型 B 的 `0.99` 阈值是启发式** | 过高漏判，过低误判正常截断 | 要求 `output_tokens === 0` 且 `contextWindow` 可信，双重约束；阈值先固化，后续按实测调整 |
| **R6** | C | **与 `outputRecovery` 的优先级未定** | 类型 B 可能被输出恢复抢先，导致归因错误、反复重试 | 实现前必须确认（§4.8），建议「输入侧优先」并写入实现文档 |
| **R7** | C | 上游 usage 上报不准（如 cache 语义差异） | 影响 `inputTokens` 计算 | 复用既有 `annotateUsageCacheSemantics`（`src/shared/usageCacheSemantics.ts`）口径 |
| **R8** | A | 跨 provider 同名取用优先级 | 参数可能与实际服务不符 | §2.6 优先级表可评审调整；每条带 `sourceProvider` 便于排查 |
| **R9** | A | pin 版本导致「目录更新需发版」 | 与「模型迭代要跟版本」部分冲突 | 本需求只解决**参数不用手抄**；目录新鲜度机制（是否引入远程 overlay）另议 |

### 6.2 待解决问题

**实现前必做（已完成）**

1. **【A，R1】已完成**：基线命中 10 / 遗留 0 / 总数 10。
2. **【B，R3】部分完成**：自动化验证了缺失键按 unknown/fail-open 处理；对真实服务端点的 3–5 个模型请求仍待执行，完成前维持保守策略。
3. **【C，R6】已完成**：实现中静默输入溢出判定先于 `outputRecovery`，命中后走既有恢复预算。

**待裁决**

4. **【A，R2】待端点实测**：`deepseek-flash.isVision` 保持 `false`，`minimax-m2.7.isVision` 保持历史默认 `true`；未执行自动迁移。需在实际服务端点发图后填写裁决。

**另议（本需求不含）**

5. `res/resource/modes.md` 保留为「脚本生成的可读文档」还是直接删除？若删除或改性质，需同步更新 3 处引用：`settings-requirement.md:62`、`llm-multi-service-model-config-requirement.md:100,365,714`、`agent-token-usage-analytics-requirement.md:296`。
6. 基线是否携带 `inputLimits`（图片缩放、请求体上限）？当前 `chatAttachmentLimits.ts` 只有 5 个全局常量。**建议不引入**，待有具体需求再开。
7. 基线是否携带 `cost`？当前 usage 统计不涉及价格，**不引入**。
8. **【B，R4】** `off: null` 的处理路径。
9. 是否需在设置页向用户提示「该模型不支持此档位」？（现状静默降级，用户不可见）
10. **【C】** 是否在 UI 提示「本轮上下文已被截断，建议新建会话」？
11. **【C】** 静默溢出后是否需要更新 `ContextMeter` 锚点，避免压力投影继续偏乐观？
12. 是否需 per-service 覆盖（同一模型在不同网关上参数/档位支持不同）？当前基线只能给「模型级」预期，形态建议 `LlmServiceProfile.modelOverrides`。

---

## 7. 相关文件汇总

### 工作包 A

| 文件 | 变更类型 |
|------|----------|
| `package.json` | 新增 pin 版 `devDependencies` + 2 个 scripts |
| `scripts/generate-model-baseline.mjs` | **新增**：生成 + `--check` |
| `res/resource/model-baseline.json` | **新增生成物**（入库） |
| `res/resource/modes.md` | 废弃或改为生成物（§6.2-5） |
| `src/shared/modelBaseline.ts` | **新增**：类型、`MODEL_BASELINE`、`LEGACY_MODEL_PARAMS`、查询函数 |
| `src/shared/domainTypes.ts` | 移除 `DEFAULT_MODELS` 预置名单 |
| `src/shared/llmModelConfig.ts` | `normalizeModelEntry` 查基线；标签表移除 `isVision`；`migrateModelEntries` 增加覆盖步骤 |
| `electron/ipc/configIpc.ts` | `config:get` 不再注入预置目录；缺省模型名为空 |
| `src/renderer/components/Config/ConfigModal.tsx` | 空目录保持为空，移除恢复内置名单入口 |
| `.github/workflows/ci.yml` | 新增 `check:model-baseline` |
| `electron/llmServiceResolver.test.ts`、`src/renderer/services/sessionModelBinding.test.ts` | 夹具改走同一辅助函数 |

### 工作包 B

| 文件 | 变更类型 |
|------|----------|
| `src/shared/thinkingAvailability.ts` | **新增**：判定纯函数 + 类型 |
| `src/shared/thinkingAvailability.test.ts` | **新增**：单测 |
| `electron/toolChatLoop.ts` | 组装点（~949）引入判定，`skipOutputConfig` 条件扩展；审计字段扩展 |
| `electron/effortFallback.ts` | **不改**（既有记忆机制作为运行时兜底保留） |
| `src/shared/thinkingEffort.ts` | **不改**（档位集合与校验语义保持不变） |

### 工作包 C

| 文件 | 变更类型 |
|------|----------|
| `src/shared/overflowRecovery.ts` | **新增** `detectSilentContextOverflow` + 类型；既有函数不动 |
| `src/shared/overflowRecovery.test.ts` | 新增用例（命中 2 类 / 不误判 5 类 / 边界） |
| `electron/toolChatLoop.ts` | 流成功结束后新增检测点（~1450）；命中后复用 `recoverBeforeSend` 与 `overflowRetries`；审计字段 |
| `electron/outputRecovery.ts` | **不改**，但需在 §4.8 明确优先级 |
| `electron/stopReason.ts` / `electron/anthropicUsageNormalize.ts` | **不改**（只读取） |
| `src/shared/usageCacheSemantics.ts` | **不改**（复用其 cache 语义口径） |

---

*文档结束*
