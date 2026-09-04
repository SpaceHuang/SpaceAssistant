# 工具确认机制顶层设计（通俗版）

> 状态：经四轮评审修订（v1–v4 修订记录见 §8），可进入 P0
> 正本声明：本文档是本设计的唯一正本（原 `tool-confirmation-top-level-design.md` 废弃）。本文档在原稿基础上做了通俗化改写，只调整措辞，不改变任何语义与结论；评审锤炼出的承重术语（硬拒绝、链路硬约束、决策缓存、事实提取层、策略层、确认通道等）予以保留，首次出现时附白话解释。
> 创建：2026-08-29
> 范围：桌面聊天、微信、飞书、未来自动任务/定时任务等所有链路的**工具确认与授权机制**，以及更广的策略管控点——包括三个时机：消息进来时拦不拦（ingress，"这条消息该不该被响应"）、给模型展示哪些工具（exposure）、工具真正被调用时放不放行（invocation）
>
> 说明：本文档是 `tool-confirmation-top-level-design.md` 的通俗改写版，只做措辞调整，不改变任何语义与结论。代码里的类型名（如 `ContentFacts`、`PolicyRule`）保留原文，因为它们是接口约定。

## 1. 背景与问题

当前工具确认机制是三条链路各自长出来的，结果是"功能链路分散 + 设置入口分散 + 策略判断分散"三处分散。

### 1.1 现状事实（代码调研结论）

**三条链路，两套确认机制：**

- 桌面链路：`toolChatLoop.ts` 内 `toolNeedsUserConfirmation()`（:2126）判断 → `tool:confirm-request` 事件推到渲染进程 → `ToolCallCard` 系确认卡片 → `tool:confirm-response` IPC → `toolConfirmRegistry`（内存 Map，超时 5 分钟）。
- 微信链路：`weChatConfirmManager.ts`（基于 `remote/pendingRequestRegistry.ts`），IM 文本协议 `Y/N/信任 <confirmId>`，超时 5 分钟。
- 飞书链路：`feishuConfirmManager.ts`，与微信几乎同构，超时 10 分钟；另有飞书特有的 `larkCliWriteRequiresConfirm`。
- 两套装配在 `toolChatLoop.ts:1441-1540` 处靠 `remoteContext` 分叉，`remoteConfirmBridge.ts` 中 `createFeishuRequestToolConfirm` / `createWeChatRequestToolConfirm` 对称重复。

**确认判断散落多处：**

- 内置工具确认名单硬编码在 `src/shared/domainTypes.ts:516` `builtinToolNeedsConfirmation()`，工具定义本身（`builtinToolDefinitions.ts`）无确认/风险字段。
- 逐个工具的修正逻辑堆在 `toolChatLoop.ts:1280-1662` 约 380 行：MCP 策略、shell 信任命令、远程写授权、浏览器域名信任、脚本静态分析、写文件 auto 审批……全部内联在主循环里。
- 风险等级 `getBuiltinToolRiskLevel()`（domainTypes.ts:~490）与确认名单分开维护，容易漂移。

**设置入口分散：**

- `ToolsSettingsTab`：confirmMode（diff/direct/auto）、逐工具启用开关。
- `BrowserSettingsTab`：navigate/act 确认开关、域名信任、高危关键词。
- `ShellSettingsTab`：信任命令管理。
- `RemoteImCommonSettings`（飞书/微信各嵌一份）：`remoteAllowLocalWrite`、`remoteDenyOutbound`、`remoteScriptRequiresConfirm` 等。
- 飞书另有 `larkCliWriteRequiresConfirm`；另有迁移门控 `RemoteSecurityUpgradeModal`、`applyMigrationConservativeOverlay` 等历史包袱。

**豁免/信任机制五种并存**：shell 信任命令（持久）、浏览器域名信任（持久+会话级）、MCP 会话信任（会话级）、远程写文件授权（session 级 grant）、confirmMode=auto 的自动审批——语义、粒度、持久化方式、管理入口各不相同。

**超时三处三个值**：桌面 5min、微信 5min、飞书 10min，硬编码。

### 1.2 核心问题

1. **每新增一条执行链路（自动任务/定时任务），就要再复制一套确认管理器 + 一套设置**，重复已经发生在飞书/微信之间，第三次发生几乎必然。
2. **确认决策无法集中演进**：想做"智能判断"（如基于风险评估自动放行低风险操作）时，改动点散落在主循环 380 行内联逻辑和各个设置 Tab 里，没有一个统一的下手位置。
3. **用户心智负担重**：同一语义（"这个操作要不要问我"）在五个设置页里有五种表达方式。
4. **豁免机制无统一模型**：信任什么、多久、作用于哪个链路，没有一致的概念，审计和撤销都困难。

## 2. 设计目标

1. **确认决策一处定义**：任何工具在任何链路上是否需要确认，由统一的策略引擎判定，主循环只负责执行判定结果。
2. **链路只提供"确认通道"**：桌面卡片、IM 文本、未来自动任务的审批方式只是确认请求的*送达方式*，不改变策略本身。
3. **设置入口统一**：一个"工具安全/确认"设置中心，按语义组织（风险等级、豁免、链路约束），而不是按工具或按 IM 渠道平铺。
4. **豁免（信任）模型统一**：所有"下次别问了"收敛为**决策缓存**（用户回答的内部缓存，不是权限，见 §3.4 的两层划分）。
5. **为自动化与智能判断预留演进点**：自动任务链路接入时零新增策略代码；风险评估器可插拔替换。

非目标（本期不做）：不改工具定义协议的外部形态、不做跨设备同步授权、不引入 RBAC 用户体系。

## 3. 核心概念模型

```
工具调用 ToolInvocation
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│              FactExtractor（事实提取层）                  │
│  原始 toolInput → ContentFacts（见 §3.3）                │
│  命令分解 / 路径分类 / 网络出口 / 内容静态分析…           │
└─────────────────────────────────────────────────────────┘
        │ ContentFacts
        ▼
┌─────────────────────────────────────────────────────────┐
│                    PolicyEngine（策略层）                 │
│  输入：ContentFacts + ExecutionContext + Config + Cache   │
│  输出：Decision = AutoAllow | RequireConfirm | Deny       │
│  ※ 策略层只看提取出的事实，永不直接读原始 toolInput        │
└─────────────────────────────────────────────────────────┘
        ▲                                      │
        │                                      ▼
┌───────────────┐                    ┌──────────────────────┐
│ ExecutionLane │                    │ ConfirmationChannel  │
│ 执行链路       │                    │ 确认通道（可插拔）     │
│ desktop/wechat│                    │ desktop卡片 / IM文本  │
│ feishu/cron…  │                    │ / 自动任务审批队列     │
└───────────────┘                    └──────────────────────┘
```

整个流程一句话：工具每次要被调用时，先由"事实提取层"把这次调用的内容分析成一组事实（干什么、动哪个文件、连哪个网站），再交给"策略层"对照规则做判定——放行、问用户、还是拒绝；需要问用户时，由所在链路的"确认通道"把同一份事实摘要发给用户。

### 3.1 执行链路 ExecutionLane

标识一次工具调用来自哪条链路：`desktop | wechat | feishu | automation`（未来）。

- 链路是**策略的输入条件**，不是策略的*实现者*。例如"IM 链路写本地文件默认必须确认"是一条策略规则，而不是微信/飞书各写一份 `remoteAllowLocalWrite`。
- 链路携带上下文 `ExecutionContext`：lane、sessionId、会话级状态（RemoteWriteGrant、MCP 会话信任），以及**指令来源分类 origin**：

```ts
origin: {
  kind: 'direct-owner' | 'direct-other' | 'group';  // 本人单聊 / 他人单聊 / 群聊
  senderId?: string;                                // 经白名单校验后的身份
}
```

desktop 与 automation 链路的 origin 恒为 `direct-owner`（本人操作 / 本人创建的任务），origin 维度主要对 IM 链路有意义；消息入口规则（ingress）对 desktop 天然不适用（没有远程消息入口）。

**origin 是链路侧的事实提取**，与工具侧的事实提取层对称：工具内容的事实由提取器产出，会话来源的事实由链路适配器产出（只有 IM 适配器知道是单聊还是群、发送者是谁）。差异被吸收在分类器里：微信因 IM 方功能约束（只能绑定本人、无群聊）恒产 `direct-owner`；飞书可被拉进群，按实际会话类型产出。策略层因此无需感知两个 IM 的差异，规则用 origin 表达（如"群聊消息不响应"）而非用链路特判。现有 `remoteSenderAllowlist` 本质是 origin 维度的手写规则，迁移后成为消息入口规则的可视化配置。

### 3.2 工具调用描述 ToolInvocation

工具定义扩展**静态**元数据（收敛 `builtinToolNeedsConfirmation` / `getBuiltinToolRiskLevel` / MCP policy 等）：

```ts
interface ToolActionDescriptor {
  toolName: string;
  actionClass: 'read' | 'write' | 'execute' | 'outbound'; // 动作类别
  riskLevel: 'low' | 'medium' | 'high';                   // 基础风险
  extractors: string[];    // 该工具启用哪些事实提取器（见 §3.3）
}
```

- `actionClass` 取代散落的"是否写操作"判断：`read`（read_file/grep/list…）、`write`（edit/write_file）、`execute`（run_shell/run_script/run_lark_cli）、`outbound`（wechat_reply/send、浏览器 act、MCP 调用）。
- 工具定义只声明"我是什么、需要哪些事实提取器"，内容解析逻辑不在工具定义里。

### 3.2.1 管理范围：工具清单（防遗漏基线）

**"管"的判据**：凡是经 `toolChatLoop` 进入执行的工具调用，一律走 事实提取 → 策略判定 →（必要时）确认通道 的完整流程，没有例外通道。带状态的控制（如远程出站写预算门控 `evaluateOutboundWriteBudgetGate`）也纳入：额度读入 ExecutionContext、判定在策略层、记账在执行链路（§3.5"带状态控制流的归属"），不许留在主循环成为例外。以下清单是 P0–P3 迁移的核对基线，每期的验收都要对照打勾。

**内置工具（16 个，`src/shared/builtinToolDefinitions.ts`）：**

| 工具 | actionClass | 现状确认逻辑 | 迁移要点 |
|---|---|---|---|
| read_file / grep / list_directory | read | 不确认 | 策略表默认放行 |
| list_work_dirs / switch_work_dir / switch_session | read（导航类） | 不确认 | 同上 |
| edit_file / write_file | write | confirmMode（diff/direct/auto） | 路径分类器 + auto 审批器泛化 |
| run_script | execute | 静态分析 + 确认 | 脚本分析提取器迁移 |
| run_shell | execute | shellPrecheck + 信任命令 | 命令分解器 + 信任命令迁缓存 |
| run_lark_cli | execute | larkCliWriteNeedsConfirm（飞书链路）；写类子命令另受远程出站预算门控 | lark 子命令提取器；确认与否收敛进策略表；预算门控按 §3.5 读写拆分 |
| browser（navigate/act） | outbound | browserActionNeedsConfirmation + 域名信任 | 域名提取器 + 域名信任迁缓存 |
| browser_detect | read | 不确认 | 默认放行 |
| wechat_reply / wechat_send | outbound | 不确认（出站确认已移除）；IM 链路受出站写预算门控（超预算暂停任务并记账） | 出站硬禁规则（remoteDenyOutbound）迁链路硬约束；预算门控按 §3.5 读写拆分 |
| read_feishu_attachment | read | 不确认 | 默认放行 |

**动态来源（在范围内）：**

- **MCP 工具（管）**：动态注册、工具集可变，是本清单最容易遗漏的一类。收敛 `McpToolConfirmPolicy`（always/readonly-auto）与 `mcpSessionTrust` 会话信任：策略侧映射为 MCP server 级规则，会话信任迁为 `scope:'session'` 缓存条目（mcp-tool 键）；新增 MCP server 时按其声明的只读/写能力归入 actionClass。
- **技能/插件带来的新工具（管）**：任何未来注册进 toolChatLoop 的工具自动进入流程，注册时必须提供 ToolActionDescriptor（actionClass/riskLevel/extractors），缺元数据按"信息不足"处理——默认确认，不默认放行。

**明确不在本机制范围内**：UI 层非工具类操作的确认（如删除会话、清空数据的弹窗）；定时触发器的调度本身（cron）。

### 3.3 事实提取层 FactExtractor

**架构上独立的一层，位于策略层之前，是策略层唯一的事实来源。** 现有 `analyzeScriptContent` / `shellPrecheck` / `browserActionNeedsConfirmation` / `larkCliWriteNeedsConfirm` 可视为该层的原型，但现状只是"单工具单输入"的分析，目标形态要覆盖**复合事实**：

```ts
interface FactExtractor {
  id: string;
  appliesTo: string[];                    // 工具名或 actionClass
  extract(toolInput: unknown, env: EnvFacts): ContentFacts;
}

interface ContentFacts {
  toolName: string; actionClass; baseRiskLevel;
  signals: FactSignal[];                  // 见下
  summary: ConfirmSummary;                // 给确认通道展示的内容摘要
}
type FactSignal =
  | { kind: 'command-sequence'; commands: CommandFact[] }   // 分解后的子命令
  | { kind: 'path-target'; path: string; zone: PathZone }   // 路径分类
  | { kind: 'network-egress'; domains: string[] }
  | { kind: 'outbound-target'; channel: string; recipient?: string; domains?: string[] }
    // 出站目标身份：wechat_send 的接收者、lark-cli 子命令目标、MCP 出口域名
  | { kind: 'script-analysis'; signal: 'clean'|'suspicious'|'dangerous'; patterns: string[] }
  | { kind: 'extraction-failed'; reason: string };          // 提取失败本身也是事实
```

提取器按关注点组织、**跨工具复用**，而不是每工具一份：

- **命令分解器**：`cat foo && rm -rf /etc | sh` 拆解为子命令序列，逐个产出签名、重定向目标、管道下游；shell 信任匹配的粒度是子命令，不是整行字符串。
- **路径分类器**：目标路径 → `system-dir | outside-workdir | sensitive-file | workdir-normal`（敏感文件：密钥、凭据、数据库、系统配置）。对 `write_file`、`run_shell`、`run_script` 同样适用。
- **网络出口提取**：脚本/命令是否产生出站请求、目标域名清单。
- **脚本静态分析**：现有 `analyzeScriptContent` 迁移而来，输出 signal + 命中模式，**不再输出 deny/allow 判定**。
- **环境事实**（env）：操作系统、workDir 根、敏感目录清单，由平台层注入，提取器不各自硬编码路径。

三条原则：

1. **提取器只产出事实，不产出判定**。"dangerous 该拒绝还是确认"是策略层的事，按档位决定。
2. **提取失败/信息不足 → `extraction-failed` 信号 → 策略层必须回落到询问用户**（宁可多问，不可错放；不是放行的失败）。无法分解的组合命令、无法归类的路径，视同信息不足。
3. **事实同时服务决策与展示**：`summary` 放进 `ConfirmRequest`，确认卡片/IM 消息/自动任务审批队列呈现的是同一份内容摘要。最终防线是"审批者看到内容"，自动化链路里审批者异步看到的也是它。

**扩展性设计意图：事实是开放式集合。** 后续引入新分析能力（如脚本安全扫描模块、敏感信息检测、模型辅助内容审查）时，只需新增提取器并追加信号（如 `{ kind: 'security-scan', verdict: 'pass'|'fail'|'inconclusive', findings }`），策略层结构、确认通道、决策缓存、审计均不变。策略表对新信号是可选消费：未配置规则时信号默认不参与判定、只进 `summary` 展示——新分析能力因此可以"先只展示、不拦截"灰度上线，再逐步收紧为策略规则。

### 3.4 决策缓存 DecisionCache（原"授权/信任"的统一收敛）

**先明确两个层面的划分，这是本设计的核心概念边界：**

- **对外语义**：策略层对每一次工具调用**一事一议**地判定。不存在"某操作已被授权"的持久状态，也没有"授权过期"的说法。用户配置的规则（工具开关、链路约束、策略档位）是策略输入，不是授权。
- **内部实现**：策略层无法自动判断时才询问用户；用户的回答被**缓存**，后续键相同的调用命中缓存直接放行/拒绝，不再打扰。"过期"只是缓存失效策略（TTL/休眠），是纯内部实现细节，不构成对外安全承诺。

一句话区分：**策略层的判定永远是一事一议；所谓"授权过期"其实是我们记住了用户上次的回答，免得反复打扰。**

```ts
interface DecisionCacheEntry {
  id: string;
  key: CacheKey;                            // 缓存键：事实的规范化签名 + 记住范围档次
  decision: 'allow' | 'deny';
  lane: ExecutionLane | '*';
  scope: 'session' | 'persistent';          // "仅此一次"不落库（不记就是不记）
  createdAt: number; lastHitAt: number; hitCount: number;
  source: 'user-confirm' | 'settings' | 'migration';
  expiresAt?: number;                       // TTL，见 §8-Q1 结论
}

// 缓存键 = 事实种类 + 记住范围档次。问用户什么问题，就记住什么答案：
// 键的宽窄程度就是确认交互的语义。
type CacheKey =
  | { kind: 'shell-command'; verb: string; target?: string; level: 'exact' | 'verb+target' | 'verb' }
    // exact: 完整签名 "ping baidu.com"；verb+target: "ping <任意主机>"（target 为泛化维度标记）；
    // verb: "ping" 任意参数
  | { kind: 'domain'; domain: string; level: 'domain+action' | 'domain-any-action' }
  | { kind: 'path'; path: string; level: 'file' | 'directory' | 'zone' }
    // zone: 路径分类级，如 "workDir 内任意文件"
  | { kind: 'mcp-tool'; serverId: string; toolName: string }   // 固定档次
  | { kind: 'remote-write'; sessionId: string };               // 固定档次
```

**缓存与策略配置的边界（评审 B2 结论）**：决策缓存只记**用户回答的复用**（"问过用户，用户这么答的"）。**用户预先同意的声明**（如定时任务创建时声明"本任务涉及 write 类操作"）不是缓存，是**策略输入**（经 ExecutionContext 传入），由策略层的专门规则消费（见 §5.2 套餐 B）。两者不共用一个模型。

**lane 取值规则（评审 B1 结论）**：确认时新落的缓存条目，`lane` **默认取当前链路**；跨链路（`lane:'*'`）必须由用户在档次选择器中显式选择，且仅对低风险条目开放（medium/high 风险不开放跨链路记忆；**"低风险"指事实派生风险**，即综合事实信号后的实际风险，而非工具基础 riskLevel——例如 browser act 基础 medium，但目标域名低危时派生风险可为 low）。**跨链路条目无论风险一律设 TTL**（最长 365 天，不享受低风险免 TTL 待遇，见 §8-Q1），避免"宽范围 + 跨链路 + 永不过期"三者叠加。无论 lane 取何值，§3.5 第 1 步的链路硬约束都先于缓存评估，跨链路条目在硬约束的当前配置下不构成绕过面。

**记住范围的宽窄规则（核心语义，评审重点）：**

- **放宽维度必须来自事实的结构化字段**（命令动词、域名、路径分类），不允许自由文本模式。每类事实有固定的放宽阶梯，见 CacheKey 定义的 `level`。
- **确认界面上的"记住"是范围选择器**，每个选项如实描述将记住的内容：仅此一次 / 记住 `ping baidu.com` / 记住 `ping`（任意主机）。**默认选中永远是最窄可用档**（exact），更宽的档由用户主动选择。
- **放宽上限按风险封顶**：事实含 `suspicious` 信号、或路径分类为 `system-dir`/`sensitive-file` 时，最高只允许 `exact` 档；`verb`、`zone` 档不开放（如 `rm -rf /tmp/x` 可记住该命令本身，但永不开放"记住 rm"）。工具级（"run_shell 随便跑"）不作为档位存在。**`dangerous` 信号默认不进确认界面**——预置套餐下它在 §3.5 第 1 步硬拒绝；仅当自定义套餐把它下调为"询问"时才会走到确认，此时同样封顶 `exact` 档。
- **确认记忆管理界面按档展示**：用户能一眼看到"你记住的是 `ping *`（动词级）"而非一堆精确条目，过宽条目可辨、可一键清除。

其他规则：

- 现有 shell 信任命令、域名信任、MCP 会话信任、远程写授权全部迁移为缓存条目（各映射到上述固定档位），SQLite 单表存储。
- 设置页提供**确认记忆管理**（查看、清除条目）：清除 = 下次再问，不是"撤销权限"。
- 换绑/重置（现 `remoteAuthorizationRegistry` 代际）= 清空该链路的全部缓存条目。
- 缓存键一律用事实的规范化签名（子命令 token 签名、域名、路径分类），防止构造变体绕过。
- 缓存失效后命中时**先重走策略层**：事实层增强后可能已能自动判断，仍判断不了才问用户——过期机制因此几乎不产生额外打扰。

### 3.5 策略层 PolicyEngine

纯函数、可测试，输入完整上下文，输出三种判定之一（**不含副作用**：缓存的写入由执行链路的缓存管理器根据用户的回答完成，策略层只算判定结果，不写缓存）：

```ts
type Decision =
  | { type: 'auto-allow'; cacheKey?: CacheKey; reason: string }
  | { type: 'require-confirm'; riskLevel; facts: ContentFacts; timeoutMs: number }
  | { type: 'deny'; reason: string };
```

`require-confirm` 必须携带 `facts`（从内容提取出的事实），确认通道据此渲染展示内容；通道不允许在拿不到 facts 时发起"盲确认"。

**规则的三个评估时机（业务规则全部数据化，无硬编码策略）**：所有策略规则——包括现在写死在代码里的——都是策略表中的数据条目，代码只实现评估器，不承载任何具体规则：

```ts
interface PolicyRule {
  id: string;
  when: 'ingress' | 'exposure' | 'invocation'; // 消息入口 / 工具暴露 / 调用时机
  match: {
    lane?: ExecutionLane[];
    origin?: 'direct-owner' | 'direct-other' | 'group';  // 指令来源（§3.1）
    toolName?: string; actionClass?: string; signals?: string[];
    target?: 'owner-only';              // 出站目标约束（配合 outbound-target 信号）
  };
  action: 'deny' | 'allow' | 'ask';
  locked?: boolean;                   // 系统保护条目：UI 只读、自定义套餐不可调松
  reason: string;                     // 展示与审计
}
```

- **ingress 时机**：消息入口准入，发生在创建任务之前（"这条消息该不该被响应"）。例：`{ when:'ingress', match:{lane:['feishu'], origin:'group'}, action:'deny' }`——飞书群聊消息默认不响应（预置默认值，非 locked；未来支持群聊时放宽，并可叠加"群聊不返回敏感内容"类 invocation/exposure 规则组合）。
- **exposure 时机**：组装给模型的工具清单时按 lane/origin 过滤。现有 `toolsConfigRuntime.ts` 的 if 链（"微信未启用不给 wechat_*"、"远程会话不给 wechat_send"、"浏览器未启用不给 browser"）全部退化为 exposure 规则条目，由通用评估循环消费。例：`{ when:'exposure', match:{lane:['wechat','feishu'], toolName:'wechat_send'}, action:'deny', locked:true }`。
- **invocation 时机**：每次调用过下方 1→6 规则链。例："IM 写文件默认确认" = `{ when:'invocation', match:{lane:['wechat','feishu'], actionClass:'write'}, action:'ask' }`（非 locked，用户可放宽）。
- **"硬"从代码位置改为条目元数据**：安全底线（如远程禁用 `wechat_send`）是 `locked:true` 的内置条目，随预置套餐下发——保留底线效力，但可审计、可在设置中心展示、可随版本门控迁移。新增/调整这类规则是改数据，不是改代码发版。

规则按优先级评估（先否决后豁免再确认，均为 invocation 时机）：

1. **硬拒绝**（不经确认、直接拒绝）：`deniedTools`、locked 系统保护条目（如"远程会话禁用 `wechat_send`"，现为 exposure 规则的内置数据，见上）、出站硬禁（`remoteDenyOutbound`）、**链路硬约束**（见下）、事实中 `dangerous` 信号（预置套餐一律拒绝；自定义套餐下调为"询问"时改走第 6 步并受 §3.4 放宽封顶约束）、通道安全迁移保守覆盖层。
2. **缓存命中** → 直接放行/拒绝。缓存键是事实里的规范化签名（如子命令 token 签名、域名），不是原始输入字符串，避免构造变体绕过。**缓存命中在第 1 步之后，因此链路硬约束不可能被任何缓存条目（含 `lane:'*'`）绕过**——这是优先级顺序的安全不变量。
3. **能力声明内放行**（套餐 B，评审 v2 补充定位）：`ExecutionContext.declaredCapabilities` 非空时，调用的 actionClass 在声明清单内 → 按声明放行，超出 → 拒绝。**必须排在第 1 步之后**——任务声明了 execute 类，但具体脚本事实含 `dangerous`，仍被第 1 步拦截。
4. **自动审批器**（现 `writeFileAutoApproval` 泛化）：confirmMode=auto 且评估通过 → auto-allow；评估失败或信息不足**回落到询问用户**，绝不回落放行。
5. **链路软约束**：无安全含义、只影响体验的链路规则（如 IM 链路的超时长短、确认消息模板）。
6. **默认**：按 `actionClass + riskLevel + signals` 查策略表决定是否确认、超时多久；含 `extraction-failed` 的一律确认。

**链路约束的拆分（评审 B1 结论）**：有安全含义的链路约束属于第 1 步**链路硬约束**，每次调用、在任何缓存查询之前评估；只有体验类规则留在第 5 步（链路软约束）。判定标准：该约束被绕过时是否产生安全后果——是则为硬约束，否则为软约束。

**"硬"指评估位置，不指规则内容。** 架构强制的是：链路约束在规则链上占据固定位置，永远执行、先于缓存、不可被任何配置（含跨链路缓存条目、自定义套餐）摘除或绕过。这个位置里的**具体规则条目及其默认动作是策略配置**——产品给出保守的预置默认值，用户完全可以基于自己的威胁模型主动放宽（例如"我的微信只绑定我本人，指令来源可信"→ 把 IM 写文件从"确认"放宽为"放行"）。架构不为具体条目的松紧背书，只为"这类判断不可能被静默跳过"背书。

预置的默认条目示例（均为默认值，非架构规矩）：

- **IM 链路写本地文件默认必须确认**（现状 `remoteAllowLocalWrite=false` 语义：写操作触发 IM 确认，回 Y 才执行）。
- **automation 链路高风险默认拒绝**。
- 真正的硬拒绝例子是**出站硬禁**（`remoteDenyOutbound`）：判定为拒绝、不提供确认选项——它同样是默认配置而非架构强制，只是放宽它的入口应该更高摩擦（独立开关 + 风险警示 + 二次确认，见 §4）。

**带状态控制流的归属（评审 B4 结论）**：凡带额度/记账性质的控制（现状：IM 出站写预算门控 `evaluateOutboundWriteBudgetGate`），拆成两半——**读**（当前额度余量）作为 ExecutionContext 的一部分进策略层输入，由一条纯函数规则消费；**记账**（消耗额度，`recordOutboundWrite`）归执行链路在判定通过后执行。这与"读缓存命中 / 确认后写缓存"是对称模式：**策略层永远纯函数，一切状态读写都在执行链路侧**。P1 重构时此门控一并按此拆分，不允许留在主循环成为例外通道。

预算耗尽的判定**不是纯拒绝**（评审 v3）：现状是带"继续 / 回桌面 / 停止"选项的交互暂停（`toolChatLoop.ts:2109`）。迁移后映射为 require-confirm 的变体——用户答"继续"= 提额续跑（执行链路调整额度后重试），答"停止"= 撤销任务。此行为等价性写入 P1 验收（P1 承诺不引入用户可见变化）。

策略表本身是配置（默认内置，设置中心可视化），取代硬编码名单。所有规则输出 `reason`，写入 `ToolCallRecord` 供审计与 UI 解释（"为什么没问我/为什么拒绝"）。

### 3.6 确认通道 ConfirmationChannel

```ts
interface ConfirmationChannel {
  request(req: ConfirmRequest): Promise<ConfirmOutcome>; // approved/rejected/timeout
  cancel(requestId: string): void;
}

interface ConfirmRequest {
  facts: ContentFacts;                      // 展示内容 = 决策依据
  riskLevel: 'low' | 'medium' | 'high';
  memoryTiers: MemoryTier[];                // 可选的记住范围档次（由策略层按 §3.4 规则算出）
  timeoutMs: number;
}
interface MemoryTier {
  key: CacheKey;                            // 选中该档后写入的缓存键
  label: string;                            // 如实描述将记住什么："记住 ping（任意主机）"
}
// ConfirmOutcome 携带用户选择的档次（或"仅此一次"），由执行链路的缓存管理器据此写缓存
//（策略层保持纯函数，不写缓存，见 §3.5）。
// 拒绝方向同样可记：用户选 N 时档位标签写"以后都拒绝 ping（任意主机）"，
// 落 decision:'deny' 条目；与 allow 方向同一套档位结构，文案必须带"拒绝"字样。
```

- `DesktopChannel`：现 `toolConfirmRegistry` + 确认卡片，原样包装；确认卡片的"信任/记住"勾选改为范围选择器。
- `ImChannel`：现 `PendingRequestRegistry` + `parseImConfirmReply`（`Y/N/信任` 协议），**飞书微信合并为一个实现**，按链路参数化文案与发送函数——消灭 `feishuConfirmManager` / `weChatConfirmManager` 同构重复。IM 文本协议扩展为多档：`Y <id>` / `N <id>` / `记1 <id>` / `记2 <id>`…（编号对应 memoryTiers 顺序），超出 IM 表达力的档位只在桌面卡片开放。**IM 确认消息必须内嵌每个档位的人类可读描述**（如"记1 = 记住 ping（任意主机）"），不允许只发编号让用户盲选。
- `AutomationChannel`（未来）：自动任务的确认请求进入**待审批队列**（持久化），可在桌面任务面板或 IM 异步审批。
- 超时统一由策略表给出（`Decision.timeoutMs`），通道只执行；`timeoutMs` 可取 `null` 表示无超时（如 AutomationChannel 的审批队列场景）。

### 3.7 与执行层沙箱的关系（含提权决策点）

> **前瞻性设计，不属于本框架迭代范围。** 沙箱是独立的未来规划，有自己的开发周期；本节仅约定它与本框架的接口关系，确保沙箱落地时本框架无需改结构。§7 的 P0–P5 不含任何沙箱/提权工作项；正文中为兼容性预留的类型字段（如 `allowElevation`、`sandbox-escape` 信号）标记为 reserved，当期只定义不实现。

未来文件/命令操作引入沙箱时，与本框架的分工：**沙箱是执行层的物理边界（管"能不能做到"），本框架是决策层（管"该不该做"）**。

- **沙箱在流程下游兜底**：策略层判定放行 → 工具执行 → 沙箱在 OS/文件系统层限制破坏范围。策略误判、缓存被绕过、规则配错时，伤害不出沙箱。它是最后一道安全墙，不依赖任何配置正确性。
- **沙箱边界是事实层的事实来源**：在 PathZone 之外叠加一个独立的沙箱位置维度 `in-sandbox / sandbox-boundary / out-of-sandbox`（叠加而非替换，见本节末）；沙箱内可逆操作的派生风险整体下调，自动放行覆盖面扩大（如 workDir 内写文件可从"默认确认"演进为"默认放行"）。
- **沙箱配置不进策略表**：挂载目录、网络出口是环境部署属性，由运行环境定义；策略层只消费它产出的事实。原则：策略层表达意图，沙箱表达物理现实，事实层负责翻译。避免"策略允许但沙箱挡着"的双层配置不一致。

**提权决策点（沙箱外执行申请）由框架管理，建模为标准判定而非新机制：**

1. 沙箱拒绝执行时返回结构化错误（`sandbox-denied` + 原因），Agent 显式发起提权重试（`run_shell`/`run_script` 入参 `sandbox: 'default'|'elevated'`），并在确认请求中说明沙箱为何跑不了。**提权重试是一次新的完整判定（新的 invocation，走完整规则链），不是原判定的续期或状态机分支。**
2. 提取器产出信号 `{ kind:'sandbox-escape', blockedReason }`，同供决策与展示。
3. 策略默认：提权 `ask` 且 riskLevel 强制 high；**仅桌面链路开放提权确认**——IM 链路（async-user）上收到提权请求直接拒绝并引导回桌面处理（最高危操作不用 IM 文本确认）；automation 链路默认拒绝，只能依赖任务创建时能力声明中的 `allowElevation`（§5.2，仅 execute 类）；事实含 `dangerous` 的命令不开放提权确认（第 1 步直接拦）。
4. 可记忆但**封顶 exact 档**（评审 v4：提权=沙箱外执行是最高危操作类，记忆上限必须与 §3.4"危险操作只记精确实例"对齐——`npm install` 的 postinstall 脚本可执行任意代码，"记住 npm 类命令沙箱外执行"等于"记住任意代码沙箱外执行"，故 verb/verb+target 档均不开放）；automation 链路不开放提权记忆。
5. 提权执行在 `ToolCallRecord` 打标，审计可区分沙箱内/外执行。

**路径分类是叠加不是替换**（评审 v4）：§3.3 的 PathZone 四分类（system-dir/outside-workdir/sensitive-file/workdir-normal）保留不动；沙箱位置（in-sandbox / sandbox-boundary / out-of-sandbox）作为**独立的第二维度**叠加进事实。敏感性与沙箱位置无关（workDir 里的密钥文件在沙箱内依然敏感），§3.4 的封顶规则继续引用 PathZone，沙箱维度用于下调沙箱内可逆操作的派生风险。

### 3.8 安全审计日志（评审补充）

确认机制是安全模块，每一次判定、每一次用户回答、每一次缓存读写都是审计证据。本节定义独立的**安全审计日志**，与常规功能日志（Agent-*.log、FeishuCli-*.log、WeChatCli-*.log）**物理隔离**：

```ts
interface SecurityAuditEvent {
  ts: number;                              // 事件时间
  event: SecurityAuditEventKind;           // 见下
  lane: ExecutionLane; origin?: OriginInfo;
  sessionId: string; requestId?: string;   // requestId = 确认请求短号
  toolName?: string; actionClass?: ActionClass; riskLevel?: RiskLevel;
  factsSummary?: string;                   // ConfirmSummary 的纯文本摘要（事实，非原始输入全文）
  signals?: string[];                      // 命中的信号 kind 列表
  decision?: 'auto-allow' | 'require-confirm' | 'deny';
  ruleId?: string; reason?: string;        // 命中规则与原因（审计"为什么"）
  outcome?: 'approved' | 'rejected' | 'timeout' | 'cancelled';
  memoryTier?: string;                     // 用户选择的记住档位（CacheKey 的规范化签名文本）
  cacheKey?: string;                       // 规范化签名文本，不落原始输入
  actor: 'user' | 'system' | 'migration';  // 事件触发方
}

type SecurityAuditEventKind =
  // 判定类：每次工具调用的策略判定结果（三个时机全覆盖）
  | 'policy.decision'          // invocation 判定（含 ruleId + reason）
  | 'policy.deny-ingress'      // 消息入口拦截
  | 'policy.deny-exposure'     // 工具暴露过滤（仅记录因策略而非普通开关的过滤）
  // 确认交互类
  | 'confirm.request' | 'confirm.outcome'   // 含通道、超时值、用户所选档位
  // 缓存类
  | 'cache.hit' | 'cache.write' | 'cache.clear' | 'cache.expire-dormant'
  | 'cache.generation-reset'   // 换绑/重置清空链路条目
  // 配置变更类（改安全规则本身就是高敏操作）
  | 'settings.policy-change'   // 套餐切换、规则动作/参数修改、链路硬约束开关（记录新旧值）
  | 'settings.tool-toggle'     // deniedTools 变更
  // 其他
  | 'budget.exhausted'         // 出站写预算耗尽（含续跑/撤销结局）
  | 'migration.*';             // 信任数据迁移逐条记录
```

硬性要求：

1. **独立文件，物理隔离**：写独立文件 `SecurityAudit-{YYYYMMDD}.log`（JSON Lines），目录与 Agent 日志相同（开发模式 `{项目根}/logs/`、打包模式 `{workDir}/.agent/logs/`），**绝不混入** Agent-*.log / FeishuCli-*.log / WeChatCli-*.log。功能日志面向排障、可随手清空；安全审计日志面向追责与回溯，保留策略独立（默认保留 180 天，设置页可调）。
2. **判定即记录**：策略层三个时机（ingress/exposure/invocation）的每一次非平凡判定都落事件；`auto-allow` 是常规放行可采样或降级为 debug 级，但 `deny`、`require-confirm`、`confirm.outcome`、全部 cache/settings 事件**必须落**。安全不变量（硬约束先于缓存、危险信号封顶 exact）被触发的路径必须可从日志复现。
3. **落事实不落内容**：事件携带 `factsSummary` 与信号 kind 列表，写入前经 `sanitizeForLog` + 安全审计字段规则脱敏，**不落用户消息正文、命令全文之外的敏感内容、token、secret、API Key**。命令签名取规范化签名（与缓存键同源），保证"日志里看到的键"与"缓存里的键"可对账。
4. **记录不阻断执行**：日志写入异步缓冲、批量落盘；写失败降级为记一条 agentLogger 错误并重试，**绝不因日志故障阻断或改变工具判定结果**。策略层保持纯函数——事件由执行链路侧（主循环、通道、缓存管理器、设置处理器）在拿到判定结果后发出，与"写缓存在执行链路"同侧。
5. **确认交互全程留痕**：`confirm.request` 与 `confirm.outcome` 用同一 `requestId` 关联；超时、桌面代答、IM `记N` 选择均落到 `confirm.outcome` 的扩展字段。
6. **配置变更必记**：套餐切换、规则动作修改、链路硬约束启停、deniedTools 变更、确认记忆清除，逐条落 `settings.*` / `cache.clear` 事件并记录新旧值——安全配置的每一次放松都有据可查。

与既有审计渠道的关系：飞书/微信的 `{userData}/logs/feishu-audit.log` / `wechat-audit.log` 是 IM 操作审计，继续存在；安全审计日志是确认框架的判定与授权证据，两者分工不同、互不替代。

## 4. 设置中心设计

新增一个"工具与安全"设置页（取代现有 ToolsSettingsTab 中确认相关部分，收敛 Browser/Shell/RemoteIM 中的确认项），按语义分四区：

1. **策略套餐**：每条链路选择一个套餐（§5.2）。提供若干预置套餐（严格/标准/宽松）+ 一个**自定义套餐**：规则链与优先级由系统固定（§3.5 的 1→6 顺序不可改、规则不可增删），用户可编辑每条规则的**处理动作**（拒绝/允许/询问）与参数（超时、适用链路）。自定义有下限（评审 B3 结论）：产品安全底线规则（`deniedTools`、安全迁移保守层、出站硬禁）**以及链路硬约束**不在自定义套餐的可编辑范围，只能看不能改，自定义不能把底线调松。
   - **链路硬约束的启停是独立的链路级开关**（沿用现有 `remoteAllowLocalWrite` 类设置语义），不在套餐规则编辑器内：开关带风险警示文案与独立的二次确认。无论开关状态如何，第 1 步硬约束检查永远执行——开关只是改变该规则的判定结果，不存在"把规则从链上摘掉"的配置方式。由此 §3.4 的安全不变量精确化为：*跨链路缓存条目在链路硬约束的当前配置下不构成绕过面*。
2. **确认模式**：全局 diff/direct/auto（保留现有语义与 auto 二次确认）。
3. **工具开关**：逐工具启用/禁用（deniedTools 展示不变）。
4. **确认记忆管理**：决策缓存统一列表（来源、作用域、链路、命中统计，支持清除——清除即"下次再问"，非撤销权限），取代散落在 Shell/Browser/MCP 各处的信任管理 UI。飞书/微信 Tab 可留链路约束的快捷入口，但读写同一份配置。
5. **安全审计记录**：只读查看安全审计日志（§3.8，按时间/链路/事件类型/工具过滤），以及保留天数设置；清除确认记忆等操作在此同样留痕。

配置存储仍在 SQLite `configs` 表 + 新增 `decision_cache` 表；`RemoteImCommonConfig` 中的确认字段映射为套餐规则覆盖，旧字段走一次性迁移（沿用现有 `remoteSecurityConfigVersion` 版本门控模式）。

## 5. 场景约束与预制套餐（含自动任务链路预留）

**分层原则：策略层不规定任何链路的业务流程**（何时问人、在哪配置），它只识别业务场景的**约束类型**，并针对约束类型提供自洽的**预制策略套餐**；业务层在自己的流程中选择合适的时机让用户选套餐。

### 5.1 约束类型

每条链路声明自己的约束类型，作为策略输入：

- `sync-user`：有同步用户在场（桌面），可即时确认。
- `async-user`：用户可异步回复、分钟级延迟（IM 链路）。现有 IM 文本确认即该约束的默认套餐，超时拒绝是兜底。
- `no-user`：执行过程无法向用户即时寻求决策（自动任务/定时任务的本质约束）。

### 5.2 `no-user` 约束下的预制套餐

每档套餐是一套预制的策略规则组合，策略层保证每档在该约束下**自洽**（不存在"该问人但问不到"的悬空状态），并对外暴露明确的安全语义：

- **套餐 A｜只读放行**：read 自动通过，write/execute/outbound 一律拒绝。适合信息汇总汇报类任务。
- **套餐 B｜能力声明**：业务在配置任务时展示将涉及的操作类别，用户确认后**作为该任务 ExecutionContext 的策略输入**（`declaredCapabilities`）传给策略层，由一条专门规则"能力声明内放行"消费：运行期调用的 actionClass 在声明清单内 → 按声明放行；超出清单 → 拒绝。适合能力边界清晰的固定任务。**注意：它落成的是任务配置（策略输入），不是决策缓存条目**——缓存只记用户回答，能力声明是预先同意，两者边界见 §3.4。
  - **声明的作用域维度按"事实可见性"拆分**（评审 B5 结论）：核对能发生的前提是事实里看得见目标。MCP server 在自有进程里连什么域名、写什么文件，调用边界不可见——**MCP 的声明维度是 `serverId`**（"允许知乎 MCP server、GitHub MCP server"，可核对、可如实展示），对 MCP 不承诺域名维度。**domains/recipients 只对能产出目标信号的工具生效**：browser（URL 可见）、run_lark_cli（子命令目标可提取）、wechat_send（接收者可见）。
    ```ts
    declaredCapabilities: {
      actionClass: ActionClass;
      constraints?: { serverIds?: string[]; domains?: string[]; recipients?: string[] };
      allowElevation?: boolean;   // reserved（沙箱落地时启用，§3.7）：允许申请沙箱外执行，仅 execute 类有意义
    }[]
    ```
    创建任务时用户确认的是"MCP 读取（知乎、GitHub 两个 server）、本地写、上传飞书文档、推送微信给本人"——逐条看得懂、管得住。运行期由事实信号核对：MCP 调用核对 serverId，browser/lark/wechat 核对 `outbound-target`/`network-egress`；落在声明外 → 拒绝并在任务面板标记。提取不出目标的场景（非 MCP 工具但无目标信号）按"宁可多问"原则回落拒绝/标记。
  - 配套 locked 预置条目：`automation` 链路 `wechat_send` 接收者必须为 owner（`match:{lane:['automation'], toolName:'wechat_send', target:'owner-only'}`）——远程链路"禁用 wechat_send"的规则不适用于 automation（无入站消息可 reply，只能主动推送），但推送对象必须锁死为任务创建者本人。
- **套餐 C｜异步审批**：确认请求挂入持久化审批队列，任务挂起等待，批准后继续。适合时效不敏感、价值高的写操作。
- **套餐 D｜宽松**：自动审批器全权判定，判断不了的一律拒绝（宁可多拦，不可错放），全程不问人。

业务层职责：在某个环节**显式完成套餐选择**（定时任务可在任务创建时配置，也可在设置页定全局默认档）；不允许默认隐式落到宽松档。

### 5.3 新链路接入清单（架构验证点）

1. 注册 lane 值及其约束类型（如 `automation` + `no-user`）。
2. 从该约束类型的套餐中选默认集合；如需新交互（审批队列），实现对应 ConfirmationChannel（如 `AutomationChannel`）。
3. 无需新增策略代码；套餐即策略规则组合，缓存、审计、设置中心全部复用。

定时触发器本身（cron 调度）不在本文档范围，见 `background-task-execution-layer-design.md` 的后续演进。

### 5.4 场景推演：每日简报定时任务

场景：定时任务自动通过 MCP 汇总知乎/GitHub 内容 → 汇总成本地文档 → 上传飞书文档 → 微信推送每日简报给本人（附飞书文档链接）。

推演结论（lane=`automation`，origin=任务创建者即本人，约束 `no-user`，套餐 B）：

| 步骤 | 机制 | 结论 |
|---|---|---|
| MCP 抓取知乎/GitHub | exposure 规则放行已注册 MCP server；invocation 归 read，**按 serverId 核对声明**（MCP 边界看不到域名，域名维度不承诺，见 §5.2） | ✅ |
| 本地写文档 | write_file → write，在能力声明内 | ✅ |
| 上传飞书文档 | run_lark_cli 写类子命令 → outbound，在声明内且目标核对通过 | ✅ |
| 微信推送简报 | wechat_send，接收者锁定 owner（locked 条目）+ 声明 recipients 核对 | ✅（修补后） |

**推演暴露并修复的两个缺口：**

1. **出站目标身份缺失**：远程链路"禁用 wechat_send"的前提是"有入站消息才有合法接收者"，定时任务是主动推送、无入站消息。修补：事实新增 `outbound-target` 信号（接收者/目标域名），规则匹配加 `target` 维度，预置 locked 条目"automation 链路 wechat_send 接收者必须为 owner"。
2. **能力声明粒度过粗**：actionClass 级声明（"允许 outbound"）等于对任意外部目标出站。修补：声明升级为带作用域参数（domains/recipients），创建任务时用户确认的是"允许 outbound 到 zhihu.com/github.com/飞书/我本人"；运行期事实信号核对实际目标，超出 → 拒绝并在任务面板标记。

未修补前该场景在微信推送一步会被"远程禁用 wechat_send"的规则误伤（automation 不是 remote，规则本不应命中——推演同时验证了链路维度隔离的正确性）。

### 5.5 场景推演：微信远程开发任务（远程指令代理）

场景：用户通过微信要求 Agent 调用 Codex MCP 实现一个功能。远程指令代理模块做意图识别、目标拆解，回复执行计划简报给用户确认；确认后调用 Codex MCP 执行开发，完成后汇总结果简报回复微信。

推演结论（lane=`wechat`，origin=`direct-owner`，约束 `async-user`）：**无阻断性问题**。

| 环节 | 机制 | 结论 |
|---|---|---|
| 微信入站指令 | ingress 规则，origin 恒为 direct-owner | ✅ |
| 计划简报 / 结果简报 | `wechat_reply`（outbound），默认放行 + 出站预算记账 | ✅ |
| 用户确认计划 | 远程指令代理的业务层确认，不走 ConfirmationChannel | ✅ |
| 调用 Codex MCP | invocation 规则链；会话套餐由指令代理模块配置期选定 | ✅ |
| 任务中用户取消 | `chatCancelRegistry`，与确认框架正交 | ✅ |

**两个接口约定（本场景对框架的要求，非阻断）：**

1. **指令代理模块在配置期为远程指令会话选择套餐，消解双重询问（主路径）。** 模块的产品设计应声明"来自远程的指令使用哪个策略套餐"——例如选一个"计划确认后不再逐工具询问"的套餐（Codex MCP 调用归 allow，写/执行操作在确认过的计划范围内放行）。用户确认计划时会话已处在正确的套餐中，第 ④ 步不会再问。运行期机制（计划确认后写 session 缓存条目、或注入会话 `declaredCapabilities`）是该套餐内部的实现手段，由套餐/框架承接，不要求业务模块每次自行翻译。若模块产品设计未做此配置，默认规则才会导致"刚确认过计划又问一遍"的双层确认。
2. **委托执行的边界即能见度边界。** Codex MCP 内部自主执行的写文件/命令对我们的流程不可见，事实提取层只能在 MCP 调用边界产出薄事实（server 身份、任务描述、操作类别）。由此得出正式结论（评审 B5）：**MCP 的能力声明维度是 serverId，域名/接收者维度对 MCP 不承诺**；域名/接收者核对只对能产出目标信号的工具生效（§5.2）。本场景中实质的用户审核发生在计划确认环节（信息量比单命令确认卡片大），工具边界确认只是形式。责任划分：Codex 会话内部的安全由 Codex 自身的沙箱/确认机制负责；我们的框架负责边界处的身份、声明核对与审计记录。

**推演前提（评审 v3 非阻断-2）**：现状远程会话拿不到 MCP 工具（`toolChatLoop.ts:547-549`，MCP 快照仅桌面注入）。上表"调用 Codex MCP ✅"的前提是远程指令代理模块按 §3.5 配置了 exposure 规则，把 Codex MCP server 暴露给 wechat 链路的该类会话——这是模块接入时的配置动作，不是默认行为。

## 6. 智能判断演进路径

顶层设计为后续智能确认留出单一切入面——策略层的"自动审批器"环节：

- 现状：`writeFileAutoApproval` 仅覆盖桌面写文件。
- 第一步（泛化）：auto 模式下所有 actionClass 都有评估器，输出 allow/confirm/deny + reason。
- 第二步（风险评估升级）：评估器可替换为更强的实现（规则引擎 → 启发式 → 模型辅助分级），策略表不变，调用面不变。
- 第三步（自适应）：基于用户历史批准/拒绝统计，建议写入缓存（"你已连续 5 次批准同类操作，是否以后不再询问？"），由用户确认后落成缓存条目。

全程不改主循环、不改通道、不改设置结构。

## 7. 迁移与实施路线（建议分期）

| 阶段 | 内容 | 风险 |
|---|---|---|
| P0 概念收敛 | 定义 ToolActionDescriptor / ContentFacts / Decision / DecisionCache 类型于 `src/shared/`；`builtinToolNeedsConfirmation` 等改为读元数据，行为不变 | 低，纯重构 |
| P1 策略引擎 | 抽出 toolChatLoop 内联判断：内容分析逻辑（脚本/命令/路径/域名）下沉为事实提取层，判断逻辑上收为策略层；主循环只做 提取 → 判定 → 执行。**注意实际控制散布范围不限于 1280-1662**：`evaluateRemoteToolBlock`（:917）、shell 预检（:1022-1070）、出站预算门控（:2092-2115）都在迁移范围内；`toolsConfigRuntime.ts` 的工具过滤 if 链一并迁移为 exposure 规则条目 | 中，需补齐现有分支的单测（该段已有测试基础）。**验收标准含"变体绕过测试集"**：shell exact 档签名的规范化必须覆盖环境变量前缀（`FOO=1 cmd`）、`cd x && cmd`、引号/空白变体——这些变体不得命中缓存 |
| P2 IM 通道合并 | 飞书/微信 ConfirmManager 合并为 ImChannel；超时入策略表；链路适配器实现 origin 分类（微信恒 direct-owner，飞书按会话类型），`remoteSenderAllowlist` 迁移为 ingress 规则配置 | 中，注意绑定 owner、发送者白名单等差异由 origin 分类吸收 |
| P3 缓存统一 | decision_cache 表 + 五类豁免迁移 + 确认记忆管理 UI | 高（数据迁移），沿用现有版本门控模式 |
| P4 设置中心 | 新设置页，旧入口改为快捷链接 | 低 |
| P5 automation 链路 | 按 §5 接入 | 设计验证点 |

每期都可独立发布、行为可回归；P0/P1 不引入任何用户可见变化。**沙箱与提权（§3.7）是独立规划，不在 P0–P5 内**；相关字段（`allowElevation`、`sandbox-escape` 信号）当期仅以 reserved 形式落类型，不产生任何运行行为。

## 8. 决策记录（原待决策问题，已全部结论）

1. ~~Grant 是否需要过期时间~~ **已结论**：澄清为两层模型——对外一事一议无授权概念；过期只是决策缓存的内部失效策略。采用：persistent 条目按风险分级 TTL（execute 类 90 天，read/低风险类无 TTL）+ 180 天未命中自动休眠 + 失效后先重走策略层、仍判断不了才问用户。补充（评审 v2）：跨链路条目无论风险一律设 TTL（最长 365 天），不适用低风险免 TTL。
2. ~~automation 链路初版策略~~ **已结论**：重构为"约束类型 + 预制套餐"模型（§5）——策略层只识别场景约束（sync-user/async-user/no-user）并提供自洽的套餐组合（只读放行/能力声明/异步审批/宽松），业务流程（何时让用户选套餐）由业务层决定，策略层不规定；不允许隐式默认宽松档。
3. ~~确认卡片上"信任"勾选暴露到什么粒度~~ **已结论**：明确为"记住范围分档"模型（§3.4）——粒度阶梯由事实的结构化字段决定（shell：exact/verb+target/verb；域名：domain+action/domain-any-action；路径：file/directory/zone），确认界面"记住"是范围选择器且默认最窄档；放宽上限按风险封顶（dangerous/suspicious/敏感路径最高 exact 档，工具级永不开放）；IM 通道用 `记N <id>` 协议，高档位仅桌面开放。
4. ~~策略表是否允许用户自定义规则~~ **已结论**：采用"预置套餐 + 一个自定义套餐"（§4 第 1 区）。规则链与优先级系统固定、不可增删改序；自定义套餐可编辑每条规则的处理动作（拒绝/允许/询问）与参数（超时、适用链路）。产品安全底线规则（deniedTools、迁移保守层、出站硬禁）不可编辑，自定义不能调松底线。补充（评审 v2-B3）：链路硬约束同样不可在套餐编辑器内修改，其启停只能走独立的链路级开关（带二次确认）。
5. ~~deprecated 字段清理时机~~ **已结论**：不单独排期，开发到对应模块时顺手清理代码与类型引用（`resolveRemoteConfirmPolicy` 随 P1，`wechatSendRequiresConfirm`/`remoteWechatConfirm` 随 P3）；数据库历史值不做物理删除。
6. ~~安全审计日志如何落~~ **已结论**：独立 `SecurityAudit-{YYYYMMDD}.log` 文件（JSON Lines），与功能日志物理隔离（§3.8）；判定/确认/缓存/配置变更四类事件全覆盖，落事实摘要不落用户内容，异步缓冲写盘不阻断执行；设置中心提供只读查看入口（§4 第 5 区）。

### 评审 v1 修订记录（2026-08-29，对应 `docs/review/tool-confirmation-top-level-design-review-v1.md`）

- **B1（阻断）**：链路约束拆分为硬/软两类——有安全含义的链路约束（IM 写本地文件默认必须确认、automation 高风险拒绝、出站硬禁）并入 §3.5 第 1 步硬拒绝，先于缓存查询评估；软约束（体验类规则）留第 4 步。补充缓存条目 lane 取值规则：默认当前链路，跨链路需显式选择且仅低风险开放（§3.4）。
- **B2（阻断）**：套餐 B（能力声明）落点从缓存条目改为任务配置中的策略输入（ExecutionContext.declaredCapabilities），由策略层专门规则消费；§3.4 补充"缓存只记用户回答，预先同意是策略输入"的边界。
- 非阻断 1-6 全部采纳：dangerous 信号在预置套餐硬拒绝、不进确认（§3.4 封顶规则对齐）；策略层保持纯函数、写缓存归执行链路缓存管理器（§3.5/§3.6）；`scope:'once'` 移出缓存表；IM `记N` 消息必须内嵌档位描述（§3.6）；超时措辞统一为 `timeoutMs: number | null`（§3.6）；P1 验收新增变体绕过测试集（§7）。

### 评审 v2 修订记录（2026-08-29，对应 `docs/review/tool-confirmation-top-level-design-review-v2.md`）

- **B3（阻断）**：链路硬约束加入自定义套餐的不可编辑底线清单，只能看不能改；其启停走独立的链路级开关（沿用 `remoteAllowLocalWrite` 类设置语义 + 风险警示 + 二次确认），第 1 步检查永远执行、开关只改变判定结果。安全不变量精确化为"跨链路缓存条目在硬约束的当前配置下不构成绕过面"（§4）。
- **B4（阻断）**：带状态控制流（IM 出站写预算门控）按读/写拆分——额度余量读入 ExecutionContext 供纯函数规则消费，记账归执行链路在判定通过后执行；与"读缓存/写缓存"对称，策略层保持纯函数（§3.5）。§3.2.1 基线表补 `wechat_reply/wechat_send/run_lark_cli` 的预算门控现状；P1 范围修正为 toolChatLoop 全部散布点（:917、:1022-1070、:2092-2115 等）。
- 非阻断 1-4 全部采纳：能力声明规则定位于第 3 步（硬拒绝之后，§3.5）；"低风险"定义为事实派生风险（§3.4）；跨链路条目一律设 TTL（§3.4、§8-Q1）；拒绝方向记忆档位文案规则（§3.6）。

### 评审 v3 修订记录（2026-08-29，对应 `docs/review/tool-confirmation-top-level-design-review-v3.md`）

- **B5（阻断）**：§5.4 与 §5.5 对 MCP 事实可见性的矛盾——能力声明的作用域维度按"事实可见性"拆分（§5.2）：MCP 声明维度为 `serverId`（调用边界可核对），域名维度对 MCP 不承诺；domains/recipients 只对能产出目标信号的工具（browser、run_lark_cli、wechat_send）生效。§5.4 表格改为按 server 核对，§5.5 接口约定 2 落成正式结论。
- 非阻断 1-5 全部采纳：预算耗尽映射为 require-confirm 变体（继续=提额续跑/停止=撤销），行为等价性写入 P1 验收（§3.5）；§5.5 表格标注前提（现状 MCP 仅桌面注入，需指令代理模块配置 exposure 规则）；desktop/automation 链路 origin 恒为 `direct-owner`（§3.1）；文档范围句补充 ingress/exposure 时机（文头）；§5.4 末尾不存在序号的引用修正。

### 评审 v4 修订记录（2026-08-29，对应 `docs/review/tool-confirmation-top-level-design-review-v4.md`）

- **B6（阻断）**：§3.7 与正文接线三处——① `allowElevation` 字段补入 §5.2 的 `declaredCapabilities` 类型（仅 execute 类有意义）；② 提权记忆档位从 verb 收紧为 **exact 封顶**（与 §3.4"危险操作只记精确实例"对齐；npm postinstall 可执行任意代码，宽档等于"记住任意代码沙箱外执行"）；③ 路径分类明确为**叠加**：PathZone 保留，沙箱位置作为独立第二维度，§3.4 封顶规则引用不受影响。
- 非阻断 1-2 采纳：提权确认仅桌面链路开放，IM 链路收到提权请求直接拒绝并引导回桌面；明写"提权重试是一次新的完整判定（新 invocation），不是原判定续期"。
