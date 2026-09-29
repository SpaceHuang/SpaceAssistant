# Docs Wiki Log

追加式日志。每条以统一前缀开头，便于 grep：`## [ISO8601] <operation> | <summary>`

## [2026-09-26T00:00:00] schema | 建立 Docs Wiki 分类机制（v1.0）

- 新建 `docs-wiki/`，分类主轴取自 agent-sdk-architecture-design 的 3 边界 / 11 模块
- 新增宿主扩展域 5 个（p-ui、p-delivery、p-automation、p-workspace、s-context）
- 新增 front matter 强制规范（pageType / docType / module / codeAnchors / status）
- 索引改为三级分层（顶层 index → 模块 _index → 卡片）
- 未 ingest 任何文档；未修改 `docs/` 与 `raw/`

## [2026-09-26T00:00:00] schema | 新增横切综述机制（v1.1）

- `cross/` 提升为跨模块层，拆分为 `views/`（封闭集合，架构图 5 视图）与 `overviews/`（开放集合）
- 新增 pageType：`view`、`overview`；`overview` 省略 `module`，改用 `covers`（≥ 2 个模块）
- 新增 front matter 字段：`origin`（authored / synthesized）、`covers`、`compiledFrom`
- `boundary` 新增第四值 `cross`，仅 `view` / `overview` 可用
- 新增 lint 项：综述新鲜度、综述覆盖面、合成溯源失效、综述缺溯源
- `docType` 补齐 `superpowers/{specs,plans}` 来源
- 版本收敛规则扩展：覆盖序数命名（`-second` / `-third`）与 sha 快照命名

## [2026-09-26T00:00:00] ingest | 待收录：远程安全综述候选

- 识别到 `docs/analyze/remote-security-analysis.md`（949 行）为横切综述，`covers` 5 个模块
- 尚未建立卡片（`origin: authored`，等待 ingest）
- 备注：该原文第 1–40 行存在重复的「目录」段，ingest 时以去重后的结构为准

## [2026-09-26T00:00:00] schema | 规范自查修正

- 补齐 front matter 豁免条款：`SCHEMA.md`、`wiki/index.md`、`wiki/log.md` 不写 front matter，lint 不得误报
- 新增 lint 项：Front matter 缺失、模块页缺失
- 重排章节编号：§二 拆为 §2.1 页面类型 / §2.2 横切综述（原缺 §2.1 且 2.2 层级错位）
- 自检结果：16 模块 ↔ index 16 指针一致；24 条内链靶子目录齐全；`isWikiInitialized` 三条件满足

## [2026-09-26T00:00:00] schema | 根路径迁移至 docs/wiki（v1.2）

- Wiki 根由顶层 `docs-wiki/` 迁移为 `docs/wiki/`，消除 `docs` 下两套并列目录
- 迁移方式：目录整体移动；结构（16 模块、cross/views、cross/overviews、ledgers、queries）与三文件内容无损
- 修正失效链接：`../docs/develop/architect/...` → `../develop/architect/...`
- 新增「自指排除」硬规则：ingest 扫描 `docs/` 时排除 `docs/wiki/` 整棵子树
- 精确化只读保护表：`docs/wiki/raw/**` 受硬拦截；`docs/` 其余信源仅软约束
- 新增 lint 项：自指收录
- 应用配置需同步改为 `wiki.rootPath = "docs/wiki"`；**勿点「初始化 Wiki」**（会按硬编码创建默认子目录）

## [2026-09-26T00:00:00] schema | 根路径定名 docs/knowledge（v1.3）

- Wiki 根由 `docs/wiki/` 定名为 `docs/knowledge/`，消除 `docs/wiki/wiki/` 双层重名路径
- 目录移动由用户完成；结构（16 模块、cross/views、cross/overviews、ledgers、queries）与三文件内容无损
- 更新根路径声明、结构示例、自指排除范围与只读保护表
- 相对链接 `../develop/...` 仍正确（与信源同属 `docs/` 子目录），无需改动
- 应用配置需同步改为 `wiki.rootPath = "docs/knowledge"`；**勿点「初始化 Wiki」**

## [2026-09-26T00:00:00] schema | 修正两处规范缺陷（v1.4）

- 修正 §2.2.4 溯源示例相对路径深度：`../modules/...` → `../../modules/...`
  （综述页位于 `wiki/cross/overviews/`，指向 `wiki/modules/` 下卡片需上溯两级）
- 澄清 §3.3 路径基准歧义：`sourceDocs` 统一为相对**工作目录根**（与 `codeAnchors` 同基准）；
  `compiledFrom` 为相对 **wiki 根**
- 两项均为自查发现的规范内部不一致，非外部反馈

## [2026-09-26T00:00:00] ingest | 远程安全综述（首个 overview 试点）

- 来源：`docs/analyze/remote-security-analysis.md`（v1.0 · 2026-07-14 · 949 行）
- 形态判定：横切综述（覆盖 7 模块）→ `pageType: overview`、`origin: authored`
- 产出：`wiki/cross/overviews/remote-security-overview.md`
- `covers`：p-drivers, p-delivery, p-workspace, p-storage, s-safety, s-capability, p-host-adapters
- 同时新建 7 个模块枢纽页（均含综述反链）
- 顶层 index：卡片数 0 → 1；**修正预置 covers**（原写含 `p-automation`，实测无后台 Mission 内容；实际覆盖 7 模块）
- **复核发现 4 类代码偏差**（已写入综述页「与当前代码的偏差」节）：
  1. §8.3 的 P0 建议「会话级写授权」**已实现** —— `remoteWriteAuthorization.ts` 已接入 `toolChatLoop.ts`
  2. `runningRemoteAgentRegistry.ts` → 实际为 `electron/remote/remoteAgentRegistry.ts`
  3. `remoteConfirmBridge.ts` / `feishuConfirmManager.ts` / `weChatConfirmManager.ts` 已不在主工作区，
     相关实现由 `electron/feishu/feishuImChannel.ts` 承接（旧文件仅存于 `.worktrees/`）
  4. 原文未提及但已存在：`remoteWriteAuthorization` 与 `remoteWriteGrantLease` 测试
- 结论：原文**分析框架与结论仍有效**，但**实现位置引用需以当前代码为准**
- 待办：4 张底层 `doc` 卡（清单见综述页「待建底层卡片」节）

## [2026-09-26T00:00:00] schema | 修正信源声明的版本控制事实（v1.5）

- 核查 `.gitignore:60-70`：`docs/analyze/`、`docs/review/` 被排除（约 227 篇 / 444 篇）
- 修正原「信源声明」的事实错误（原称「git 管理的 `docs/`」，对上述两目录不成立）
- 新增信源版本控制状态表，标注未跟踪目录的溯源弱化
- §3.3 `sourceDocs` 补溯弱化提示；§3.4 补注 review 版本追溯依赖文件系统而非 git
- 确认 `docs/knowledge/` 未被忽略（`git status` 显示 `??`），走正常版本控制
- **运行时确认**（用户执行 `/wiki status`）：rootPath=`docs/knowledge`、已初始化、
  10 页、raw 0、最近日志为本次 ingest 条目
  → 推论：`docs/knowledge/raw/**` 的硬只读拦截自此**实际生效**（此前 SCHEMA 的该声明不成立）
- 另记录：`llm-wiki/` 为空白骨架（4 文件 / 1758 字节 / `ingestedRawPaths: []` / 零日志），
  rootPath 切换后已停用；其 `.space-skills/llm-wiki/SKILL.md` 仍安装且可用

## [2026-09-26T00:00:00] schema | 需求类文档规则（v1.6）

**触发**：用户提问「需求怎么放进 wiki？SCHEMA 有考虑吗？」
**诊断**：SCHEMA 仅有 `requirement` 这个 docType 名，机制上未覆盖 → 4 个缺口（含 1 处自身缺陷）

- 缺口 ①：`docType` 靠目录对齐的假设失效 —— 实测 `docs/requirement/` 91 篇中
  **10 篇非需求文档**（2 篇 design、1 篇 improvements、3 篇无统一后缀、2 篇中文 `_v6.1`）
- 缺口 ②：`status` 字段语义错位 —— 实测原文出现 **34 种**状态表述，且部分为承载决策台账的
  长句；与 SCHEMA 的 4 个受控枚举不是同一维度
- 缺口 ③：**§2.2.3 硬规则自身有缺陷** —— 「`covers` ≥ 2 → `overview`」隐含假设
  「跨模块 = 综述」，但实测抽样 5 篇需求**全部**命中 4–8 个模块，会被尽数误判
- 缺口 ④：需求 ↔ 设计 ↔ 计划 ↔ 评审的**派生链无表达** —— 8 篇需求有配对评审（最高 14 版），
  51/91 篇含「关联文档」字段（18 篇关联 ≥3 篇）；`supersedes` 是版本取代语义，不适用

**修正**：

- §2.2.3 硬规则加第 2 条准入条件「内容性质须为叙述性综合分析」，并给出判据表
- 新增 §2.3 需求类文档规则：§2.3.1 主责/附属模块、§2.3.2 状态双轨、§2.3.3 派生链
- §2.1 `docType` 明确**由内容判定**，目录仅作辅助，与目录不符时以内容为准
- §3.3 新增字段：`relatedModules` / `sourceStatus` / `relatedCards` / `reviewVersions`
- §3.1 示例改为需求卡，展示全部新字段
- §五 Ingest 步骤 2 改为三步判定（先判内容性质，再判模块数）
- §七 新增 lint 项：附属模块非法、需求误判为综述、派生链断裂、状态未映射

## [2026-09-26T00:00:00] ingest | 首张需求卡（验证 v1.6 规则）

- 来源：`docs/requirement/wiki-import-ingest-requirement.md`（v1.1 · 2026-05-24 · 508 行）
- 形态判定（v1.6 §五 三步）：内容性质 = **规格定义**（非叙述性综合分析）→ 文档类 → `doc` 页
- **关键验证**：该文档命中 4 个模块（`p-ui` 31 / `p-workspace` 19 / `s-safety` 11 / `s-capability` 7），
  按 v1.5 及更早的规则会被**误判为 `overview`**；v1.6 新增第 2 条准入条件后正确归为 `doc` ✅
- 产出：`wiki/modules/product-host/p-ui/requirement-wiki-import-ingest.md`
- 归属：主责 `p-ui`；附属 `p-workspace` `s-capability` `p-storage`（三者模块页加「附属反链」节）
- 状态：`sourceStatus: "待评审"` 忠实转录；`status: active`（卡片仍可引用）
- 新建模块页：`p-ui`（第 8 个）
- **复核发现原文 3 处路径失效**（§11.3 / §17）：
  1. `src/renderer/services/wikiCommandService.ts` → 实际 `src/shared/outbound/wikiCommandService.ts`
  2. `FileTreeContextMenu.tsx` → 已拆为 `fileTreeContextMenuItems.ts` + `FileTreeContextMenuOverlay.tsx`
  3. `FilePane.tsx` → 已不存在，职责由 `DetailPanelFileList.tsx` 与 `WikiPane` 承担
- 另发现：实现已完成但函数名与原文预期不同（实际 `importRawToWiki` / `collectToWiki` /
  `canShowCollectToWiki`，原文预期 `importAndIngest` / `canImportToWiki`）
- `relatedCards: []` 暂空 —— 父需求 `llm-wiki-requirement.md` 尚未建卡，待建后迁入

## [2026-09-26T00:00:00] ingest | 父需求卡 + 两处重大机制变更（复核发现）

- 来源：`docs/requirement/llm-wiki-requirement.md`（v1.6 · 2026-05-24 · **1009 行**）
- 形态判定：内容性质 = 规格定义（非叙述性综合分析）→ `doc`；
  **均衡型跨模块文档**（7 模块命中：s-capability 49 / p-ui 44 / s-safety 29 / p-workspace 26 /
  s-context 8 / p-storage 6 / s-model 5），主责按**用户可见交付面**判为 `p-ui`
  （设置页 + 文件 Tab 分段 + 命令入口 + 归档），与子需求同模块便于聚合
- 产出：`wiki/modules/product-host/p-ui/requirement-llm-wiki.md`（8853 字节 / 178 行）
- 归属：主责 `p-ui`；附属 `s-capability` `s-safety` `p-workspace` `p-storage` `s-context`
- 状态：`sourceStatus: "待评审"`；`status: active`
- `relatedCards` **双向闭合**：父卡 → 子卡，子卡 → 父卡
- 新建模块页：`s-context`（第 9 个）；9 建 / 7 待建

**⚠️ 复核发现两处重大机制变更（本次 ingest 的最大增量）**：

1. **raw 只读拦截已从执行层迁移到策略层**
   - 旧：`builtinExecutors.ts` 的写执行器判 `isUnderWikiRaw` 并抛 `ERR_WIKI_RAW_READONLY`
   - 新：`src/shared/policy/defaultRules.ts:20` 的声明式规则 `wiki-raw-write-deny`
     （第 1 步段，`locked: true` + `action: 'deny'`），由 `toolCallGate.ts:495` 产出
     `wiki-raw-target` 信号触发；信号类型见 `src/shared/confirmation/types.ts:107`
   - 现 `builtinExecutors.ts` 中 `ERR_WIKI_RAW_READONLY` 与 `isUnderWikiRaw` 调用**均已移除**
   - 语义**更强**：`locked` 表示任何套餐不得调松、不可覆盖
   - 与 `docs/develop/session-d961cc51-boundary-policy-layering-technical-plan.md`
     的规划一致（该计划已实施）
2. **`run_script` 内容级安全分析已实现** —— 对应综述页 §7.1.1 标记的「极高威胁缺口」
   - 新增 `electron/shell/scriptContentSecurity.ts`（`analyzeScriptContent`）+
     `electron/confirmation/extractors/scriptAnalysisExtractor.ts`
   - 信号：`script-network` / `script-language-analysis:unverified` /
     `script-path-extraction:unknown` / `script-uncertified` / `clean`
   - 策略分级：桌面 clean 免确认、远程含网络直接拒绝、无人值守未认证语言拒绝

**其他偏差**：

- 路径：`wikiCommandService.ts` 实际在 `src/shared/outbound/`（原文预期 `src/renderer/services/`）
- IPC handlers 实际在 `electron/ipc/agentProtocolIpc.ts`（原文预期 `electron/appIpc.ts`）
- `remoteAllowLocalWrite` 默认值**已改 `true`**（`electron/remote/remoteToolPolicy.ts:61`），
  对应原文 §3.3.3 建议
- `remote_read_only` 已降为 **legacy 值**
  （`electron/tools/coordinatorConfirmationAdapter.ts:15`，统一映射为 `'policy'`）
- Phase 2/3 部分 IPC **未实现**：`wiki:list-pages` / `wiki:parse-index` / `wiki:open-root` 均 0 处

**连带修正**（同一发现波及其他卡片与规范）：

- 子卡 `codeAnchors`：`electron/tools/builtinExecutors.ts:590` → `src/shared/policy/defaultRules.ts:20`
- 子卡正文「执行层拒绝」→「策略层 `wiki-raw-write-deny`」
- 综述页 `codeAnchors`：`electron/tools/builtinExecutors.ts:844` → `:1404`
  （`runScriptExecutor` 定义处；844 行现为写入逻辑 `safeAtomicWrite`）
- SCHEMA v1.7：只读保护表机制描述更正；§3.3 补 `relatedCards` 基准与
  `codeAnchors` 的「机制迁移不可自动检出」提示
