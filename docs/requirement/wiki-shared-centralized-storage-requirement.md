# LLM Wiki 集中共享存储（共享记忆库）— 需求与技术方案

**版本：** 1.12
**日期：** 2026-10-10
**状态：** 已通过（可实施；v4 复审通过无阻断；v1.12 为开发计划复审触发的展示数据源补丁，基线仍然有效）
**关联文档：** [llm-wiki-requirement.md](./llm-wiki-requirement.md)、[wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md)、[评审报告](../review/2026-10-09-wiki-shared-centralized-storage-requirement-review.md)、[复审报告 v2](../review/2026-10-09-wiki-shared-centralized-storage-requirement-review-v2.md)、[复审报告 v3](../review/2026-10-09-wiki-shared-centralized-storage-requirement-review-v3.md)、[复审报告 v4](../review/2026-10-10-wiki-shared-centralized-storage-requirement-review-v4.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-10-09 | 初稿：Wiki 存储从每个 workDir 迁移至 userData（SQLite 同目录），全工作目录共享同一记忆系统 |
| 1.1 | 2026-10-09 | 按评审修订：**B1** 远程 lane wiki 写豁免设计；**B2** §7 重写为探测层 + permit + 执行层双侧接入（permit 制架构）；**B3** userData 敏感根与审批分级语义；**B4** 自定义 rootPath 存量迁移与只读别名；**B5** P1+P2 同版本发布硬约束；**B6** fileIpc 子通道逐一处置表；落实 I1–I7、F1–F8；新增 §3.5 门禁架构现状与附录 A 修订对照表 |
| 1.2 | 2026-10-09 | 复审 v2 通过；并入非阻断建议：**S1** 读侧对称门禁 `remote-outside-read-deny` 显式说明 + 远程读回归用例；**S2** 挂载启用期间 workDir 侧根扫描排除挂载前缀实体目录的去重规则；**S3** 迁移检测的历史自定义根边界注明 + 手工指定入口 |
| 1.3 | 2026-10-09 | 按复审 v3 修订：**B7（阻断）** 读侧敏感根 zone 未豁免——豁免落点上移到共享分类器 `classifyReadPathZone`（读写探测共同消费），分级语义推广到「wiki 读写」，§15.1 补读侧分档矩阵，修正 §9.2-5 automation 结论；**I1** wiki-raw 信号绝对路径反向识别；**I2** `wiki:resolve-path` absPath 纳入挂载；**I3** grep 双根明确为新增编排层；**I4** export-markdown 图片解析表述更正；**F1–F5** 引用勘误；**S1–S4** 建议并入 |
| 1.4 | 2026-10-09 | 按用户反馈收敛范围边界：**删除 OQ-1（index 结构化标记，属「按项目过滤」功能探路）与 OQ-2（`wiki:export` zip 导出，属新功能）**；OQ 重编号（原 OQ-3~7 → OQ-1~5）并同步全部交叉引用；OQ 节增加定位声明——本需求为存储重构，不新增用户可见功能 |
| 1.5 | 2026-10-09 | 按用户反馈修订：**D9 新增「命名不写死」**——物理目录名一律读 `wiki.rootPath` 配置（语义改为「共享库在 userData 下的目录名」，可在设置页改名 = 受控 rename），词汇前缀单点常量定义（`src/shared/wikiConstants.ts`），ChatMarkdown / markdownExport / DetailPanelFileList 等散落 `'llm-wiki'` 字面量升级为正式交付项（P3 收口）并以源码扫描断言守护；**词汇前缀本身保持稳定**（历史链接 / 技能 / SCHEMA 依赖）；删除难懂的 OQ-3（乐观并发，平实表述并入 §9.4，本需求不实现）；OQ 重编号为 4 项并同步交叉引用；§15.1 增加命名不写死断言 |
| 1.6 | 2026-10-10 | 按用户反馈决议原 OQ-1（旧自定义根链接渲染端别名识别）：**不做**——仅影响当年手动改过 wiki 目录名的用户，历史链接以普通文件链接形态打开、内容不丢、仅打开位置不同，不值得增加渲染端兼容逻辑；决议写入 §7.5 / §11；剩余 OQ 重编号为 3 项并同步交叉引用 |
| 1.7 | 2026-10-10 | 按用户反馈决议原 OQ-1（远程 IM 展示名）：display_name 取名规则定为「profile 名 → basename → 重名追加一级父目录消歧 → tooltip 常驻完整路径」，写入 §6.2；剩余 OQ 重编号为 2 项并同步交叉引用 |
| 1.8 | 2026-10-10 | 按用户反馈决议原 OQ-1（微信发文件豁免）：**不做**；据代码核实实际失败链路（门禁 locked deny「微信附件只能来自当前工作目录内的文件」+ 执行层兜底「文件路径不在工作目录范围内」），**撤回 v1.3 的「wiki 文件暂不支持经 IM 发送」专用文案承诺**（需新增 locked 规则，违反 `defaultRules` 零改动）；补记 Agent 自恢复路径（读 wiki → workDir 副本 → 发送）与迁移前残留期瞬态边界；§15.1 补发文件断言；OQ 缩至 1 项（watcher 单例） |
| 1.9 | 2026-10-10 | 按用户反馈澄清 §13 边界：补记「迁移前已打开的 wiki 文件」瞬态行为——迁移改名使旧监听失效、面板保留最后内容、重新打开自愈，不做主动处理（watch-content 挂载改造针对的是迁移后日常打开的实时刷新，非迁移瞬态） |
| 1.10 | 2026-10-10 | 按用户反馈决议最后一项 OQ（watcher 单例）：**维持单例**——与单文件详情面板 UI 语义匹配，多面板形态出现时再议；OQ 清零，§17 保留决议索引 |
| 1.11 | 2026-10-10 | **v4 复审通过，无阻断**；并入应修正与建议：**C1** §9.3-2 笔误回改（只读别名「写」拒绝、读放行——v1.3 误写「读写」）；**C2** §7.1 增补规则 2「realBase 绝对形态反向命中」（I1 反向识别的规约依据）；**C3** §7.2 增补微信 media 探测接入行（`toolCallGate.ts:681-687`，否则 §13 门禁 deny 文案不成立）；**N1** R2 悬空 OQ 引用改为「未来工作」；**N2** 「home 祖先」措辞更正为「`AppData\Roaming`/`~/Library` 等祖先级前缀」（含 §3.5 行号 :23）；**N3** D9 扫描断言增加白名单（模板/fixture/i18n/别名数据）。文档冻结为实施基线 |
| 1.12 | 2026-10-10 | 开发计划复审 N2 需求补丁：`wiki:status` 新增 `projects` 列表（`{projectId, displayName, workDir, orphan}`）作为 WikiPane raw 节点展示名数据源（display_name 存于主进程 `wiki_projects` 表，原方案渲染层无来源）；§11 WikiPane tooltip 统一为「常驻完整路径」（对齐 §6.2 决议，原文「tooltip 原目录名」为疏漏） |

---

## 目录

1. [概述](#1-概述)
2. [目标与非目标](#2-目标与非目标)
3. [现状架构分析](#3-现状架构分析)
4. [方案总览与核心决策](#4-方案总览与核心决策)
5. [备选方案对比](#5-备选方案对比)
6. [目标目录结构与数据模型](#6-目标目录结构与数据模型)
7. [路径虚拟挂载机制](#7-路径虚拟挂载机制)
8. [技能与 Schema 注入改造](#8-技能与-schema-注入改造)
9. [写入防护、远程门禁与审批分级](#9-写入防护远程门禁与审批分级)
10. [IPC 与配置变更](#10-ipc-与配置变更)
11. [UI 变更](#11-ui-变更)
12. [存量迁移方案](#12-存量迁移方案)
13. [错误与边界](#13-错误与边界)
14. [安全与权限](#14-安全与权限)
15. [测试与验收标准](#15-测试与验收标准)
16. [发布计划](#16-发布计划)
17. [风险与待解决问题](#17-风险与待解决问题)
18. [相关文件清单](#18-相关文件清单)
- [附录 A：评审修订对照表](#附录-a评审修订对照表)

---

## 1. 概述

### 1.1 背景

LLM Wiki（[llm-wiki-requirement.md](./llm-wiki-requirement.md)）是面向 Agent 的长期记忆系统：`raw/` 存只读原始资料，`wiki/` 存 LLM 维护的结构化页面（entities / concepts / topics / sources / queries），由 Agent 通过内置文件工具读写维护。

**当前实现将 Wiki 根目录锚定在 workDir 内**（`electron/wiki/wikiPaths.ts:6` `resolveWikiRootAbs`，默认 `{workDir}/llm-wiki/`）。而应用通过 `workDirManager` 支持多个工作目录 profile，会话还可固定（pin）到不同 profile（经 `session:update` 的 `payload.workDirProfileId`，`electron/ipc/sessionIpc.ts:243-273`）。结果是：

- **每个 workDir 一份独立 Wiki**，知识互不可见；
- 用户在项目 A 中沉淀的实体/概念知识，切到项目 B 的 Agent 完全不知道；
- 飞书 / 微信远程 IM 会话、多并行会话各自绑定的 workDir 不同，记忆进一步碎片化。

### 1.2 本需求要做什么

将 LLM Wiki 的存储从「workDir 内相对目录」迁移到**应用数据目录（`app.getPath('userData')`，即 `spaceassistant-data.db` 所在目录）下的固定位置**，使**所有工作目录下的所有 Agent（本地会话、并行会话、远程 IM 会话）共享同一个记忆系统**。

核心思路：

1. **集中存储**：Wiki 根固定为 `{userData}/llm-wiki/`，与主数据库同级；
2. **虚拟挂载**：Agent 与渲染进程继续使用 workDir 相对路径词汇 `llm-wiki/...`，由主进程在**门禁探测层与工具执行层双侧、经同一解析函数**统一重映射到 userData（对 Agent、UI、历史聊天记录透明）——挂载不是执行层的私有技巧，必须让探测、permit、执行三层看到同一个世界（§7）；
3. **共享 + 溯源**：wiki 页面全局融合共享；`raw/` 原始资料按来源项目分目录（`raw/<projectId>/`），页面可标注来源项目，知识融合但来源可追溯；
4. **存量迁移**：提供交互式迁移向导，把各 workDir 的旧 Wiki（**含自定义 `rootPath` 的存量根**）合并进共享库，旧目录保留可回退，并为旧自定义根注册只读路径别名（§12）。

### 1.3 非目标（首版）

| 项 | 说明 |
|----|------|
| Wiki 内容入库（SQLite BLOB） | 首版仍为文件系统存储，理由见 §5 |
| 多范围（global / per-project 双模切换） | 首版只有共享模式；旧目录经迁移保留，天然可回退 |
| 多应用实例并发写共享 Wiki | 首版声明单实例约束（与主库运维假设一致），见 §9.4 |
| 跨设备同步 | 不在本需求范围 |
| raw 二进制 / PDF 解析 | 延续 [wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md) 现状（仅文本） |
| Agent 直接写 `raw/` | 仍禁止（`defaultRules.ts` locked deny 规则不变，见 §9.1） |
| 跨挂载边界的 move / rename | 首版显式拒绝并提示（§7.5），copy 允许 |

---

## 2. 目标与非目标

### 2.1 用户故事

- **US-1**：我在项目 A 让 Agent 沉淀了「客户 X」的实体页；切到项目 B 问「客户 X 是谁」，项目 B 的 Agent 能直接从共享 Wiki 读到该页并引用。
- **US-2**：飞书 / 微信远程会话（绑定 workDir C）中让 Agent ingest 一份资料、并让它把分析沉淀为 wiki 页面；回到桌面端任意项目的会话里都能查询到这条知识。**远程 lane 的 wiki 页写入必须与桌面 lane 同等可用**（§9.2）。
- **US-3**：我升级应用后，旧项目里的 Wiki 内容不丢失——迁移向导把它们（含历史自定义 `rootPath` 根）合并进共享库，且我能看到每个 raw 文件来自哪个项目。
- **US-4**：我仍然能用系统文件管理器直接打开 / 编辑共享 Wiki（它就是 userData 下的普通 Markdown 目录）；在面板里打开 wiki 文件时内容变更监听、导出等能力不回退。
- **US-5**：聊天记录里历史消息中的 `llm-wiki/...` 链接（以及存量自定义根 `<customRoot>/...` 链接），迁移后依然可以打开。

### 2.2 可量化目标

| 目标 | 判定 |
|------|------|
| 全局唯一 Wiki 根 | 所有 workDir profile 下，`wiki:status` 返回同一份 `initialized / pageCount` 状态 |
| Agent 词汇不变 | Agent 侧工具入参、技能文档、审批卡片中的路径仍是 `llm-wiki/...`（workDir 相对） |
| 三层一致 | 同一工具调用的探测层事实、permit 绑定目标、执行层落盘目标三者一致（§15.1 一致性断言测试） |
| 远程同等可用 | 飞书 / 微信 lane 的 `write_file` 落在 `llm-wiki/wiki/**` 时正常走确认流并成功落盘；`raw/**` 仍拒绝；**automation lane 读挂载 wiki 页通过、读 userData 其他路径仍 deny**（v3-B7） |
| 历史链接可用 | 迁移后历史消息中的 `llm-wiki/...` 与旧自定义根链接可打开（经主进程映射/别名） |
| 旧数据可回退 | 迁移后旧 `{workDir}/<wikiRoot>/` 以 `<wikiRoot>.migrated-{ts}/` 形式完整保留 |

---

## 3. 现状架构分析

> 本节为代码事实基线。v1.1 按评审核实结果修正了 v1.0 的 5 处事实偏差（见附录 A F 组），并新增 §3.5「门禁与路径解析现行架构」——这是 §7 挂载设计的直接前提。

### 3.1 存储与目录

| 项 | 现状 | 代码位置 |
|----|------|----------|
| Wiki 根 | `{workDir}/<wiki.rootPath>/`，默认 `llm-wiki`；**设置页允许用户自定义 rootPath**（存量自定义值真实存在） | `electron/wiki/wikiPaths.ts:6`；`src/renderer/components/Config/WikiTab.tsx:38-44` |
| 目录骨架 | `SCHEMA.md`、`wiki/{index,log}.md`、`raw/`、`wiki/{entities,concepts,topics,sources,queries}/`、`.wiki-meta.json` | `electron/wiki/wikiTemplates.ts:78`、`wikiInit.ts:53` |
| 元数据 | `.wiki-meta.json`（schemaVersion/initializedAt/ingestedRawPaths，仅初始化写入，暂无读取方） | `wikiInit.ts:93-108` |
| 主数据库 | `{userData}/spaceassistant-data.db` | `electron/main.ts:447` `getDefaultDbPath(app.getPath('userData'))` |
| dev 隔离 | dev 模式 userData 自动追加 `-dev` 后缀 | `electron/main.ts:134-137` |

### 3.2 Agent 交互链路

Agent **不使用专用 wiki 工具**，而是：

1. **技能路由**：项目技能 `{workDir}/.space-skills/llm-wiki/SKILL.md`（`electron/skills/skillPaths.ts:11` `getProjectSkillsDir`；安装逻辑 `wikiInit.ts:11` `writeSkillToProject`），由 `skillManager` 按触发词（wiki / ingest / 知识库 / lint）路由；wiki 未启用时被过滤（`electron/skills/skillManager.ts:52-61`）。
2. **文件工具直写**：Agent 用 `read_file / write_file / edit_file / grep / list_directory` 以 workDir 相对路径操作 `llm-wiki/...`；路径解析走 §3.5 的 permit 制链路。
3. **Schema 注入**：路由命中 llm-wiki 技能时，主进程把 `SCHEMA.md` 拼进 system prompt（`electron/ipc/agentProtocolIpc.ts:721-723`）。
4. **写入防护**：门禁探测产出 `wiki-raw-target` **信号**（`toolCallGate.ts:607`，按词汇路径判定），deny 规则本体是声明式 policy 的 locked deny `wiki-raw-write-deny`（`src/shared/policy/defaultRules.ts:20-22`，匹配 `write_file/edit_file` + `wiki-raw-target` 信号）；探测失败时另有 fail-closed 内联 deny（`toolCallGate.ts:611-620, 909-910`）。raw 只能由应用层 IPC 从 workDir 文件拷贝（`wiki:import-raw`，`electron/wiki/wikiImport.ts:43`）。

### 3.3 渲染进程依赖

| 依赖 | 说明 | 代码位置 |
|------|------|----------|
| WikiPane | 详情面板 Wiki 分段树，内嵌 FileTree 根为 workDir 相对 `wikiRoot`，走 `file:list-directory` | `src/renderer/components/WikiPane/WikiPane.tsx:32,38` |
| 聊天链接 | 聊天 Markdown 按 `wikiRootPath` 前缀（默认 `llm-wiki`）识别 wiki 链接；打开链路 `src/renderer/components/shared/MarkdownAnchor.tsx:40-53` → `onOpenFile` → `ChatView.tsx:892-895` `handleOpenFile` → `requestFilePaneSelect` → 面板选中 → `file:read-file` | `src/renderer/components/Chat/ChatMarkdown.tsx:60` |
| 链接形态 | `MarkdownLinkOrStatusDot` 仅做 status-dot / 链接二态分流，**无「文件不存在」态** | `src/renderer/components/shared/MarkdownLinkOrStatusDot.tsx:17` |
| 文件列表过滤 | `hideWikiFromFileTree` 由 `DetailPanelFileList.tsx:29-33` 实现（`excludePaths = [wikiRoot]`，按**配置值** `wiki.rootPath` 过滤，非硬编码） | `src/renderer/components/DetailPanel/DetailPanelFileList.tsx:29-33` |
| 设置页 | ConfigModal WikiTab 读写 `wiki.*` 配置，**rootPath 可编辑** | `src/renderer/components/Config/WikiTab.tsx:38-44` |
| IPC 面 | `wiki:init / wiki:status / wiki:get-schema / wiki:resolve-path / wiki:import-raw` | `electron/preload.ts:239-243`、`src/shared/api.ts:533-543` |
| wikilink 展开 | `expandWikilinks` 第二参硬编码 `'llm-wiki'`（不读 config） | `electron/markdownExport.ts:54` |

### 3.4 workDir 多 profile 机制

- `workDirManager` 维护 profile 列表 + 激活 profile（启动回退 `stored ?? isDefault ?? profiles[0]`，`electron/workDirManager.ts:166-167`——**"无 profile" 并非稳定可达状态**，projectId 设计不得依赖它，见 §6.2）；会话经 `session:update` pin 到指定 profile。
- 多个会话可**并行**运行在不同 workDir 下（`maxParallelChatSessions`），所有文件工具执行都汇聚于**同一主进程**——这是 §9.4 并发控制可行性的前提。

### 3.5 门禁与路径解析现行架构（v1.1 新增，挂载设计的前提）

文件工具路径解析**不是**单一函数入口，而是「探测层 → 策略层 → permit → 执行层」四段结构：

| 段 | 职责 | 代码位置 |
|----|------|----------|
| **探测层（写）** | `probeWritePathFact({ workDir, userDataDir, homeDir, customSensitivePrefixes })` 自行做词法归一 + realpath，产出 `WritePathFact`（normalizedPath / zone / targetKind / identity）；**userData 与 home 是内置敏感根** | `electron/confirmation/extractors/writePathFacts.ts:101-108` |
| **探测层（读）** | `readPathFacts` 同样自行归一 + realpath（lexical → realpath → identity） | `electron/confirmation/extractors/readPathFacts.ts:123-149` |
| **探测层（读/写共享分类器）** | `classifyReadPathZone`（`readPathFacts.ts:69-85`，「路径 zone 的唯一纯分类入口，读写事实探测共同消费」，`writePathFacts.ts:191` 亦调用）产出 zone；判定顺序 **sensitive → system-dir → workdir-normal → outside-workdir**——**敏感判定先于 workDir 包含判定**，内置敏感前缀含 userDataDir 及其祖先级前缀（`getBuiltinSensitivePrefixes`，定义于 `shell/shellSensitivePaths.ts:23`，win32 内置含 `AppData\Roaming` 等，v4-N2） | `electron/confirmation/extractors/readPathFacts.ts:69-85` |
| **范围分类（写）** | `classifyWriteTargetScope(normalizedPath, workDir)` → 信号值 `write-target-scope: inside-workdir / outside-workdir`；`unknown` 非分类器返回值，来自 gate 调用处 catch 兜底 | `toolCallGate.ts:590-602`（`:593-594` 兜底）；微信 media 路径同款检查 `:687` |
| **策略层（写侧 locked deny）** | `wiki-raw-write-deny`（wiki-raw-target）、`remote-outside-write-deny`（wechat/feishu + `write-target-scope:outside-workdir`）、`remote-write-scope-unknown-deny` | `src/shared/policy/defaultRules.ts:20-34` |
| **策略层（读侧 locked + 敏感档）** | `remote-outside-read-deny`（wechat/feishu/automation + `path-target:outside-workdir`，locked deny，`:41-46`）；**`automation-sensitive-path-deny`（automation + `path-target:sensitive-file`，locked deny / forbidden，`:198-202`）**；**`path-sensitive-read-confirm`（desktop/wechat/feishu + read + `path-target:sensitive-file`，locked confirm-every-time，`:296-302`）**——wiki 迁入 userData 后若无 zone 豁免，读 wiki 页将全部命中后两条（B7） | `src/shared/policy/defaultRules.ts` |
| **读 permit** | 读类工具统一经 `resolveReadPermitTarget`（**不 import pathSecurity**），permit 绑定 realpath + dev/ino/mode identity | `electron/confirmation/readPermitExecutor.ts:18-21`；签发映射 `toolCallGate.ts:975` |
| **写 permit** | 写侧经 `resolveWriteTargetFromPermit`：有 permit 用 permit 目标；**仅非 desktop lane 且无 permit 时**才直接 `resolveSafeWriteTarget(ctx.workDir, rawPath)` | `electron/tools/builtinExecutors.ts:766-778`（`:814` edit、`:964` write 调用点）；类型 `electron/confirmation/writeExecutionPermit.ts` |
| **远程写门禁（执行层）** | `assertRemoteWriteTargetInsideWorkDir(ctx.workDir, permit.target.normalizedPath)`：远程 lane 写目标按 **realpath** 断言 inside-workdir，违反抛 `remote-write-target-outside-workdir` | `builtinExecutors.ts:755-764, 775` |
| **旁路解析点** | grep path 参数经 `resolveReadPermitTarget('grep', …)`（`builtinExecutors.ts:1818`）；范围规划在 `planGrepInvocation`（rg/walk 双引擎共用，单根形态 `scope.root`，`electron/tools/grepScope.ts:108`）；`file:watch-content` → `electron/fileContentWatcher.ts:17` 自行 `resolveSafePath`（`fileIpc.ts:62` 动态 import）；`file:export-markdown` 图片以 workDir 为根（`fileIpc.ts:131`）；微信发送文件工具独立解析（`electron/tools/weChatToolExecutor.ts:35`）；shell（终端）cwd 恒为 workDir 由 `runShellPlan.ts:125` `planShellExec(command, ctx.workDir, spec)` 承载（`builtinExecutors.ts:2120` 是 run_script 执行器的 cwd） | 见左 |
| **死代码佐证** | `builtinExecutors.ts:10` import 的 `resolveSafeWorkDirPath` 全文未使用 | — |

**推论（v1.0 的关键修正）**：挂载若只改执行层，探测层看到的仍是 workDir 视角——`write-target-scope` 信号会因 realpath 在 userData 而判 `outside-workdir`（触发远程 locked deny）、userData 敏感根判定会命中（审批分级漂移）、审批卡片路径失真。**挂载必须在探测层生效，并贯穿 permit 与执行层。**

### 3.6 事件与刷新链路（修正）

文件树失效经统一出口广播：`notifyFileTreeChanged`（`electron/fileTreeSyncNotify.ts:10`）→ `broadcastScopeInvalidation('file-tree', version, hint)`，渲染端收到更高版本后自行 `file:list-directory` 重取；hint 仅含变更路径指示。事件源头如 `agentProtocolIpc.ts:1301`（wiki import）、`claudeStreamHandlers.ts:525`。`WikiPane.tsx:72` 订阅的是渲染进程内 `subscribeFilePaneSelect` 导航总线（面板选中），不是 FileTreeChangeEvent。

---

## 4. 方案总览与核心决策

### 4.1 决策一览

| # | 决策 | 内容 |
|---|------|------|
| D1 | 存储位置 | Wiki 根固定为 `{userData}/llm-wiki/`，与 `spaceassistant-data.db` 同级 |
| D2 | 路径词汇 | 保持 workDir 相对词汇 `llm-wiki/...` 不变；`wikiMount` 作为**唯一挂载决策点**，在探测层（path facts）、permit、执行层双侧接入（§7） |
| D3 | 共享模型 | wiki 页面全局融合；`raw/` 按来源项目分目录 `raw/<projectId>/`；页面可选 `project:` frontmatter 溯源 |
| D4 | 技能层级 | `llm-wiki` 技能从项目级升级为**用户级**（`{userData}/skills/llm-wiki/`）；迁移时清理项目级旧副本（§8.1 覆盖陷阱） |
| D5 | 远程 lane | wiki 命名空间写**视同 workDir 内写**：范围分类与远程断言按挂载词汇判定，locked deny 规则文本不变（§9.2） |
| D6 | 并发控制 | 单实例内主进程按文件粒度互斥串行化 wiki 写执行体；跨工具调用竞态由 SCHEMA 协作守则缓解（§9.4） |
| D7 | 配置语义 | `rootPath` 字段语义改为「**共享库在 userData 下的目录名**」（默认 `llm-wiki`，可改名，见 D9）；**存量自定义根纳入迁移检测，并注册只读路径别名**（§6.3、§12.2） |
| D8 | 发布约束 | **P1 与 P2 必须同版本发布**（§16），不允许出现「旧数据不可见且无迁移入口」的版本 |
| D9 | 命名不写死 | **代码不硬编码 `'llm-wiki'` 字面量**：① 物理目录名一律读 `wiki.rootPath` 配置（改名 = 修改配置 + 受控 rename，§6.3）；② 词汇前缀在代码内**单点常量定义**（`src/shared` 共享常量，渲染 / 主进程统一引用），ChatMarkdown、markdownExport、DetailPanelFileList、gate 等处散落字面量在本需求内清理完毕，并以源码扫描断言守护（§15.1）。词汇前缀本身保持稳定（历史聊天链接 / 技能 / SCHEMA 均依赖它），改名只改磁盘目录名，对 Agent 与历史透明 |

### 4.2 总体数据流（改造后）

```
Agent(任意 workDir / 远程 IM)
  │  write_file("llm-wiki/wiki/entities/x.md")     ← 词汇不变
  ▼
探测层 writePathFacts ── wikiMount.resolveInput() ──► effectiveBase = {userData}/llm-wiki
  │   zone / write-target-scope 按词汇→inside-workdir；敏感根豁免 wiki 子树；fact 增 vocabularyPath
  ▼
策略层 defaultRules（locked deny 文本不变：wiki-raw / remote-outside 按修正后的信号判定）
  ▼
WriteExecutionPermit（承载 realTarget + vocabularyPath 双字段 + identity）
  ▼
执行层 resolveWriteTargetFromPermit → 落盘 {userData}/llm-wiki/...（wiki 写互斥区内）
  ▼
notifyFileTreeChanged（版本失效广播，hint 含 llm-wiki/... 词汇路径）→ 渲染端重取

渲染进程 WikiPane / 聊天链接 → file:list-directory / file:read-file（fileIpc 入口同一 wikiMount）
```

---

## 5. 备选方案对比

| 方案 | 说明 | 结论 |
|------|------|------|
| **A. userData 集中目录 + 虚拟挂载（本方案）** | 文件系统集中存储，路径词汇不变，探测/执行双侧重映射 | ✅ 采用。Agent 交互模型（文件工具直读直写）、用户直接编辑能力、git 友好性全部保留；历史聊天链接零成本兼容 |
| B. Wiki 内容存 SQLite（分表 + 专用 wiki_* 工具） | 页面/索引入库，新增专用工具替代文件工具 | ❌ 否决。需新造一套工具与审批链路；丢失「用户用编辑器直接改 Markdown」「git 版本化」能力；SCHEMA/index 等文件约定（Karpathy 模式核心）被破坏 |
| C. 保持 workDir 存储，符号链接/联接到共享位置 | `{workDir}/llm-wiki` → userData junction | ❌ 否决。写路径逐段 lstat 明确拒绝符号链接组件；Windows junction 权限与打包安装复杂；pathSecurity 语义被穿透 |
| D. 每会话注入绝对路径，放开 userData 写权限 | 把 `{userData}/llm-wiki` 作为额外可写根暴露绝对路径 | ❌ 否决。绝对路径暴露 userData 布局，穿越防护面扩大；Agent 词汇/历史链接/技能文档全部要改，改动面反而最大 |

---

## 6. 目标目录结构与数据模型

### 6.1 共享 Wiki 目录结构

```
{userData}/llm-wiki/
├── SCHEMA.md                     # 全局规范（新版模板，含「共享记忆库协作守则」）
├── .wiki-meta.json               # schemaVersion: 2（含 storage: "shared"）
├── wiki/
│   ├── index.md                  # 全局索引
│   ├── log.md                    # 追加式全局日志（条目含 [project:<id>] 前缀）
│   ├── entities/  concepts/  topics/  sources/  queries/
│   └── projects/<projectId>/     # （可选）项目专属页面分区
└── raw/
    └── <projectId>/              # 原始资料按来源项目分目录（对模型只读）
```

要点：

- **wiki 页面默认全局融合**（entities/concepts/topics/sources/queries 不按项目隔离），这是「共享记忆」的本体；
- `wiki/projects/<projectId>/` 为**可选**项目专属分区：当某页面只属于单一项目、不宜污染全局视图时由 Agent 酌情放置（SCHEMA 模板中给出判据）；
- **raw 必须按项目分目录**：不同项目常有同名文件（`README.md`、`meeting-notes.md`），扁平 + 自动改名会丢失语义；
- `.wiki-meta.json` 升级 `schemaVersion: 2`，新增 `storage: "shared"` 标识（新旧结构判定依据）。

### 6.2 projectId 语义（v1.1 修订：始终按 workDir 哈希）

**projectId 一律取规范化 workDir 绝对路径的哈希**：`p-<sha256(canonicalWorkDir).slice(0,8)>`。规范化 = realpath（回退：win32 小写化 + 统一分隔符）。**不使用 profileId 作为 projectId**。

理由（回应评审 I4/I5）：两个 profile 可指向同一目录（profileId 不同、workDir 相同），若按 profileId 建项目分区会产生两个 projectId 并撞 `work_dir` UNIQUE；且 workDirManager 存在 default profile 回退，「无 profile」并非稳定可达状态，按 profileId 分支会漏判或成死代码。哈希方案下同一目录天然收敛到同一 projectId，远程 IM 直接使用裸 workDir 的场景同样覆盖。

DB 映射表（`migrations.ts` 版本 +1），profileId 降级为**展示元数据**（非唯一、可多行）：

```sql
CREATE TABLE IF NOT EXISTS wiki_projects (
  project_id     TEXT PRIMARY KEY,          -- p-<hash8>
  work_dir       TEXT NOT NULL UNIQUE,      -- 规范化 workDir 绝对路径
  display_name   TEXT NOT NULL,             -- 取名规则见下（已决议，原 OQ-1）
  profile_id     TEXT,                      -- 最近一次关联的 profile（仅展示；可空）
  first_seen_at  INTEGER NOT NULL,
  orphan         INTEGER NOT NULL DEFAULT 0 -- workDir 失效后置 1，保留历史归属
);
```

- projectId 仅用于**目录命名与日志前缀**，不承担安全职责；
- **display_name 取名规则（已决议，原 OQ-1；只影响展示，projectId 始终为 `p-<hash8>`）**：
  1. workDir 关联了 profile → 用 profile 名；
  2. 裸 workDir（无 profile，如远程 IM 会话）→ 用路径 **basename**（最后一段目录名，不含完整路径），如 `E:\Develop\SpaceAssistant` → `SpaceAssistant`；
  3. **重名消歧**：多个 workDir 的 basename 相同（如 `C:\work\demo` 与 `D:\archive\demo`）→ 自动追加一级父目录名（`work/demo` vs `archive/demo`）；
  4. UI 展示处 tooltip 常驻**完整路径**，兜底区分。
- Agent 读写全局 wiki 页面时**不需要**感知 projectId；仅 ingest 落 raw 与归档项目专属页时由主进程注入。

### 6.3 配置模型变化

`src/shared/domainTypes.ts:468-487` `WikiConfig`：

| 字段 | 变化 |
|------|------|
| `enabled` | 不变（全局开关，语义升级为「共享记忆库开关」） |
| `rootPath` | **语义变更（D7/D9）：从「workDir 内相对路径」改为「共享库在 `userData` 下的目录名」**，默认 `llm-wiki`，**可在设置页修改（改名操作）**。改名 = 修改配置值 + 对已初始化的共享库执行受控 `rename`（存在进行中会话时提示空闲后执行；失败回滚配置值），改名后广播文件树失效；**词汇前缀不跟随目录名**（历史聊天链接、技能文档、SCHEMA 依赖词汇稳定，对 Agent 与历史完全透明）。**升级时的存量自定义值不丢弃**——迁移检测读取该值纳入扫描（§12.1，注意该值为旧语义「workDir 内根目录名」），迁移完成后原值转入 `legacyRootAliases`（§12.2）。设置页展示「存储位置：应用数据目录 · <rootPath>」 |
| `legacyRootAliases` | **新增（可选 string[]）**：历史自定义根名词汇表，主进程挂载层与 `wiki:resolve-path` 识别为**只读**别名（§7.1）；仅用于打开历史链接，写入别名路径返回引导性错误 |
| `hideWikiFromFileTree` | 过滤基准从「配置值 `wiki.rootPath`」改为**词汇常量** `llm-wiki/`（rootPath 改为物理目录名后，workDir 内词汇与它无关，D9）；`false` 时文件树根部的虚拟条目见 §7.4-I1 |
| `interactiveIngest` / `maxBatchIngest` | 不变 |

不新增 `scope` 双模字段（见 §1.3 非目标）。

---

## 7. 路径虚拟挂载机制

> v1.1 全节重写。原则：**`wikiMount` 是全应用唯一的挂载决策点**；探测层、permit、执行层对同一次工具调用的同一路径入参调用同一解析函数，各自派生自己需要的视图（词汇路径 / 真实目标）。禁止任何层私有实现「前缀判断」。

### 7.1 单点解析函数 `electron/wiki/wikiMount.ts`

```ts
export type WikiMountResolution =
  | {
      mounted: true
      vocabularyPath: string   // workDir 相对词汇，如 "llm-wiki/wiki/index.md"（展示、审计、信号判定用）
      realBase: string         // {userData}/<wikiConfig.rootPath>（目录名读配置，D9；非硬编码）
      realRel: string          // 挂载内相对路径
      realPath: string         // realBase + realRel（词法结果，realpath 仍由各层既有机制完成）
      readOnly: boolean        // true = 命中 legacyRootAliases 只读别名
    }
  | { mounted: false }

export function resolveWikiMount(
  workDir: string,
  wikiConfig: WikiConfig,        // 含 legacyRootAliases
  userDataPath: string,
  pathInput: string              // 与工具入参同形：相对或绝对
): WikiMountResolution
```

判定规则：

1. 入参规范化（反斜杠→`/`、去前导 `/`）；
2. **realBase 绝对形态反向命中（v4-C2 增补，I1 反向识别的规约依据）**：入参为绝对路径且命中 `realBase` 前缀（即 `{userData}/<rootPath>/...` 形态）→ 反向映射为词汇路径（realBase 之后的后缀）后按规则 4/5 判定——`{userData}/llm-wiki/raw/x.md` 由此获得与词汇形态 `llm-wiki/raw/x.md` 完全一致的挂载与信号语义；
3. 其余绝对路径先 `path.relative(workDir, abs)` 化，越界不挂载；
4. 命中 `<wikiRoot>` 本身或 `<wikiRoot>/...` 前缀 → 挂载，读写均允许；
5. 命中 `legacyRootAliases` 中某别名前缀 → 挂载且 `readOnly: true`（历史链接打开用；写操作由上层拒绝并提示新路径）；
6. 其余 → 不挂载，走原 workDir 逻辑；
7. **单次重映射**：`realPath` 位于 userData，不会再进入任何 workDir 相对解析，杜绝二次拼接穿越；
8. 纯函数、无 IO；`wikiConfig.enabled === false` 时恒不挂载。

### 7.2 接入点总表（探测层 → permit → 执行层 → 渲染链路）

| 层 | 接入方式 | 落点 |
|----|----------|------|
| **写探测** `probeWritePathFact` | 函数签名增加可选 `mountAnchors: { base, vocabularyPrefix }[]`（由 gate 以 `resolveWikiMount` 结果构造传入）；挂载命中时探测的包含判定锚点从 `workDir` 换为 `realBase`，产出 fact 增字段 `vocabularyPath` 与 `scopeBase`（= realBase） | `electron/confirmation/extractors/writePathFacts.ts` |
| **读探测** `readPathFacts` | 同上：挂载命中时 lexical 锚点换 `realBase`，fact 增 `vocabularyPath`；realpath / identity 机制复用。**锚点切换只中和 `outside-workdir` 分支（`remote-outside-read-deny`），不清除 `sensitive-file` zone（敏感判定先于包含判定）——zone 豁免由共享分类器承担，见下行（B7）** | `electron/confirmation/extractors/readPathFacts.ts` |
| **微信 media 探测（v4-C3 增补）** | `wechat_send` / `wechat_reply` 附件路径的 `probeReadPathFact` 调用（`toolCallGate.ts:681-687` 一带）**同样以 `resolveWikiMount` 构造锚点传入**——否则 wiki 附件按 workDir 相对解析为 missing → boundary `inside-workdir` → 门禁放行 → 执行层报「文件不存在，请检查路径」，§13 所述门禁 deny 文案（可引导 Agent 自恢复的那条）不成立 | `toolCallGate.ts:681-687` |
| **敏感 zone 豁免（共享分类器，B7）** | **豁免落点在 `classifyReadPathZone`（读写事实探测共同消费的唯一纯分类入口，`writePathFacts.ts:191` 同样调用）**：分类器入参增加 `sensitiveRootExemptions: string[]`，判定语义为**豁免优先**——`resolvedPath` 落在任一豁免前缀内 ⇒ 跳过全部敏感前缀匹配（userData 位于 home 之下，且内置前缀含 `AppData\Roaming`、`~/Library` 等**祖先级前缀**——只移除 userDataDir 一条仍会被祖先级前缀命中，v4-N2），zone 继续走 system-dir → 包含判定；读写探测的 `ProbeInput` 均透传该入参，gate 仅在 wiki 启用时传入 `[{userData}/llm-wiki]`（§9.3） | `readPathFacts.ts:69-85`、`shell/shellSensitivePaths.ts`（`matchSensitive`） |
| **范围分类** | `classifyWriteTargetScope` 的判定基准从 fact.normalizedPath（real）改为 **fact.scopeBase 包含判定**——挂载命中时 realPath ⊆ realBase ⇒ `inside-workdir`；未挂载行为不变 | `toolCallGate.ts:592`、`extractors/writePathFacts.ts` |
| **wiki-raw 信号** | 词汇判定**不变 + 绝对路径反向识别（I1）**：`:607` 按词汇路径（`resolveWikiRelPath` → `classifyWikiPath`）判定，挂载前后相对/词汇形态语义一致；但迁移后若模型以 **realBase 绝对形态**（`{userData}/llm-wiki/raw/...`）为写入目标，`path.relative` 化得到 `../...` → 分类 `'other'` → locked deny 不触发，desktop lane 的 raw 防护从 forbidden 降级为 confirm 档。补法：信号判定前先 `resolveWikiMount`，挂载命中（含 realBase 绝对形态的反向命中）一律以 `vocabularyPath` 参与分类；deny 规则本体 `defaultRules.ts:20-22` 不动 | `toolCallGate.ts:607`、`wikiPaths.ts:11-21`、`src/shared/policy/defaultRules.ts` |
| **策略层** | locked deny / confirm 规则**文本零改动**；信号在探测层已被修正（远程 wiki 写 → `inside-workdir`，不再触发 `remote-outside-write-deny`；`raw/**` → `wiki-raw-target` 依旧 deny；zone 豁免后 wiki 读 → `workdir-normal`，`path-sensitive-read-confirm` 与 `automation-sensitive-path-deny` 不再命中） | `src/shared/policy/defaultRules.ts` |
| **读 permit** | `resolveReadPermitTarget` 前置调用 `resolveWikiMount`：挂载命中时以 `realBase + realRel` 解析 permit 目标；permit/映射增 `vocabularyPath` 字段（审批卡片、审计、scope 失效 hint 用） | `electron/confirmation/readPermitExecutor.ts:18-21`、签发映射 `toolCallGate.ts:975` |
| **写 permit / 执行** | `resolveWriteTargetFromPermit` 不感知 wiki（继续信任 permit 目标）；`assertRemoteWriteTargetInsideWorkDir` 改为按 **fact/permit 的 scopeBase 结论**断言（挂载命中时对 `realBase` 断言），不再对 workDir 断言 real 路径（§9.2）。备注（v3-S4）：`WriteExecutionPermit.toolName` 联合类型仅含 `write_file | edit_file`，本需求不新增写工具；未来任何写 userData 的新工具需同步扩展该联合与 `validateWriteExecutionPermit` | `builtinExecutors.ts:755-778`、`electron/confirmation/writeExecutionPermit.ts` |
| **一致性守卫** | 执行层对入参**再跑一次** `resolveWikiMount`，与 permit 的 `vocabularyPath` 比对，不一致 → fail-closed（防探测/执行间状态漂移，如迁移中途配置变更） | `builtinExecutors.ts`（写执行体入口） |
| **grep** | `path` 参数经 `resolveReadPermitTarget('grep', …)` 天然走挂载；**无 path 的全库搜索需要新增双根编排层（I3，非改一个字段）**：`planGrepInvocation` 现为单根签名（输出 `scope.root` 单字符串，消费点 3 处：rg `:1279`、walk `:1868`、结果回填 `:1960`），编排层对 `roots = [workDir, wikiRoot]` **每根各 plan 各执行**，再合并结果——统一处理 head_limit / truncated 口径、`formatGrepNoMatchOutput` 单根文案（`grepScope.ts:188`）、排序确定性，结果路径统一改写回词汇路径；**workDir 根扫描排除挂载词汇前缀下的实体目录（含只读别名前缀）**——迁移完成前 `{workDir}/llm-wiki/` 残留实体若被扫入，会与共享根产生同词汇路径重复（S2 去重规则，详见 §7.7）。工作量计入 P1（§16） | `electron/tools/grepScope.ts:108,188`、`builtinExecutors.ts:1818` |
| **list_directory（Agent）** | 经 `resolveReadPermitTarget('list_directory', …)` 走挂载 | 同读 permit 行 |
| **Ingest** | `importRawFromWorkDir`：src 仍在来源 workDir；目标改 `raw/<projectId>/...`，落盘经 `resolveSafeWriteTarget(realBase, …)`（沙箱根换成 wiki 根，逐段 lstat / 拒 symlink 语义原样保留） | `electron/wiki/wikiImport.ts` |

**一致性论证（三层同一世界）**：三层对同一 `pathInput` 字符串调用同一纯函数；探测层以 `realBase` 为锚产出 fact（zone/scope 基于 realBase 包含），permit 绑定该 fact 的 normalizedPath 与 identity，执行层信任 permit 目标并做二次挂载一致性比对。测试断言 `fact.normalizedPath === permit.target === executor 落盘路径` 且 `fact.vocabularyPath === Agent 入参词汇`（§15.1）。

### 7.3 审批卡片与审计展示

卡片与审计日志展示 `vocabularyPath`（`llm-wiki/...`），与 Agent 入参逐字一致；真实 userData 路径不进入渲染层与日志正文（§14）。

### 7.4 fileIpc 子通道逐一处置表（B6）

| 子通道 | 现状解析点 | 处置 |
|--------|-----------|------|
| `file:list-directory`（`fileIpc.ts:22-47`） | workDir 相对 | 经挂载：`llm-wiki/...` 列共享库真实目录；**根列表 `''` 且 `hideWikiFromFileTree=false` 时合成虚拟 `llm-wiki` 目录条目**（新增可选 `virtual` 标记字段），文件树根部不再缺失节点（I1）；**挂载启用期间跳过 workDir 内同名实体目录条目，避免虚拟 + 实体双条目（§7.7，S2）** |
| `file:read-file` | workDir 相对 | 经挂载；只读别名前缀同此打开 |
| `file:watch-content`（`fileIpc.ts:61-72` → `electron/fileContentWatcher.ts:17`，注意在 `electron/` 根而非 `tools/`，v3-F1） | watcher 自行 `resolveSafePath(workDir, …)` | watcher **启动前**先经 `resolveWikiMount` 解析真实路径再监听——wiki 文件的变更监听（外部编辑、其他会话写入）不回退；切 workDir 统一停 watcher 的现有行为不变（wiki watcher 与 workDir 无关，需在切换逻辑中一并保留/停止，测试覆盖）。注意（v3-S3）：watcher 为**全局单例**（单 watcher + 单 watchedRelPath，`electron/fileContentWatcher.ts:7-8`），多会话同时打开同一 wiki 页会互挤——**已决议维持单例（2026-10-10）**：与单文件详情面板的 UI 语义天然匹配（一次只展示一个文件，切换即换监听），多面板/多窗口形态出现时再议 |
| `file:export-markdown`（`fileIpc.ts:114-137`） | source 走 `resolveSafePath`（**无 extraRoots 形参**，`pathSecurity.ts:11`）；图片走 `resolveSafeReadPath(root, …)` 但**现状未传 extraRoots**（`fileIpc.ts:131`） | **source 经挂载解析为真实路径（handler 实改不可避免）+ 图片调用点补传 `extraRoots = [source 挂载后的真实目录]`**（v3-I4 更正：v1.2 所称「既有 extraRoots 通道」对 source 侧不成立），wiki 页导出图片不再静默丢弃 |
| `file:delete` / `file:rename`（`:232,238`） | workDir 内 | 挂载命中时映射到 wiki 根内操作，真实路径断言 `assertInsideDir(realBase, …)`；`raw/**` 的用户 UI 删除/改名不受模型侧 deny 约束（该规则仅约束模型写），维持现状语义 |
| `file:move` / `file:copy`（`:248,260`） | workDir 内 | **同侧**（两端都在 workDir，或两端都在 wiki 挂载内）：映射后照常；**跨边界**：copy 允许（主进程两段式复制，先读源侧、后写目标侧并过对应沙箱根），move/rename 跨边界**首版显式拒绝**并返回引导错误（避免 EXDEV / 部分成功歧义，见 §1.3） |
| `fileShowInExplorer(wikiRoot)` | workDir 相对 | 挂载命中时打开 `{userData}/llm-wiki` 真实位置 |
| `wiki:resolve-path`（`agentProtocolIpc.ts:1328-1335`） | `classifyWikiPath` 词汇判定；`absPath` 由 `resolveSafePath(workDir, …)` 计算 | kind 判定逻辑不变、只读别名前缀返回 `kind` 并标 `readOnly`；**`absPath` 同步经挂载解析为真实路径**（否则迁移后返回不存在的 workDir 路径，v3-I2） |

### 7.5 渲染进程与历史数据兼容

- **WikiPane**：`wikiRoot` 仍是 `llm-wiki` 词汇（`WikiPane.tsx:32`），目录树经 `file:list-directory` 自动看到共享库内容；
- **聊天历史链接（`llm-wiki/...`）**：前缀识别与打开链路（`ChatMarkdown.tsx:60` → `src/renderer/components/shared/MarkdownAnchor.tsx:40-53` → `ChatView.tsx:892-895` → 面板选中 → `file:read-file`）不变，`file:read-file` 经挂载命中新位置；
- **历史链接（旧自定义根 `<alias>/...`）**：**已决议不做渲染端别名识别**（原 OQ-1）。迁移前改过 wiki 目录名的用户，其历史消息里的旧前缀链接不再被认成 wiki 链接，以**普通文件链接**形态渲染（点击后在文件面板打开，不路由到 WikiPane）；`file:read-file` 经只读别名映射打开真实文件，**内容不丢**（§12.2）。仅影响「当年手动改过目录名」的用户，且仅为打开位置不同，不值得为它增加渲染端兼容逻辑；
- **文件列表过滤**：`hideWikiFromFileTree` 过滤基准改为**词汇常量** `llm-wiki/`（不再读 `rootPath` 配置值，D9），对用户可见行为不变。

### 7.6 变更事件与刷新

wiki 写入发生在 userData，workDir watcher 不覆盖。所有**主进程发起的 wiki 写入**（Agent write/edit、Ingest 拷贝、迁移写入）完成后调用 `notifyFileTreeChanged`（`electron/fileTreeSyncNotify.ts:10`）广播版本失效，hint 携带 `llm-wiki/...` 词汇路径，渲染端按既有机制重取（事件源头惯例参照 `agentProtocolIpc.ts:1301`、`claudeStreamHandlers.ts:525`）。

### 7.7 词汇路径唯一性：workDir 侧实体残留去重（S2）

**问题**：挂载启用后、迁移完成前，各 workDir 内的旧实体 wiki 目录（`{workDir}/llm-wiki/` 及历史自定义根）仍在磁盘上。workDir 侧的**根扫描**（grep 无 path 全库搜索的 workDir 根、`file:list-directory ''` 的根列表）会把实体目录扫入，产生与共享根**同词汇路径的双份结果**（如 `llm-wiki/wiki/index.md` 同时来自 workDir 残留与共享库）。

**规则**：挂载启用（`wiki.enabled`）期间，凡产出 workDir 相对词汇路径的**根级扫描**，必须排除挂载词汇前缀（`<wikiRoot>/` 及 `legacyRootAliases` 各前缀）下的实体目录/条目——词汇路径由共享根唯一提供：

| 扫描点 | 去重行为 |
|--------|----------|
| grep 无 path 双根并集（`planGrepInvocation`） | workDir 根的 rg/walk 调用追加排除 glob（`!<wikiRoot>/**` 及别名前缀）；共享根结果改写回词汇路径，天然无重复 |
| `file:list-directory ''` 根列表 | 实体 `llm-wiki` 目录条目被跳过，仅返回 §7.4 合成的虚拟条目（避免「虚拟 + 实体」双条目） |
| grep `path=<wikiRoot>/...`、`list_directory(llm-wiki)`、读类显式路径 | 不受影响——显式路径直接经挂载命中共享根，不存在双份 |
| 迁移完成后 | 实体目录已改名 `.migrated-{ts}`，前缀不再命中，规则自然失效（保留排除逻辑无害） |

**语义声明**：该规则意味着迁移前旧实体目录在挂载启用期间**暂时不可经 Agent 词汇访问**（读到的将是共享根内容）——这是有意行为：迁移完成前共享根可能尚为空，此时 Agent 查询 wiki 得到空结果属于预期（引导先迁移）；用户仍可经系统文件管理器访问旧目录。该行为与 §12 的迁移向导提示联动（WikiPane 顶部提示条）。

---

## 8. 技能与 Schema 注入改造

### 8.1 技能升级为用户级（含覆盖陷阱处理）

`skillScanner` 合并顺序为 **user → project → bundled**（`electron/skills/skillScanner.ts:49-52`，后者覆盖前者同名；`getBundledSkills()` 仅含 browser / shell-setup-guide，llm-wiki 不在其中，`PRODUCT_BUILTIN_SKILL_NAMES` 只是 UI 隐藏名单）。因此：

1. 新版 `llm-wiki` 技能安装到 `{userData}/skills/llm-wiki/SKILL.md`（`getUserSkillsDir`，`skillPaths.ts:7`）；
2. `wikiInit` 不再往 workDir 写 `.space-skills/llm-wiki/`（`wikiInit.ts:11` 改向用户级目录写入）；
3. **迁移/初始化时必须删除各 profile workDir 内的旧项目级副本**——否则项目级副本持续覆盖用户级新版（陷阱成立，依据即上述合并顺序）；
4. `skillManager` 的 wiki 未启用过滤（`skillManager.ts:52-61`）按技能名过滤，与层级无关，不变。

### 8.2 技能与 SCHEMA 模板内容更新（`wikiTemplates.ts`）

- **SKILL.md**：路径约定章节改写为「Wiki 是 SpaceAssistant 的**跨项目共享记忆库**；路径仍写作 `llm-wiki/...`（应用自动映射，无需关心物理位置）」；新增共享协作守则：
  - 写页面前先 `read_file(wiki/index.md)` + `grep` 查重，**优先更新既有页面**而非新建平行页；
  - 新建实体/概念页时检查是否与其他项目知识冲突，冲突时合并并在页内注明差异场景；
  - 归档项目专属内容时使用 `wiki/projects/<projectId>/` 分区；
  - 日志条目格式：`## [YYYY-MM-DD HH:mm] [project:<id>] <动作>`；
  - **显式声明「不要用 shell / 终端访问 wiki 路径」**（shell cwd 恒为 workDir，挂载对其无效，见 R7）；
- **DEFAULT_SCHEMA_MD**：同步上述目录约定（`raw/<projectId>/`、`wiki/projects/`）与共享协作守则；
- **ingest 工作流**不变（raw 只读 → 更新页面 → index → log）。

### 8.3 Schema 注入

`agentProtocolIpc.ts:721-723` 注入逻辑不变，`readWikiSchema` 内部经挂载读全局 SCHEMA——所有 workDir 的会话注入**同一份**规范。

---

## 9. 写入防护、远程门禁与审批分级

### 9.1 防护矩阵（F1 归因修正后）

| 防护 | 本体位置 | 挂载后 |
|------|----------|--------|
| `wiki-raw-write-deny`（locked deny） | `src/shared/policy/defaultRules.ts:20-22`，匹配信号 `wiki-raw-target` | **零改动**；信号在 `toolCallGate.ts:607` 按词汇路径判定（`raw/`、`raw/<projectId>/` 均命中），语义不变。**绝对路径残余边界（v3-I1）**：模型以 realBase 绝对形态写 raw 时词汇分类会漏判（详见 §7.2 wiki-raw 行）——由**挂载反向识别**闭合（绝对入参先反向映射回词汇再判信号）；缓解因素：userData 绝对路径不对 Agent 暴露、远程/automation lane 另有 scope/sensitive deny 兜底 |
| 探测失败 fail-closed deny | `toolCallGate.ts:611-620, 909-910` | 不变（词汇层判定同样成立） |
| `remote-outside-write-deny` / `remote-write-scope-unknown-deny`（locked deny） | `defaultRules.ts:23-34`，匹配信号 `write-target-scope:outside-workdir / unknown` | **规则零改动**；信号由探测层修正（§9.2） |
| 执行层远程断言 `assertRemoteWriteTargetInsideWorkDir` | `builtinExecutors.ts:755-764,775` | 改按 scopeBase 结论断言（§9.2） |
| 写沙箱（逐段 lstat / 拒 symlink / 拒硬链接 / 拒目录目标） | `resolveSafeWriteTarget`（permit 兜底路径）与 permit identity 复核 | 挂载根替换，语义原样保留 |

### 9.2 远程 lane 的 wiki 命名空间写豁免（B1）

**问题**：远程（飞书/微信）lane 写目标必须 inside-workdir——策略层 locked deny 按 `write-target-scope` 信号，执行层 `assertRemoteWriteTargetInsideWorkDir` 按 realpath 断言。挂载后 wiki 真实根在 userData，两层都会 100% 拒绝远程 wiki 写，US-2 破产。

**设计**：wiki 挂载命中的写目标，在**范围语义上视同 workDir 内写**：

1. **信号层**：探测层以 `realBase` 为包含锚点（§7.2），`classifyWriteTargetScope` 产出 `inside-workdir` → 策略层 `remote-outside-write-deny` 自然不触发（规则文本零改动）；
2. **执行层**：`assertRemoteWriteTargetInsideWorkDir` 改为接收探测结论（scopeBase / 或直接传入挂载解析结果），挂载命中时对 `realBase` 断言包含，未挂载时维持 workDir 断言——**远程会话依旧不能写 workDir 与 wiki 之外的任何位置**，豁免面仅限 wiki 命名空间；
3. **确认流**：远程写 wiki 页走既有远程确认通道（飞书/微信审批交互），卡片展示 `llm-wiki/...` 词汇路径；
4. **`raw/**` 不豁免**：远程 ingest 仍走应用层 IPC（`wiki:import-raw`），模型直写 raw 在远程 lane 同样被 `wiki-raw-write-deny` 拒绝；
5. **读侧对称门禁（S1，v3-B7 修正）**：远程读有对称的 locked deny `remote-outside-read-deny`（`defaultRules.ts:41-46`，匹配读工具的 `path-target:outside-workdir` 信号，lane 集合更宽：wechat / feishu / **automation**）。**但注意：读侧的阻力不止这一条**——读探测产出的 zone 由共享分类器 `classifyReadPathZone` 判定且**敏感判定先于包含判定**，wiki 真实根迁入 userData 后 zone 会是 `sensitive-file`，命中 `path-sensitive-read-confirm`（desktop/wechat/feishu 逐次确认）与 `automation-sensitive-path-deny`（automation 直接 forbidden deny）。因此读侧放行需要**两个动作同时到位**：① 包含锚点切换为 `realBase`（中和 `outside-workdir`）；② zone 豁免经共享分类器生效（中和 `sensitive-file`，§7.2-B7 行、§9.3）。两者齐备后，挂载命中的读目标 zone = `workdir-normal`，四条读侧规则（`remote-outside-read-deny` / `automation-sensitive-path-deny` / `path-sensitive-read-confirm` / 默认放行档）全部回到与现状 workDir 内 wiki 读一致的行为，**规则文本零改动**；
6. **边界回归测试**：远程 lane 写四象限（wiki 页写 / raw 写 / workDir 外写 / 别名写）+ **远程与 automation lane 读 wiki 页通过、读 workDir 外仍拒绝**（§15.1）。

### 9.3 敏感 zone 豁免与审批分级（读 + 写；B3 / v3-B7）

**问题（写侧 + 读侧对称）**：zone 分类器 `classifyReadPathZone` 为读写共同消费（`writePathFacts.ts:191` 亦调用），内置敏感前缀含 userDataDir，且**敏感判定先于 workDir 包含判定**。wiki 迁入 userData 后若无豁免：

- **写侧**：`probeWritePathFact` 产出 `sensitive-file` zone，写审批分级漂移（v1-B3）；
- **读侧（v3-B7，后果更重）**：一切 wiki 读目标 zone = `sensitive-file` → desktop/wechat/feishu 命中 `path-sensitive-read-confirm`（locked，confirm-every-time，`defaultRules.ts:296-302`）——SCHEMA 守则要求「写前读 index + grep 查重」，每轮 wiki 维护至少 2–3 次真人确认；automation lane 命中 `automation-sensitive-path-deny`（locked forbidden，`defaultRules.ts:198-202`）100% 拒绝。§7.2 的包含锚点切换只作用于 `outside-workdir` 分支，**清除不了 sensitive zone**。

**设计**：

1. **豁免落点在共享分类器**：`classifyReadPathZone` 入参增加 `sensitiveRootExemptions: string[]`，**豁免优先**——`resolvedPath` 落在任一豁免前缀内 ⇒ 跳过全部敏感前缀匹配（必须短路全部前缀：userData 位于 home 之下，且内置敏感前缀含 `AppData\Roaming`、`~/Library` 等**祖先级前缀**（`shellSensitivePaths.ts:30-38`）——只移除 userDataDir 一条仍会被祖先级前缀命中，v4-N2）；zone 继续走 system-dir → 包含判定。读写探测的 `ProbeInput` 均透传该入参，gate 仅在 wiki 启用时传入 `[{userData}/llm-wiki]`——豁免面 = 共享库子树，一处声明、读写同时生效；
2. **目标分级语义（读写一致）**：挂载命中的 wiki **读或写**，审批分档 = **现状 workDir 内 `llm-wiki/` 读/写的分档**（读：desktop 默认免确认档 `read-target-workdir-allow`；写：现状 wiki 写档位），不因存储迁移变严或变松；`raw/**` 维持 forbidden 档；只读别名**写** → 显式拒绝（引导文案；别名**读**放行——它是历史自定义根链接打开的唯一通道，v4-C1 回改，v1.3 误写作「读写」）；
3. **分级映射测试（读写两张矩阵）**：写矩阵 {workDir 普通文件, workDir 内 wiki 页, 挂载 wiki 页, 挂载 raw, userData 其他路径, home 其他路径} × {desktop, wechat, feishu}；**读矩阵（B7）** {挂载 wiki 页读, 挂载 wiki 目录 grep, userData 其他路径读, home 其他路径读} × {desktop, wechat, feishu, **automation**}——特别断言「**automation 读挂载 wiki 页通过、读 userData 其他路径仍 deny**」「desktop 读挂载 wiki 页免确认、读 userData 其他路径仍逐次确认」，防止豁免面外溢（§15.1）。

### 9.4 并发互斥（I6 修正声明）

共享后多并行会话可能同时写 `wiki/index.md` / `log.md`。方案：主进程内**文件粒度异步互斥**（`electron/wiki/wikiWriteMutex.ts`，`Map<absPath, Promise>` 串行队列）：

- **防护范围（如实声明）**：互斥区包住**单个写执行体**——`edit_file` 内部的读-改-写完整受保护；`write_file` 的整文件替换原子化（temp + rename）。互斥能防**同文件内容撕裂/交错**；
- **不防护的范围**：跨工具调用的竞态——两个会话各自「读 index.md → 修改 → 写回」时，后完成的写入会覆盖先完成的写入（ lost-update），互斥防不了这个。缓解靠 **SCHEMA 协作守则**（先读后写、优先更新既有页、log 追加式写）。若未来共享写入频率高到守则不够用，再评估「写回前校验文件未被他人修改（mtime 比对，不一致则要求重读）」——本需求不实现。
- Ingest、迁移写入同样经互斥区；
- **单实例约束**：多开应用实例同时写共享 Wiki 首版不支持（temp-rename 降低撕裂概率但不承诺跨实例一致）。

> 按 AGENTS.md 纪律，该互斥模块必须配**随机操作序列 + 不变量断言**测试（§15.2）。

---

## 10. IPC 与配置变更

### 10.1 IPC 变更清单

| 通道 | 变化 |
|------|------|
| `wiki:init` | 语义变为「初始化共享库骨架 + 安装用户级技能」；不再接受 rootPath 自定义（payload 不变，实现内忽略） |
| `wiki:status` | 返回结构不变（`rootPath` 仍为 `llm-wiki`）；新增可选字段 `shared: true`、`projectCount`、`pendingLegacyMigration`、`legacyRoots: string[]`（检测到的存量根，含自定义根）、**`projects: Array<{ projectId, displayName, workDir, orphan }>`（WikiPane raw 节点展示名数据源，v1.12 补）** |
| `wiki:import-raw` | 目标改为 `raw/<projectId>/...`；返回值 `rawRelPath` 仍是 `llm-wiki/raw/...` 词汇 |
| `wiki:get-schema` | 行为不变（内部经挂载） |
| `wiki:resolve-path` | 判定逻辑不变；识别只读别名并标 `readOnly` |
| **新增** `wiki:migrate-legacy` | 触发存量迁移（§12），payload `{ profileIds?: string[], extraLegacyRoots?: Array<{ workDir: string; rootDirName: string }> }`（`extraLegacyRoots` 为 S3 手工指定入口）；返回迁移报告 |
| **新增** `wiki:migration-status` | 查询迁移状态（未检测 / 可迁移 / 已完成 / 失败可重试），驱动 WikiPane / 设置页入口 |
| `file:*` 子通道 | 见 §7.4 处置表（签名不变） |

`preload.ts` / `src/shared/api.ts` 同步补齐两个新通道。

### 10.2 数据库与配置变更

- `migrations.ts` 版本 +1：建 `wiki_projects` 表（§6.2）；
- 迁移状态存 config：`config.wiki.migration = { status, completedAt, report, legacyRootAliases }`；**实现时收敛 `config.wiki` 键定义**（v3-S1：现存在 `main.ts:132` 局部 `WIKI_CONFIG_KEY` 与 `ipcShared.ts:126` `CONFIG_KEYS.wiki` 两处并存，新增第三处前先归一，避免再添硬编码）。

---

## 11. UI 变更

| 界面 | 变更 |
|------|------|
| WikiPane | 主体词汇零改动；新增：① `pendingLegacyMigration` 时顶部提示条「检测到 N 个项目的本地 Wiki（含自定义根目录），迁移到共享记忆库」→ 迁移向导；② raw 节点按 `raw/<projectId>/` 展示，显示 `display_name`（数据来自 `wiki:status.projects`，tooltip 常驻完整路径，对齐 §6.2 决议）；③ 面板内打开的 wiki 文件若已被迁移改名（冲突双保留），给出「该文件已合并至 …」提示（§12.3，F4 缓解） |
| 设置页 WikiTab | `rootPath` 改为「共享库目录名」可编辑项（改名 = 受控 rename，§6.3；存量自定义根尚未迁移时先展示迁移引导而非直接改名）；新增「迁移本地 Wiki」入口与报告查看、「打开共享库目录」按钮 |
| 聊天区 | 无变化（`llm-wiki/...` 链接照常）；旧自定义根链接以普通文件链接形态打开（§7.5 已决议：不做渲染端别名识别，内容不丢、仅打开位置不同） |
| 文件列表 | `hideWikiFromFileTree=false` 时根部显示虚拟 `llm-wiki` 条目（§7.4-I1） |
| i18n | 新增文案入 `src/renderer/i18n/resources/{zh-CN,en-US}/wiki.json`（WikiTab 相关入 `config.json` 的 `wiki.*` 节）；zh-CN 为真实来源，跑 `i18n:generate-types` + `i18n:check` |

---

## 12. 存量迁移方案

### 12.1 检测（含自定义根，B4）

`wiki:migration-status` 在启动 / 打开 WikiPane 时执行轻量检测：

- **扫描根集合**：对每个 workDir profile，同时检查 `{workDir}/llm-wiki/` 与 **`{workDir}/<存量配置 rootPath>/`**（升级前 DB 中 `config.wiki.rootPath` 的历史值，≠ `llm-wiki` 时两者都扫）——自定义根用户不被发现即被抛弃是不可接受的；
- **已知边界（S3）**：`config.wiki.rootPath` 只保留**最近一次**自定义值；历史上多次修改根目录的更早期根不在自动扫描集合内。处置：① 本边界在迁移向导中明示（「未找到你的旧 Wiki？可手动指定旧目录名」）；② `wiki:migrate-legacy` 的 payload 增加 `extraLegacyRoots?: Array<{ workDir: string; rootDirName: string }>`，允许用户在向导中**手工指定**额外旧根（逐 profile 或全局），指定根走同一合并管线并同样注册只读别名；
- 旧结构特征：存在 `SCHEMA.md` 或 `wiki/index.md`；
- 共享库未初始化（无 v2 meta）且存在任一旧根 → `migratable`；已初始化但仍有未迁移 profile → `migratable`（增量补迁）；
- 自定义根被纳入迁移时，`legacyRoots` 字段返回给 UI 明示。

### 12.2 合并策略（`wiki:migrate-legacy`，幂等可重试）

按 profile 逐个处理。**语义是「幂等可重试」，不是事务**（文件系统操作无回滚；实现按目标存在性幂等跳过，失败后重跑收敛，不引入伪事务机制——I7）：

| 对象 | 策略 |
|------|------|
| `raw/*` | 整体拷入 `raw/<projectId>/`；重名由项目目录天然隔离 |
| `wiki/**` 页面 | 与共享库逐一比对：无冲突 → 拷入；同路径内容相同 → 跳过；内容不同 → 后合并方存为 `<name>.from-<projectId>.md`，报告中列「待人工合并」，两页头部互加平行版本提示行 |
| `wiki/index.md` | 不直接覆盖：各项目条目按分类归入对应小节追加合并，冲突条目并列并标注来源 |
| `wiki/log.md` | 按条目时间戳归并排序，注入 `[project:<id>]` 前缀 |
| `SCHEMA.md` | 内容哈希等于旧默认模板 → 替换为新版共享模板；已被修改 → 存为 `SCHEMA.legacy-<projectId>.md` 供人工比对，共享库用新版模板 |
| `.wiki-meta.json` | 不迁移（新结构 v2 自建）；旧文件随旧目录保留 |
| **自定义根（B4）** | 与默认根同等对待：`{workDir}/<customRoot>/` 全量按上述策略合并；迁移完成后 `customRoot` 名写入 `legacyRootAliases`（§6.3），主进程挂载层与 `wiki:resolve-path` 识别为只读别名——历史链接可打开 |
| 项目级技能副本 | 删除 `{workDir}/.space-skills/llm-wiki/`（§8.1 覆盖陷阱） |
| 旧目录收尾 | 成功后整目录改名 `{workDir}/<wikiRoot>.migrated-{YYYYMMDD-HHmmss}/`（含自定义根），**永不自动删除** |

- 用户可选「暂不迁移」：共享库从空白开始，旧目录原样保留，设置页可随时再触发；
- 迁移报告（各 profile 结果 / 合并数 / 冲突清单 / 改名映射 / 跳过项）写入 `config.wiki.migration`，设置页可查看；
- 激活 profile 正在运行会话时提示建议空闲执行，不强制中断。

### 12.3 改名映射与缺失提示（F4 缓解重提）

冲突双保留会令部分历史链接指向改名后的文件。缓解（不依赖不存在的「文件不存在态」）：

1. 迁移报告记录**改名映射表**（原词汇路径 → 新词汇路径），设置页可查；
2. WikiPane / 文件面板打开失败（read-file 报错）时，查改名映射：命中则提示「该文件已合并至 <新路径>」并提供跳转；未命中则展示通用读取失败提示（新增的最小 UI 态）；
3. `llm-wiki` 词汇本身在合并入空共享库时首迁方保留原路径，多数链接不受影响；冲突改名仅发生在多项目同路径碰撞场景。

---

## 13. 错误与边界

| 场景 | 行为 |
|------|------|
| userData 不可写（磁盘满 / 权限） | `wiki:init` / 写入走既有错误通道；WikiPane 状态条展示；**不降级回写 workDir**（避免再次分叉） |
| `{userData}/llm-wiki` 被用户删除 | 视为未初始化，`wiki:status` 返回 `initialized: false`，引导重新初始化 |
| 旧 workDir 中的 wiki 目录残留（未迁移） | 不参与读写：Agent 词汇路径统一经挂载指向共享根（迁移前共享根可能为空，属预期，引导先迁移）；workDir 侧根扫描排除该实体前缀（§7.7）；目录本身仅作为迁移检测依据 |
| 远程 IM 会话写 wiki | 与桌面 lane 同等可用（§9.2）；写 `raw/**` 仍拒绝 |
| 迁移中断（进程退出） | 已写文件保留；重跑按目标存在性幂等跳过，报告标注「上次未完成」 |
| 迁移前已打开的 wiki 文件（面板正开着） | 迁移改名旧目录后，已建立在旧物理路径上的内容监听失效，面板保留最后一次读取的内容；**瞬态自愈**——重新打开即经挂载指向共享库版本、实时刷新恢复；不做主动通知或监听迁移机制 |
| 会话 pin 的 workDir 对应 profile 被删除 | `wiki_projects.orphan = 1`，历史 raw 分区与页面保留；ingest 按当前 workDir 重新计算 projectId |
| Agent 写只读别名路径 | 显式拒绝 + 引导文案（指向 `llm-wiki/` 新路径） |
| Agent 试图写 `raw/`（含 `raw/<projectId>/`） | `wiki-raw-write-deny` 拒绝（规则本体不变） |
| grep 全库搜索 | 双根并集（§7.2）；超时/降级**逐根独立**，单根降级不影响另一根结果 |
| shell / 内嵌终端访问 `llm-wiki/...` | **不挂载**（shell cwd 恒为 workDir）：迁移后路径 ENOENT。SKILL 模板显式禁止 shell 访问 wiki（§8.2），风险 R7 跟踪 |
| 微信发送文件工具引用 wiki 文件 | `weChatToolExecutor.ts:35` 独立解析点：**已决议不做挂载豁免（原 OQ-1，2026-10-10）**。实际失败链路（v1.8 据代码核实，替代 v1.3 的专用文案承诺）：① 主路径为门禁拦截——media 探测经挂载锚点拿到 userData 真实路径 → `wechat-media-target:outside-workdir` → locked deny 提示**「微信附件只能来自当前工作目录内的文件」**（`defaultRules.ts:48-53`，规则文本零改动）；② 兜底为执行层 `readMedia` 捕获后返回**「文件路径不在工作目录范围内」**（`weChatToolExecutor.ts:45-49`）。提示准确且自然引导 Agent 自恢复：读 wiki 页（挂载读已放行）→ 在 workDir 内写副本 → 发送副本，全程远程 lane 合法；**不做专用 deny 文案**（需新增 locked 规则，违反 `defaultRules` 零改动）。瞬态边界：迁移完成前的残留期，发送工具不经挂载解析、读到 workDir 物理残留（可能为旧版内容），迁移完成后自动转为上述门禁拒绝 |
| 飞书 / 微信远程会话（其余能力） | 走同一 `toolChatLoop` 与文件工具链路，随 §7.2/§9.2 自动获得共享库读写 |

---

## 14. 安全与权限

- **沙箱根替换而非放宽**：wiki 命名空间内的读写，安全解析（词法边界、realpath 包含、逐段 lstat、拒 symlink/硬链接）以 `{userData}/llm-wiki` 为根原样执行；挂载**单向**——只有显式命中 `<wikiRoot>/` 或只读别名前缀才映射，Agent 无法借 wiki 路径触达 userData 其他文件（数据库、`secrets`、spill）；
- **敏感 zone 豁免面最小化（读写一致，v3-B7）**：`sensitiveRootExemptions` 挂在共享分类器 `classifyReadPathZone` 上，仅含 `{userData}/llm-wiki` 精确子树、仅在 wiki 启用时传入；豁免优先语义只压制敏感 zone 判定，**不放松任何包含校验与 system-dir 判定**；userData 内 wiki 子树之外的全部路径（含 home 其余范围）分级行为与现状逐字节一致；
- **远程豁免面最小化**：远程 lane 的写豁免仅限 wiki 命名空间（§9.2），workDir 之外的其余位置照旧拒绝；
- **不暴露绝对路径给渲染层**：审批卡片、审计日志、WikiStatus 均用词汇路径；「打开目录」由主进程解析；
- **raw 只读性不变**；日志脱敏链路不变。

---

## 15. 测试与验收标准

### 15.1 单元 / 契约测试（vitest，electron 项目）

| 模块 | 用例要求 |
|------|----------|
| `wikiMount` | 前缀命中/未命中、绝对/相对入参、Windows 反斜杠、`..` 穿越、单次重映射、未启用不挂载、只读别名命中 |
| **三层一致性（B2）** | 同一入参下 `writePathFact.normalizedPath === permit 目标 === 执行层落盘路径`；`fact.vocabularyPath === Agent 词汇入参`；执行层二次比对失配 → fail-closed |
| **敏感 zone 豁免（B3/B7，共享分类器）** | `classifyReadPathZone` 豁免语义：豁免前缀命中 ⇒ 跳过全部敏感匹配（含 home 祖先命中）；wiki 子树 zone = `workdir-normal`（读写探测一致）；userData 其他路径、home 路径照旧 sensitive；豁免未传（wiki 停用）时行为与现状逐字节一致 |
| **分级映射矩阵** | **写矩阵（B3）**：{workDir 普通文件 / workDir wiki 页 / 挂载 wiki 页 / 挂载 raw / userData 其他 / home 其他} × {desktop, feishu, wechat}；**读矩阵（B7）**：{挂载 wiki 页读 / 挂载 wiki 目录 grep / userData 其他读 / home 其他读} × {desktop, wechat, feishu, **automation**}——断言「automation 读挂载 wiki 页通过、读 userData 其他仍 deny」「desktop 读挂载 wiki 页免确认、读 userData 其他仍 confirm-every-time」 |
| **远程边界回归（B1/S1/B7）** | 写：远程 lane × {wiki 页写（通过）、raw 写（deny）、raw 绝对形态写（deny，I1 反向识别）、workDir 外写（deny）、只读别名写（deny+引导）}；信号 `write-target-scope` 断言。读：feishu / wechat / automation lane 读挂载 wiki 页（**通过，依赖 §9.3 zone 豁免——缺豁免则 automation 撞 `automation-sensitive-path-deny`、desktop/wechat/feishu 撞 `path-sensitive-read-confirm`，用例即转红**）、读 workDir 外（deny）；信号 `path-target` zone 断言（防漏改锚点与豁免任一项）。**发文件（v1.8 决议）**：wechat_send/wiki 附件路径 → `wechat-media-target:outside-workdir` → deny 且文案为「微信附件只能来自当前工作目录内的文件」（§13，无 wiki 专用文案） |
| `defaultRules` 契约 | locked deny 规则集 diff 为空（规则文本零改动的回归保障，含 `remote-outside-read-deny`） |
| `builtinExecutors` | 挂载命中读写落 userData、未命中落 workDir；permit 兜底路径在 wiki 根下的拒 symlink / 拒硬链接 / 拒目录目标逐条红绿 |
| `grepScope` | `planGrepInvocation` 双根规划、path 挂载解析、结果词汇路径改写、逐根降级、排序确定性；**去重（S2）：workDir 内残留实体 `llm-wiki/` 目录不被 workDir 根扫入，同词汇路径结果唯一** |
| **命名不写死（D9）** | 源码扫描断言：除共享常量定义处与**显式白名单**（`wikiTemplates.ts` 模板正文、测试 fixture、i18n 文案、`legacyRootAliases` 数据——这些天然含 `'llm-wiki'`，v4-N3）外，源码无 `'llm-wiki'` / `"llm-wiki"` 散落字面量（grep 断言纳入 CI 可跑的测试）；`realBase` 派生自 `wikiConfig.rootPath`；改名流程（配置 + rename + 失效广播）行为测试 |
| `wikiPaths` 既有契约 | `wiki.test.ts` 现有断言全绿（词汇层行为不变） |
| `wikiImport` | ingest 目标 `raw/<projectId>/`、重名 auto-rename、跨 workDir 来源 |
| **fileIpc 子通道（B6）** | watch-content wiki 文件监听生效 + 切 workDir 停止；export-markdown wiki 页图片解析根跟随；delete/rename 同侧映射；copy 跨边界成功；move 跨边界显式拒绝 |
| 虚拟根条目（I1/S2） | `list-directory ''` 合成 `llm-wiki` 条目（`hideWikiFromFileTree=false`）；`true` 时不合成；**workDir 内存在实体残留目录时仅返回虚拟条目、不双列（§7.7）** |
| 迁移 | fixture 双旧 wiki（含一个自定义根 profile）：无冲突合并、冲突双保留、index/log 归并、SCHEMA 哈希分叉、别名注册、幂等重跑、旧目录改名；**`extraLegacyRoots` 手工指定根走同一管线并注册别名（S3）** |
| `wikiWriteMutex` | **不变量测试**：mulberry32 随机 write/edit 序列，断言「同文件最终内容 = 按互斥区进入顺序串行应用」「不同文件可交错」「队列清空无死锁」；破坏互斥的实现应转红 |
| `skillScanner` 交互 | 用户级 llm-wiki 生效；迁移后无项目级副本 |

### 15.2 需真机 / 手工验收项（与单测边界对齐）

- 多 profile 真实切换：项目 A 沉淀 → 项目 B 查询（US-1）；**并行双会话同写 index.md 无内容撕裂**（lost-update 场景按守则缓解，不承诺消除）；
- **飞书 / 微信远程会话：ingest + 写 wiki 页全链路**（US-2，B1 修复的真机确认）；
- 迁移向导完整 UI 流程（检测含自定义根 → 执行 → 报告 → 旧目录确认 → 别名链接打开）；
- WikiPane 刷新（版本失效链路）、聊天历史链接（`llm-wiki/...` 与旧自定义根）、`fileShowInExplorer`、wiki 文件 watch-content 实时刷新、export-markdown 图片；
- 打包模式（非 dev）userData 路径与 `-dev` 隔离；
- i18n：`npm run i18n:check`、zh/en 完整性。

### 15.3 验收命令约定

按 AGENTS.md 纪律：开发期定向测试（`npm exec vitest run <files>`），每 Phase 收尾 `npm run test:electron` + `build:electron:incremental`，最终验收全量 `npm test` + `npm run build`。

---

## 16. 发布计划

**硬约束（B5）：P1 与 P2 必须同一版本发布。** 不允许出现「写入已切共享库、旧数据原地保留但无迁移入口」的用户可见版本——该表象等同数据丢失。P0 可随任意前置版本先发（纯基建，行为不变）。

| Phase | 内容 | 可验证交付 | 发布约束 |
|-------|------|-----------|----------|
| **P0 基建** | `wikiMount` + `wikiWriteMutex` + `wiki_projects` 表迁移 + 配置字段（`rootPath` 新语义 / `legacyRootAliases` 等）+ **共享词汇常量定义（D9）**；不接调用方 | 单测绿；`build:electron:incremental` 通过 | 可独立发（行为不变） |
| **P1 主进程切换** | 探测层（writePathFacts / readPathFacts / **共享分类器 zone 豁免**）、permit、执行层（builtinExecutors / **grep 双根编排层（v3-I3：新增编排 + 结果合并，非单字段改动）**）、wiki-raw 反向识别（I1）、远程断言、fileIpc 子通道（含 export-markdown 实改与 watcher 挂载解析）、`wikiInit`/`wikiStatus`/`wikiImport` 切共享根、技能用户级 | 定向测试 + `test:electron`；桌面 + 远程/automation lane 读写共享库冒烟 | **必须与 P2 同版本** |
| **P2 迁移与引导** | 迁移检测（含自定义根）/ 执行 / 报告 IPC + WikiPane / 设置页向导 UI + 只读别名 + 改名映射提示 + i18n | 迁移单测 + 真机向导流程 | **必须与 P1 同版本** |
| **P3 收尾** | 旧项目级技能副本清理扫尾、文档升位（`llm-wiki-requirement.md` → v1.7 增补存储章节）、**散落字面量清理收口（D9：`markdownExport.ts:54`、`ChatMarkdown.tsx:60` 等改引共享常量，F5 一并）**、全量验收 | 全量 `npm test` + `npm run build` + 手工清单 | 可滞后一版 |

措辞修正（v1.0 矛盾处）：行为完全不变的是 **P0**；P1 起共享库为唯一写入目标，同版本的 P2 保证旧数据可见可迁。

---

## 17. 风险与待解决问题

| # | 风险/问题 | 缓解 |
|---|-----------|------|
| R1 | 项目级旧技能副本覆盖用户级新技能（`skillScanner.ts:49-52` user→project→bundled 覆盖序） | 迁移与 init 强制清理项目级副本；P1 单测覆盖 |
| R2 | 多开实例并发写共享库 | 首版单实例约束 + temp-rename 原子写；跨进程锁列为未来工作（不挂 OQ，v4-N1） |
| R3 | 全局知识混入项目噪音 | `wiki/projects/` 专属分区 + SCHEMA 协作守则约束归档判据；`raw/<projectId>/` 目录结构与页面 `project:` 标注保证来源可追溯（仅为溯源约定，不承载过滤类功能） |
| R4 | 用户对 userData 位置无感知 | 设置页/WikiPane 展示存储位置与「打开目录」入口；文档说明 |
| R5 | grep 双根并集性能与排序稳定性 | 并集落在 `planGrepInvocation` 规划层（F8）；超时/降级逐根独立；测试覆盖排序确定性 |
| R6 | 历史链接指向迁移中改名的页面（冲突双保留） | 改名映射表 + 面板打开失败时「已合并至 …」提示与跳转（§12.3；v1.0 所引 `MarkdownLinkOrStatusDot` 缺失态不存在，F4 已重提缓解） |
| R7 | shell / 内嵌终端绕过挂载（cwd 恒为 workDir，`runShellPlan.ts:125`），`cat llm-wiki/...` 迁移后 ENOENT | SKILL 模板显式禁止 shell 访问 wiki（§8.2）；不做 shell 侧挂载（越权面过大）；文档与错误提示引导 |
| R8 | 微信发送文件工具独立解析（`weChatToolExecutor.ts:35`），远程发送 wiki 文件失败 | **已决议不做豁免（2026-10-10）**：门禁 deny 提示「微信附件只能来自当前工作目录内的文件」准确且可引导 Agent 自恢复（读 wiki → workDir 副本 → 发送）；失败链路与瞬态边界见 §13 |
| R9 | 探测层与执行层挂载状态漂移（迁移中途改配置等） | 执行层二次挂载比对 fail-closed（§7.2） |

### 待解决问题（OQ）

> 定位声明：本次需求为**存储重构，不新增用户可见功能**；曾列出的 OQ（按项目过滤标记、库导出、渲染端别名识别、IM 展示名、乐观并发、微信发文件豁免、watcher 单例）已全部决议并落入正文对应章节，**当前无未决项**。

---

## 18. 相关文件清单

**主进程（改动核心）**

- `electron/wiki/wikiMount.ts`（新增：唯一挂载决策点）
- `electron/wiki/wikiWriteMutex.ts`（新增：文件粒度写互斥）
- `electron/wiki/wikiMigration.ts`（新增：存量检测与合并，含自定义根与别名注册）
- `electron/wiki/wikiPaths.ts` / `wikiInit.ts` / `wikiStatus.ts` / `wikiImport.ts` / `wikiTemplates.ts` — 根切换、模板更新、projectId 注入
- `electron/confirmation/extractors/writePathFacts.ts` — 挂载锚点、`vocabularyPath`/`scopeBase`、透传共享分类器豁免
- `electron/confirmation/extractors/readPathFacts.ts` — 挂载锚点；**`classifyReadPathZone` 增加 `sensitiveRootExemptions`（B7 核心落点，读写共同生效）**
- `electron/confirmation/readPermitExecutor.ts` — 读 permit 挂载前置解析
- `electron/confirmation/writeExecutionPermit.ts`、`electron/confirmation/toolCallGate.ts` — permit 双字段、scope 分类基准、一致性守卫（**`src/shared/policy/defaultRules.ts` 零改动**，仅加契约测试）
- `electron/tools/builtinExecutors.ts` — 写执行体挂载接入、远程断言改造（`:755-778`）、grep path（`:1818`）
- `electron/tools/grepScope.ts` — `planGrepInvocation` 双根规划（`:108`）
- `electron/ipc/fileIpc.ts` + `electron/fileContentWatcher.ts` — §7.4 处置表
- `electron/ipc/agentProtocolIpc.ts`（wiki IPC + SCHEMA 注入 `:721-723` + 事件源 `:1301`）、`electron/ipc/configIpc.ts`、`electron/ipc/ipcShared.ts`
- `electron/skills/skillPaths.ts` / `skillScanner.ts`（只读确认）/ `skillManager.ts`
- `electron/workDirManager`（workDir 规范化与展示名）
- `electron/database/schema.ts`、`migrations.ts`（`wiki_projects` 表）
- `electron/preload.ts`、`src/shared/api.ts`（新通道）
- `electron/fileTreeSyncNotify.ts`（wiki 写入后的失效广播调用方，出口本身不改）

**渲染进程**

- `src/renderer/components/WikiPane/WikiPane.tsx`（迁移提示条、projectId 展示名、合并改名提示）
- `src/renderer/components/Config/WikiTab.tsx`（rootPath 只读、迁移入口与报告）
- `src/renderer/components/DetailPanel/DetailPanelFileList.tsx`（仅确认：`hideWikiFromFileTree` 过滤按配置值实现，词汇不变则零改动，v3-F3）
- `src/renderer/i18n/resources/{zh-CN,en-US}/wiki.json`、`config.json`（新增 key）

**共享类型与常量**

- `src/shared/domainTypes.ts`（`WikiConfig.rootPath` 语义注释、`legacyRootAliases`、`WikiStatus` 可选字段、虚拟目录条目 `virtual` 标记）
- `src/shared/wikiConstants.ts`（新增：词汇前缀等 Wiki 常量的**唯一定义点**，主进程与渲染进程统一引用，D9）

**文档**

- 本文档；`llm-wiki-requirement.md`、`wiki-import-ingest-requirement.md` 升位（P3）

---

## 附录 A：评审修订对照表

| 评审项 | 处置 | 落点章节 |
|--------|------|----------|
| B1 远程写门禁冲突 | wiki 写视同 workDir 内写：信号层 + 执行层断言双重修正；locked deny 规则文本零改动；远程边界回归测试 | §9.2、§15.1 |
| B2 接入点过时假设 | §7 全节重写：`probeWritePathFact`/`readPathFacts`/permit/执行层双侧接入 + 一致性守卫与论证；现状架构补 §3.5 | §3.5、§7.1-7.2 |
| B3 userData 敏感根分级 | `sensitiveRootExemptions` 显式豁免 + 目标分级语义（= 现状 wiki 写档位）+ 分级映射测试 | §9.3、§15.1 |
| B4 自定义 rootPath 抛弃 | 迁移检测扫存量配置根 + 合并 + `legacyRootAliases` 只读别名 + WikiTab 迁移引导 | §6.3、§12.1-12.2、§11 |
| B5 发布回退窗口 | P1+P2 同版本硬约束；「行为不变」措辞修正为 P0 | §16 |
| B6 fileIpc 子通道 | 逐一处置表：watch-content 真实路径监听、export-markdown 图片根跟随、delete/rename/move/copy 跨边界语义 | §7.4 |
| I1 根列表虚拟条目 | `list-directory ''` 合成虚拟 `llm-wiki` 条目 + 测试 | §7.4、§15.1 |
| I2 shell 绕过挂载 | R7 + SKILL 模板显式禁止 shell 访问 wiki | §8.2、§13、§17 |
| I3 微信发送文件独立解析 | 已决议不做豁免（2026-10-10）：门禁 deny 文案准确并可引导 Agent 自恢复，失败链路见 §13 | §13、§17-R8 |
| I4 wiki_projects UNIQUE 冲突 | projectId 一律取 workDir 哈希；profileId 降为展示元数据列 | §6.2 |
| I5 无 profile 分支不清 | 同上：哈希方案下分支消解 | §6.2 |
| I6 互斥声明夸大 | 防护范围如实声明（单写执行体）；跨调用竞态由守则缓解（乐观并发本需求不实现，平实表述见 §9.4） | §9.4 |
| I7 「事务性迁移」措辞 | 统一为「幂等可重试」，明确不引入伪事务 | §12.2 |
| F1 deny 规则归因 | 信号（`toolCallGate.ts:607`）与规则本体（`defaultRules.ts:20-22`）分开表述 | §3.2、§9.1 |
| F2 WikiPane 事件引用 | 改为 `fileTreeSyncNotify.ts:10` 版本失效广播链路 | §3.6、§7.6 |
| F3 技能合并顺序 | 补 bundled 段（user→project→bundled）；llm-wiki 不在 bundled 的核实结论 | §8.1 |
| F4 R6 缓解不存在 | 重提：改名映射 + 面板「已合并至」提示（新增最小 UI 态） | §12.3、§17-R6 |
| F5 expandWikilinks 硬编码 | 纳入清单 + D9 字面量清理（P3 交付） | §3.3、§18 |
| F6 i18n 文件名 | 更正为 `wiki.json` / `config.json` wiki.* 节 | §11、§18 |
| F7 会话 pin 通道 | 更正为 `session:update` payload | §1.1、§3.4 |
| F8 grep 接入层 | 双根并集落在 `planGrepInvocation` 规划层 | §7.2、§17-R5 |
| S1 读侧对称门禁 | `remote-outside-read-deny` 显式说明：读探测锚点切换覆盖 wechat/feishu/automation 三 lane；读 deny 规则文本零改动；远程/自动化读回归用例 | §9.2、§15.1 |
| S2 实体残留去重 | 挂载启用期间 workDir 侧根扫描排除挂载词汇前缀实体目录；虚拟条目不与实体双列；语义声明（迁移前 Agent 读到空共享根属预期） | §7.7、§7.4、§13、§15.1 |
| S3 历史自定义根边界 | 检测仅覆盖最近一次自定义值的边界明示；`extraLegacyRoots` 手工指定入口走同一合并管线 | §12.1、§10.1、§15.1 |
| **v3-B7（阻断）读侧敏感 zone 未豁免** | 豁免落点上移到共享分类器 `classifyReadPathZone`（读写探测共同消费），豁免优先语义（压过 home 祖先命中）；分级语义推广到「wiki 读写」；§15.1 补读侧分档矩阵（含 automation）；§9.2-5 automation 结论修正（仅锚点切换不足以放行） | §3.5、§7.2、§9.2-5、§9.3、§14、§15.1 |
| v3-I1 raw 绝对形态降级 | wiki-raw 信号判定前经 `resolveWikiMount` 反向识别，绝对入参映射回词汇再分类；残余风险声明（绝对路径不对 Agent 暴露 + 远程兜底） | §7.2、§9.1、§15.1 |
| v3-I2 resolve-path absPath | `wiki:resolve-path` 的 `absPath` 同步经挂载解析为真实路径 | §7.4 |
| v3-I3 grep 双根成本 | 明确为新增双根编排层（每根各 plan 各执行 + head_limit/truncated 口径 + 无匹配文案 + 排序确定性），工作量计入 P1 | §7.2、§16 |
| v3-I4 export-markdown extraRoots | 更正：source 走 `resolveSafePath`（无 extraRoots 形参），实改 = source 挂载解析 + 图片调用点补传 extraRoots | §7.4 |
| v3-F1 fileContentWatcher 路径 | `electron/tools/fileContentWatcher.ts` → `electron/fileContentWatcher.ts` | §3.5、§7.4、§18 |
| v3-F2 MarkdownAnchor 路径 | `Chat/MarkdownAnchor.tsx` → `shared/MarkdownAnchor.tsx` | §3.3、§7.5 |
| v3-F3 文件列表过滤引用 | 更正为 `DetailPanelFileList.tsx:29-33`（按配置值过滤，非硬编码；`domainTypes.ts:468-482` 仅类型） | §3.3、§18 |
| v3-F4 shell cwd 引用 | 更正为 `runShellPlan.ts:125`（`builtinExecutors.ts:2120` 是 run_script 的 cwd） | §3.5、§17-R7 |
| v3-F5 scope 信号值 | 信号值实为 `inside-workdir / outside-workdir / unknown`；`unknown` 来自 gate catch 兜底（`toolCallGate.ts:593-594`） | §3.5 |
| v3-S1 config 键收敛 | `config.wiki` 键两处并存（`main.ts:132` / `ipcShared.ts:126`），新增 `config.wiki.migration` 前先归一 | §10.2 |
| v3-S2 硬编码即既有缺陷 | 升级为 D9 正式交付：物理目录名读配置、词汇前缀单点常量，三处 `'llm-wiki'` 散落字面量 P3 清理完毕并以扫描断言守护 | §4.1-D9、§6.3、§15.1 |
| v3-S3 watcher 单例 | 已决议维持单例（与单文件详情面板 UI 语义匹配），多面板形态出现时再议 | §7.4、§17 |
| v3-S4 permit toolName 联合 | `WriteExecutionPermit.toolName` 仅含 write/edit，未来新增写 userData 工具需扩展联合与校验（备注于写 permit 行） | §7.2 |
| 用户反馈（v1.4）范围收敛 | 删除 OQ-1/OQ-2 两项功能探路；OQ 节加「不新增用户可见功能」定位声明 | §1.3、§17 |
| 用户反馈（v1.5）命名不写死 | D9：物理目录名配置化（rootPath 语义变更 + 可改名）、词汇前缀单点常量、字面量清理升级为交付项；删除晦涩的乐观并发 OQ（并入 §9.4 平实表述） | §4.1-D9、§6.3、§7.1、§9.4、§15.1、§16、§18 |
| 用户反馈（v1.6）旧链接别名识别决议 | 原 OQ-1 决议不做（极小众场景、降级后果轻）；写入正文为明确边界；OQ 缩至 3 项 | §7.5、§11、§17 |
| 用户反馈（v1.7）IM 展示名决议 | display_name 取名规则定案（profile 名 → basename → 重名追加父目录 → tooltip 完整路径）；OQ 缩至 2 项 | §6.2、§17 |
| 用户反馈（v1.8）微信发文件决议 | 不做豁免；据代码核实失败链路并撤回专用文案承诺（守 `defaultRules` 零改动）；补自恢复路径与瞬态边界；OQ 缩至 1 项 | §13、§15.1、§17-R8 |
| 用户反馈（v1.9）迁移瞬态澄清 | 补记「迁移前已打开文件」的监听失效为瞬态自愈边界，不做主动处理 | §13 |
| 用户反馈（v1.10）watcher 单例决议 | 维持单例，OQ 清零 | §7.4、§17 |
| v4 复审（通过，无阻断） | **C1** 别名读写笔误回改为「写拒绝/读放行」；**C2** §7.1 规则 2 realBase 绝对形态反向命中；**C3** §7.2 微信 media 探测接入行；**N1** R2 悬空引用；**N2** 祖先级前缀措辞 + 行号 :23；**N3** D9 扫描白名单 | §4.1-D9、§3.5、§7.1、§7.2、§9.3、§15.1、§17 |
