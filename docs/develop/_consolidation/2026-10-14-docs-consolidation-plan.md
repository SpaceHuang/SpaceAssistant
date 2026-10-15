# develop / requirement 文档梳理计划

> 状态：待拍板（§8 剩 5 项）｜编制日期：2026-10-14｜核对基准：`main` HEAD `17236274`（编制时为 `879c7d04` / v0.2.7）｜执行方式：独立 worktree（§5.0）
> 范围：`docs/develop`、`docs/requirement` 及二者各自的 `archive/`；其他 `docs/` 子目录只做边界约定（§2.5），本次不搬迁
> 约束：只动文档，不改代码；不删除文档（只搬迁 + 重写索引）

**一句话**：把这两个目录从「按时间堆积的计划与需求」，改造成「按主题组织的**现状文档** + 已完成迭代的**归档** + 每主题一份**迭代流水账（history.md）**」。

---

## 0. 你的三条要求落到机制上

| 你的要求 | 落地机制 |
| --- | --- |
| 主要整理 develop 与 requirement | 两个目录各建**同名主题二级目录**；其他 `docs/` 子目录冻结不动，只补交叉引用 |
| 二级目录按主题组织，只保留符合最新代码现状的描述 | 每主题 = 一份「现状文档（baseline）」+ `README.md` 索引；现状文档必须写核对基线提交与可复现证据命令 |
| 已完成迭代的需求/开发文档存到归档目录 | `docs/develop/archive/<主题>/`、`docs/requirement/archive/<主题>/`，原件按主题归位、**内容不改** |
| 迭代历史按流水账说明模块变更过程 | 每主题一份 `history.md`：正序时间线，条目 = 日期 + 提交号 + 变更 + 出处文档 + 影响；以 `git log` 为准（§4） |

---

## 1. 现状盘点（本次实测）

### 1.1 规模与分布

| 目录 | 文件数 | 其中 .md | 说明 |
| --- | --- | --- | --- |
| `docs/develop` | 213 | 187 | 4 个二级目录：`architect/`（13 md + 2 html）、`interface/`（10 md）、`agent-sdk/runtime/`（11 md）、`golden-data/`（2 json）；根下混有 `.tsv`/`.json`/`.html` |
| `docs/requirement` | 109 | 109 | 全部平铺，**无二级目录** |
| `docs/review` | 344 | 344 | 本地评审报告；未入库（见 `AGENTS.md`） |
| `docs/plan` | 22 | 19 | 含 `evidence/`，多为 TDD 计划与 todo |
| `docs/knowledge` | 15 | 15 | 含 `wiki/`、`SCHEMA.md` |
| `docs/architecture` / `diagrams` | 8 / 24 | 0 / 0 | 架构图与图产物（html + json） |
| `docs/superpowers` | 15 | 15 | — |
| `docs/废弃` | 20 | 18 | 已含 `后台Mission执行层/`、`工作区管理/` |
| `docs/validation` / `manual` / `i18n` / `skill` | 1 / 2 / 1 / 3 | — | 体量小 |
| `docs/analyze` | 5 | 5 | **全部未入库**（本文件也在其中） |

**入库状态**：`git ls-files docs` 共 451；`develop` 211/213 已跟踪、`requirement` 109/109 已跟踪、`analyze` **0**；当前 `docs/` 下仅 2 个未提交项，都在 `develop/`。

**写现状文档和 history 的靶子（代码与历史）**：

- 仓库 1529 提交，`2026-05-15` → `2026-10-14`；月度提交量 5 月 79 / 6 月 95 / 7 月 283 / 8 月 64 / **9 月 695** / 10 月 313。
- 主进程：`electron/` 下 28 个域目录（`driver/`、`butler/`、`capabilities/`、`confirmation/`、`mcp/`、`storage/`、`sessionStorage/`、`storageProfile/`、`remote/`、`feishu/`、`wechat/`、`browser/`、`shell/`、`tools/`、`skills/`、`wiki/`、`usageStats/`、`outbound/`、`ipc/`、`runtime/` …）。
- SDK：`packages/agent-sdk/src` 19 个文件（`turn.ts` 146 KB、`history.ts`、`context.ts`、`invocation.ts`、`toolExecutionPort.ts`、`scheduler.ts`、`safetyPermit.ts` …）。
- 渲染进程：`src/renderer/{components,hooks,services,store,theme,utils,i18n,assets}`；共享层 `src/shared/`。

### 1.2 被实锤的七类问题（这就是要梳理掉的东西）

1. **元信息格式不统一**：并存 `版本：1.2` / `日期：2026-09-30` / `状态：待评审` / `文档状态 | v1.6` / 什么都没有。
2. **状态词不统一**：草案、待评审、待实现、实施中、已实施、已落地、已实现、Done、已拍板、待复评 —— 至少 10 种；更麻烦的是**状态不可信**（抽查 4 篇里 3 篇的状态字段已过期，实测见 §1.5）。
3. **已废弃/被取代的文档仍散落在主题目录**（`rg` 实命中）：
   - Plan 模式系列 4 篇：`plan-auto-execution-requirement.md`、`plan-detail-panel-requirement.md`、`plan-resume-button-state-requirement.md`、`通用Agent-Plan模式MVP产品需求文档.md`，均指向 `remove-plan-mode-requirement.md`；
   - `plan_mode_optimization_design.md`：文首「已废弃」，文末仍写「状态：草案」——**自相矛盾**；
   - `file-write-directory-layout-requirement.md`：文首「现行替代：工作产物管理（explicit-output-directory-candidate-technical-design.md）」；
   - `remove-background-task-mechanism.md`：状态「已完成」。
4. **0 字节空文件 2 个**：`docs/develop/agent-thinking-token-exhaustion-recovery-design.md`、`docs/requirement/file-viewer-markdown-export-docx-pdf-requirement.md`。
5. **同主题多份计划并存、无单一入口**：
   - Shell/`run_shell` 6 篇（`bash-run-shell-current-state-and-optimization-review`、`run-shell-and-tool-execution-lifecycle-optimization-plan`、`run-shell-command-failure-diagnosis…`、`run-shell-dialect-mismatch…`、`run-shell-windows-host-init-failure…`、`run-shell-agent-safe-boundary-hardening-plan`）；
   - `session-storage-*` 约 **45 篇**（含 `a00–a12` / `c00–c01c` / `i00–i11` / `m3` / `r00–r03` 阶段产物）；
   - 聊天性能 8 篇（`chat-message-list-*` 4 篇 + 两批复测门禁与结果 + `streaming-ui-performance-analysis` + `渲染进程卡顿优化方案` + `会话新建删除卡顿诊断与修改计划`）。
6. **计划文档里埋着大量「实施记录 / 阶段提交 / 评审回写」**——history 的一手素材（例：`script-security-parser-treesitter-upgrade-plan.md` 记了 P0–P3 全部提交号；`desktop-fail-open-to-user-plan.md` 有实现记录章节）。
7. **命名不统一**：日期前缀型（`2026-10-11-remote-im-intent-track-development-plan.md`）、主题型、中文名（`会话新建删除卡顿诊断与修改计划.md`）、`.tsv/.json/.html` 与 md 混放。

### 1.3 已有范例：不另发明规范

两处已经把「主题目录 + 索引 + 代码核对」做对了，本次**沿用其约定**：

- `docs/develop/interface/README.md`：模块地图（文档 ↔ 源码 ↔ 职责）、基准提交行（「本目录对齐 `main` 提交 `8e3c5d12`」）、逐批变更说明、**维护方法**（`git log <基准>..HEAD -- packages/agent-sdk/src` + 导出面自检）。
- `docs/develop/architect/README.md`：类型/状态表（基线 / 规划 / 决策记录 / 参考研究）、阅读顺序、引用约定（**行号是快照、证据须能 `rg -n` 复现**、跨目录引用带路径）。

→ 直接复用三条硬约定：**① 现状文档写「核对基线提交」，不写行号；② 每条结论给可复现命令；③ 跨目录引用一律带路径。**

### 1.4 迭代记录的素材来源与优先级

| 优先级 | 来源 | 用途 | 可靠性 |
| --- | --- | --- | --- |
| 1 | `git log`（按代码/文档路径过滤） | 时间线骨架：日期、提交号、变更主题 | 高（唯一事实源） |
| 2 | 文档内「实施记录 / 阶段提交 / 回写」章节 | 补动机、验收结论、遗留项 | 中（可能滞后于代码） |
| 3 | 需求文档版本演进段落（`版本：1.x` + 修订说明） | 需求口径变化 | 中 |
| 4 | `docs/review/*`、`docs/analyze/*` | 争议与决策依据（只引用，不搬迁） | 中 |

**冲突时以 `git log` 为准**；文档与记录不一致的写进 history 的「存疑」小节，不抹平。

### 1.5 实测：文档自述状态与代码不一致（抽查 4 篇，3 篇已滞后）

按你的提醒，本次先抽 4 篇「看起来还在途」的文档做了**代码核验**（核验手法见 §3.0）：

| 文档 | 文档自述 | 代码 / 提交证据 | 实际状态 |
| --- | --- | --- | --- |
| `docs/develop/mcp-timeout-turn-failure-isolation-plan.md` | 状态：复评 v3 提出 2 项 P1 生命周期合同阻断；**修订版尚未复评** | `a01a6d49 fix(agent): isolate timed out turn execution`（2026-10-14）、`e6f1c510 Merge branch 'codex/mcp-timeout-turn-isolation'` | **已开发并合入**，文档严重滞后 |
| `docs/requirement/mcp-tool-call-card-display-requirement.md` | 状态：已定稿…**待实施** | `src/renderer/components/Chat/McpToolResultView.tsx`、`McpConfirmCard.tsx`、`McpElapsed.tsx`；提交 `59aae8df feat(chat): render MCP results as readable tables`（2026-10-05） | **已实现** |
| `docs/requirement/wiki-shared-centralized-storage-requirement.md`（v1.12） | 版本 1.12，文中无「已实施」标注 | `electron/wiki/wikiProjectStore.ts`、`wikiMount.ts`、`wikiMigration.ts`、`wikiWriteMutex.ts`；配套 `docs/plan/wiki-shared-centralized-storage-dev-test-plan.md` | **实现已在代码内**，需求文档未回写 |
| `docs/requirement/2026-10-11-im-security-review-improvement-requirement.md` | 状态：方案草案…**尚未实现统一 IM 策略域** | `imPolicy` / `imSecurityPolicy` 等符号在 `electron/` 下**无匹配**；但相关能力已落地（`1d4c9bcd` intent tracking、`8f1a21fc` 远程确认渠道归属、`71efa790` durable async IM approvals、`36edb110` Track isolation） | **真在途**：依赖已就绪，主方案未实施 |

**结论（已写进规则）**：文档里那行「状态：」**不能作为判定依据**，A/B/C/D 一律以代码核验为准（§3.0）；「已完成」的判定主要靠提交与代码，而不是文档自述。

---

## 2. 目标结构

### 2.1 组织原则

1. **主题即二级目录**：主题边界对齐代码域 / 产品模块，不对齐时间。
2. **一主题一入口**：每主题只有一份 `README.md`（索引 + 状态表）与一份 `history.md`（流水账）。
3. **现状与历史分离**：现状文档只描述「今天代码是什么样」，变更过程一律进 `history.md`，避免现状文档再次腐化。
4. **归档可追溯**：原件 `git mv` 进 `archive/<主题>/`，文件名不改、内容不改，靠归档索引 + history 反查。
5. **一切结论可复现**：现状文档与 history 条目都要能由命令重放。

### 2.2 主题清单（建议 9 个，两目录同名对齐）

**定调：粗粒度、少而稳**。二级目录宁少勿多——每个主题都要能长期承载，不随迭代反复搬家。

| # | 主题目录 | 定位（吸收了什么） | 主要代码域 | develop 侧约 | requirement 侧约 |
| --- | --- | --- | --- | --- | --- |
| 1 | `agent-sdk/` | **Agent SDK：内核、契约与模型接入**（**主题名对齐现役术语**，命名沿革见 §2.6）：回合主循环、工具循环、调用契约与生命周期、准入/调度、上下文注入、继续与恢复；SDK 接口说明与 runtime 目标设计；模型流契约与 provider 路由；LLM 服务/模型配置、思考强度、用量统计、密钥（吸收原 agent-core 系列文档 + interface + model-config） | `packages/agent-sdk/src/*`、`electron/toolChatLoop.ts`、`turnRuntime.ts`、`driver/`、`butler/`、`llmServiceResolver.ts`、`usageStats/` | ~38 | ~16 |
| 2 | `architect/` | **架构与规划**（**保留原名**：长期稳定层，且被多篇文档引用）：产品架构理想态、演进 Roadmap、决策记录、外部实现对照研究 | 跨模块（全仓） | ~13 | 0 |
| 3 | `storage-session/` | **会话与数据**：存储重构、持久化与维护、读热路径、消息事实链路、事件流、会话标题与列表（吸收原 session-storage + session-message） | `sessionStorage/`、`storage/`、`storageProfile/`、`database/`、`sessionEvents.ts`、`messageCodec.ts` | ~52 | ~8 |
| 4 | `tools-mcp/` | **工具能力与外部接入**：shell、文件工具、grep/rg、browser、subagent、工具可靠性、MCP（集成/延迟加载/SSE/超时隔离）（吸收原 tools + mcp） | `electron/shell/`、`tools/`、`browser/`、`mcp/`、`fileIpc.ts` | ~25 | ~18 |
| 5 | `safety-approval/` | **安全、确认与审批**：策略与档位、确认/审批链路、脚本与路径安全、fail-open | `capabilities/`、`confirmation/`、`writeSafety/`、`pathSecurity.ts` | ~10 | ~7 |
| 6 | `im-remote/` | **远程与 IM**：飞书、微信、远程会话与意图 Track、远程安全、产物决策 | `feishu/`、`wechat/`、`remote/`、`outbound/` | ~13 | ~14 |
| 7 | `desktop-ui/` | **桌面交互与工作区**：聊天界面与渲染性能、composer、上下文占用、多会话、文件面板/查看器、工作目录、设置与托盘（吸收原 chat-ui + workspace-files） | `src/renderer/components/`、`services/`、`store/`、`workDir*.ts`、`sessionDirectoryGrants.ts` | ~26 | ~31 |
| 8 | `knowledge-skills/` | **技能与知识**：Skills 安装与管理、LLM Wiki、项目记忆 | `skills/`、`wiki/` | 0 | ~12 |
| 9 | `platform-eng/` | **工程支撑**：i18n、发版、依赖升级、测试基建、代码治理 | 全仓 | ~7 | ~2 |
| — | `archive/` | 已完成迭代原件（按主题分子目录） | — | — | — |

> 说明：上表「约」为本次按文件名与首部元信息做的**初步归类**，Phase 1 需逐篇确认（§9 附录 A 给了代表文档）。
> 合并理由：几处「细主题」实质是同一代码簇的不同侧面——SDK 契约与内核实现共用同一代码簇（`packages/agent-sdk/src/turn.ts`、`history.ts`）；消息事实与存储重构在同一批提交里交替推进；MCP 与工具执行器共用调度与超时语义；渲染性能与工作区面板同属渲染层。架构文档（`architect/`）因属长期稳定层且被广泛引用，单独保留为主题。
> 主题**内部**不设三级目录：现状文档平铺（`<模块>-现状.md`），只有现状文档超过 8 份时，才允许按模块分 1 层子目录。这样后面新增模块只是加文件，不动目录结构。

**现存 4 个子目录的归位**（一次性搬完，之后不再动目录结构）：

| 现路径 | 归位 | 处理方式 |
| --- | --- | --- |
| `docs/develop/architect/` | **原地不动** | 它本身就是一个主题目录；只更新 README 里的基准行（现为「整理日期 2026-09-12」） |
| `docs/develop/interface/`（10 篇） | `docs/develop/agent-sdk/` | 并入平铺，文件名保持；引用它的文档一并改指（其 README 本就自称「agent-sdk 接口说明」） |
| `docs/develop/agent-sdk/runtime/`（11 篇） | **原地不动** | 现名已是 `agent-sdk/runtime/`，主题改名后**零搬迁**（它是完整的设计系列：01–10 + README） |
| `docs/develop/golden-data/`（2 json） | `docs/develop/tools-mcp/golden-data/` | 漂移证据数据，随宿主文档归位；若宿主文档已归档，则一并进 `archive/` |

> 注意：合并子目录会产生一批引用改动（多篇计划文档写死了 `docs/develop/interface/xxx.md`、`docs/develop/agent-sdk/runtime/xxx.md`），必须在同一批里改完，并按 §7-1 做死链检查。

### 2.3 单个主题目录的标准形态

```text
docs/develop/<主题>/
├── README.md          # 索引：本主题现状文档清单 + 状态表 + 归档指引（学 architect/README）
├── <模块>-现状.md      # 现状文档：只写与最新代码一致的事实，带核对基线
├── history.md          # 迭代流水账（§4）
└── in-flight/          # 草稿箱：未实施/未收口的在途项（§3.1；收录前须过 §3.0 核验）
docs/develop/archive/<主题>/    # 已完成迭代原件（文件名不改、内容不改）
docs/develop/archive/INDEX.md   # 归档总索引（旧路径 → 新路径，供全仓链接回查）
```

`docs/requirement/<主题>/` 形态相同，但现状文档换成 `需求基线.md`（当前生效的需求口径），已完成需求进 `archive/`。

### 2.4 归档约定

| 项 | 约定 |
| --- | --- |
| 位置 | 只进 `docs/develop/archive/`、`docs/requirement/archive/`，下按主题分子目录 |
| 搬运方式 | `git mv`（保留历史），**文件名不改、内容不改**；仅允许在归档 `INDEX.md` 里补「原路径 / 状态 / 取代者」 |
| 归档判定 | 已完成迭代且结论已并入代码；已被新文档取代；新增一行归档头（见 §3 边界情形表） |
| 为什么内容不改 | 归档件是历史证据，改了就失去可追溯性；「现状」一律写在主题目录，不回头改归档件 |
| 索引 | 主题 `history.md` 每条的「出处」列直接链到归档件；`archive/INDEX.md` 提供一次性全量映射 |
| 特殊件 | 0 字节空文件不搬运，直接在原地删除（列入 §8-5 确认项）；`.tsv/.json` 证据类随宿主文档进归档 |

### 2.5 与其他 `docs/` 子目录的边界

| 目录 | 关系 | 本次动作 |
| --- | --- | --- |
| `docs/review/`（344） | 评审报告证据源 | 不动、不搬迁；主题文档以相对路径引用（`../review/xxx.md`） |
| `docs/plan/`（22） | TDD 计划/todo/证据 | 不动；若某主题的 plan 已收口，在 history 里记「对应过程产物见 `docs/plan/xxx`」 |
| `docs/knowledge/`、`docs/architecture/`、`docs/diagrams/` | 知识与图产物 | 不动；现状文档如需图，引用其路径 |
| `docs/废弃/` | 已废弃功能归档 | 本次新增的「功能已废弃」件**统一进 `archive/<主题>/`**，并在 `docs/废弃/README.md`（若建）留指引，避免两处分散 |
| `docs/analyze/` | 本地分析记录（`.gitignore` 已忽略） | **只做本地分析**；本轮的计划、清单、规则、核验记录改落 `docs/develop/_consolidation/`（入库、worktree 可见），见 §5.0 |
| `docs/manual/`、`validation/`、`i18n/`、`skill/`、`superpowers/` | 各自独立 | 不动 |

### 2.6 术语对齐：agent-sdk（现役）取代 agent-core（旧称）

核验依据（2026-10-14）：`docs/develop/architect/agent-core-roadmap.md` 文首自述——「命名沿革：本文档原题『Agent Core 演进规划』…**Agent Core 为 Agent SDK（`packages/agent-sdk`）的早期设计方案名称**，正文中『Agent Core』『Core』均指现 Agent SDK」。代码侧同样对齐现役术语：`electron/` 下 `agentCore|agent-core` **零匹配**，实现落在 `packages/agent-sdk`（包名 `@spaceassistant/agent-sdk`）。

| 旧称（历史文档里） | 现役术语 | 处理 |
| --- | --- | --- |
| Agent Core / Core / agent-core | **Agent SDK** / `packages/agent-sdk` / `agent-sdk` | 主题名、README、现状文档、history 一律用现役术语；历史**文件名不改**（`agent-core-roadmap.md`、`agent-core-contract-path-refactor-plan.md` 保留原名），在 `archive/INDEX.md` 与主题 README 的「术语沿革」里注明旧称 |
| `docs/develop/interface/`（目录名） | **agent-sdk 接口说明** | 并入 `agent-sdk/`；其 README 本就自称「agent-sdk 接口说明」，顺势更新基准行 |
| Agent Host / Hosted Runtime | 现役同义（`interface/host-ports.md` 用词为准） | 保持，不新造词 |

落地规则：① 新增与改写的文档只用现役术语；② 归档件正文不改，旧称只在索引与 README 里对照；③ 不做全仓批量替换旧称，避免制造无意义 diff。

---

## 3. 判定规则

### 3.0 状态核验（前置动作，不能跳过）

每篇文档在做去留判定前先跑三步，把结果记进 `docs/develop/_consolidation/docs-inventory.tsv` 的「代码证据」列：

1. **提交检索**：`git log -i --date=short --format='%ad %h %s' --grep='<关键词>' -30`（关键词用功能名/英文术语，如 `mcp`、`isolation`、`intent`）；
2. **路径检索**：`git log --date=short --format='%ad %h %s' -25 -- <该主题代码路径>`（如 `electron/mcp`、`electron/toolChatLoop.ts`）；
3. **符号检索**：`rg -n '<文档承诺的类型/函数/文件>' <代码路径>`（文档说「新增 X 端口」，就找 X 是否真的存在）。

| 文档自述 | 代码证据 | 判为 |
| --- | --- | --- |
| 已实施 / 已落地 | 有对应提交 + 符号 | **A 或 B**（结论进现状或归档） |
| 待实施 / 修订中 | **却有**对应提交 + 符号 | **已完成（自述滞后）**：按 A/B 处理，并在 history 记「状态滞后，以代码为准」 |
| 待实施 | 无提交、无符号，但依赖项已就绪 | **C 草稿箱**，头部标注「在途；依赖已就绪」 |
| 待实施 | 无提交、无符号，前置也不具备 | **C 草稿箱**，头部标注「在途；前置未就绪」 |
| 已废弃 | 符号已从代码移除 | **D**；若符号仍在，先与需求方确认再定 |

> 实测见 §1.5：抽查 4 篇中 3 篇状态字段已过期。核验是**必须动作**，不是可选项。

### 3.1 四类去向

对每篇文档只允许一个去向，必须逐篇落定（用 `docs/develop/_consolidation/docs-inventory.tsv` 记录）：

| 去向 | 含义 | 处理 |
| --- | --- | --- |
| **A 现状（baseline）** | 描述的目标形态/契约今天仍成立 | 留在主题目录；按 §3.2 校核后可能合并多篇为一份；写核对基线 |
| **B 归档（archive）** | 迭代已完成、结论已进代码；或被取代 | `git mv` 进 `archive/<主题>/`（**已定：一律搬迁**） |
| **C 草稿箱（in-flight）** | 未实施、或实施中未收口，但仍有价值的方案/需求 | 留主题目录 `in-flight/`，头部统一标注 `状态：草稿（未实施）` 或 `状态：实施中（进度见 history.md）` |
| **D 废弃（deprecated）** | 功能方向已否（如 Plan 模式） | `git mv` 进 `archive/<主题>/`，头部补一行「已废弃，见 xxx」 |

> C 已按你的口径定为**草稿箱**：只收经 §3.0 核验确认「无实现痕迹」或「实施中未收口」的条目。自述状态滞后的（写着"待实施"但代码里已实现）**不进草稿箱**，直接按 A/B 处理。草稿箱内文件名不改，只在头部补一行状态，便于后继判断「还剩什么没做」。

### 3.2 A 类保留判据（必须三条全过）

1. **代码可对照**：结论能用 `rg`/`git log` 对到今天的代码或提交，且未失效；
2. **无替代者**：同一话题不存在更新的同类文档（若存在，二选一保留，另一篇进归档并注明被谁取代）；
3. **有读者**：装配方/SDK 维护者/后续迭代确实需要（判据：被引用次数 ≥1，或属接口、规范、运行手册、指南类）。

### 3.3 B 类归档判据（命中其一即归档）

1. 实施计划且已收口（文档自述「已实施/已落地/Done」，或代码能证明已实现）；
2. 验收证据 / 复测门禁 / 阶段 todo / 逐提交审计 → 一律归档（属过程产物）；
3. 被显式取代（文首有「现行替代」「已废弃，见 xxx」）；
4. 需求文档对应的功能已上线且无未决项。

### 3.4 矛盾消解规则

同一主题出现多份互相矛盾的描述时：

1. **以代码为准**：先读代码确认现状，再决定哪份文档的结论还成立；
2. **以时间晚者为准**：两份都无代码冲突时，取更晚修订的；被淘汰者进归档，头部注明「已被 `<新文档>` 取代」；
3. **不许留双入口**：主题目录里同一话题只能有一份现状文档；其余全部归档；
4. **冲突写进 history**：消解过程（谁与谁矛盾、依据什么判定）写进 `history.md` 的对应条目，而不是删掉不留痕。

### 3.5 边界情形处置表（举例）

| 情形 | 实例 | 处置 |
| --- | --- | --- |
| 功能已废弃 | `plan_mode_optimization_design.md`、Plan 模式 4 篇需求 | D：进 `archive/desktop-ui/`，头部补「已废弃，见 remove-plan-mode-requirement.md」 |
| 已被取代 | `file-write-directory-layout-requirement.md` | D：归档，标注现行替代为工作产物管理 |
| 已完成但文档含长期价值 | `security-policy-single-entry-requirement.md`（口径仍在生效） | A：改写为现状文档「安全策略单一入口」；原需求进归档 |
| 完成度自述与代码不符 | `plan_mode_optimization_design.md`（首尾状态矛盾） | 以代码为准，归档并在 history 记「文档状态自相矛盾，按代码判定为废弃」 |
| 阶段产物 | `session-storage-a01…a12`、`i00…i11`、`c00…c01c` | B：整批进 `archive/storage-session/`，仅 history 保留结论 |
| 本地过程产物 | `docs/review/*`、`docs/analyze/*` | 不动（§2.5） |
| 空文件 | 2 个 0 字节文件 | 删除（§8-5 确认） |

---

## 4. 迭代历史记录（history.md）规范

### 4.1 定位

`history.md` 回答一个问题：**这个模块是怎么变成今天这样的**。它是流水账，不是计划、不是现状说明、不是路线图。

- 只写**已发生**的事（代码提交、文档定稿、口径变更、方案被否）；
- 不写「将来要做」「建议做」——那属于 `in-flight/` 或计划文档；
- 一条记录就能对应一个可复查的提交。

### 4.2 条目格式

| 列 | 要求 |
| --- | --- |
| 日期 | `YYYY-MM-DD`（取提交日期） |
| 提交 | 短 hash（可加分支名；合并类提交只记被合并的主提交） |
| 变更 | 一句话，动词开头，说清「改了什么行为」而非「改了哪个文件」 |
| 出处 | 链到需求/计划/评审文档（归档件给相对路径） |
| 影响与结果 | 契约/行为变化、遗留项、是否被后续推翻 |

### 4.3 示例（`docs/develop/agent-sdk/history.md` 节选）

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
| 2026-09-30 | `1f6e7940` | 消息事实落库归还 Core：桌面/远程统一走同一生产链路 | `message-fact-production-pipeline-refactor-plan.md`（已归档） | 渲染进程不再自持 `ToolCallRecord`；生产 owner 清理待复审 |
| 2026-10-13 | `c5c2ccb7` | turn 级取消传导补全：中止信号接进工具执行（Phase 1） | `chat-turn-cancel-tool-conduction-fix-plan.md`（已归档） | 取消不再停在模型层；G1/G6 红基线 4 条为本机实测真值 |
| 2026-10-14 | `a01a6d49` | 超时 turn 的执行隔离：超时不再连累同批其它工具调用 | `mcp-timeout-turn-failure-isolation-plan.md`（在途） | 计划尚未收口，实现先落地 |

### 4.4 粒度与取舍

- **默认一条 = 一次迭代**（一个计划文档对应的完整落地，可能含多个提交）——按 Phase 逐条列会在长主题上爆量；
- **允许单列**：契约/行为发生转向、被后续推翻、跨主题影响、事故修复；
- **聚合**：同一天同主题的琐碎提交（格式化、测试微调）合并为一条，注明「含 N 个提交」；
- 只读类、纯文档提交不进 history（除「口径变更」类）；
- 目标长度：一个主题 30–80 条；粗粒度主题（如 `agent-sdk`）必然更长，此时**按模块拆 history 分册**（`history-<模块>.md`，由 README 索引各分册），而不是把主题拆细——目录结构不动，只加文件。

### 4.5 取证命令（写进每个 history 文末，供后续核对）

````text
git log --oneline --date=short --format='%ad %h %s' -- <代码路径>          # 某模块全部提交
git log --oneline --date=short --format='%ad %h %s' -- docs/develop/<旧路径>  # 文档侧时间线
git log --diff-filter=R --summary --find-renames -- docs/                 # 核对搬迁痕迹
````

### 4.6 模板

````markdown
# <主题> 迭代历史

> 本文是流水账：按时间**正序**记录本主题**已发生**的变更，只写有证据支撑的事实。
> 证据源：`git log`（命令见文末）+ 计划/需求文档的实施记录章节；冲突时以 `git log` 为准。
> 维护：每次涉及本主题的迭代收尾时追加条目。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 存疑（文档与记录不一致）

- <日期> <文档> 记 X，`git log` 显示 Y，暂按 Y 记录，待复核。

## 取证命令

```text
git log ...
```
````

### 4.7 禁止事项

1. 不把现状描述塞进 history（现状归现状文档）；2. 不写无提交号/无日期的条目；3. 不写「预计」「即将」；4. 不修改归档件的正文来「对齐」history；5. 不用行号当证据。

---

## 5. 执行流程（Phase 0–5）

### 5.0 执行载体：独立 worktree（本轮整理就是一次迭代）

**为什么**：要动 300+ 篇文档、跨 9 个主题、分 8 批提交，还要改写现状文档——它就是一次迭代，不该在 `main` 工作区直接改。

**仓库现行约定**（实测）：worktree 放 `.worktrees/<话题>`（已在 `.gitignore` 第 13 行），分支名用 `codex/<话题>` 或 `feat/<话题>`；在用示例 `.worktrees/mcp-timeout-turn-isolation`（`codex/mcp-timeout-turn-isolation`）、`.worktrees/im-security-review-improvement`（`codex/im-security-review-improvement`）。

**开工命令**：

```bash
git worktree add .worktrees/docs-consolidation -b codex/docs-consolidation main
cd .worktrees/docs-consolidation
git log -1 --format='%h %ad %s' --date=short     # 记下开工基线，写进第一份核验记录
```

**六条约定**：

1. **基线锚定开工时的 `main`**（当前 `17236274`）：计划与核验记录都记这个值，中途 main 前进不追。
2. **每批一次提交**，提交信息带主题名（如 `docs(agent-sdk): 现状核验 + interface 归位`）；**搬迁与改写分开提交**，便于回退。
3. **merge 回 main 的时机**：每批自测（死链 + 索引可达）通过后即可 merge，或攒到终审后一次 merge——二选一，别中途反复 pick。
4. **整理产物必须落在入库路径**：`.gitignore` 第 58 行忽略了 `docs/analyze/`，**worktree 里根本看不到该目录**。所以本轮清单、规则、核验记录、模板统一落 `docs/develop/_consolidation/`（随分支入库、worktree 可见）；本计划文件也要复制一份到该目录并提交，否则 worktree 里的执行者看不到计划。
5. **收尾清理**：终审合并后 `git worktree remove .worktrees/docs-consolidation`；顺带盘点 `.worktrees/` 下的陈旧残留（现有 0 字节的 `SpaceAssistant-does-not-exist` 与一处嵌套 worktree），**不动他人正在使用的**。
6. **worktree 内不跑代码测试**：本轮只改 `.md`/`.tsv`，验证手段是死链检查与索引可达性，不是 `npm test`。

以下阶段表在各批次的 worktree 内执行。

| 阶段 | 内容 | 产出 | DoD |
| --- | --- | --- | --- |
| **Phase 0 冻结与立规**（0.5 天） | **先开 worktree（§5.0）**；冻结开工基线（当前 `main` `17236274`）；建主题骨架目录；定模板（现状文档/README/history/归档 INDEX）；**逐篇状态核验（§3.0）** 后生成全量清单 | `docs/develop/_consolidation/docs-inventory.tsv`（每篇：路径、大小、文档自述状态、**代码证据（提交 / 符号）**、实际状态、主题、去向 A/B/C/D、取代者、理由）、`docs/develop/_consolidation/docs-consolidation-rules.md` | 213+109 篇全部有去向；自述与代码不符的已按代码更正；无「待定」残留（除 §8 剩余项） |
| **Phase 1 试点**（1 天） | 选 1 个主题端到端跑通：**建议 `tools-mcp`（`run_shell` 6 篇矛盾最集中）** 或 `agent-sdk`（已有 `interface/` 范例、核对方法现成） | 该主题的 README + 现状文档 + history + 归档 + INDEX | 你复核并确认模板与粒度；据此修订模板 |
| **Phase 2 分类搬迁**（按批） | 按 §6 批次 `git mv` 归档件；修全仓引用；补归档头 | 每批一次提交 | `git status` 干净；无死链（§7-1 检查通过） |
| **Phase 3 现状重写**（按批） | **按 §5.2 逐主题核验（我执行）** 后重写/合并现状文档；删掉已失效描述；写核对基线与证据命令 | 每主题 1–3 份现状文档 + `baseline-check-<日期>.md` | 断言 100% 带命令；漂移与失效项已处置；你抽查 3 条复算通过 |
| **Phase 4 history 编写**（按批） | 按 §4 生成时间线；与 `git log` 抽样核对（每主题抽 10 条） | 每主题 `history.md` | 抽查条目能在 git 中定位；存疑项已记录 |
| **Phase 5 总账与复核**（0.5 天） | 建 `docs/develop/README.md`、`docs/requirement/README.md` 总索引；全仓链接复查；与用户做一次终审 | 两个总索引 + 终审记录 | 任一文档可从总索引两级点到；无指向已搬迁旧路径的链接 |

**整体验收标准**：① 四个目录里任一篇文档都能回答「它为什么存在、依据哪个基线、被什么取代」；② 同主题不存在两份互相矛盾的现状描述；③ 每个主题的 `history.md` 时间线与 `git log` 抽样一致；④ 归档件可反查（旧路径 → 新路径有索引）。

### 5.1 每批次的收尾动作（照 `AGENTS.md` 纪律）

一次提交 = 一个批次（搬迁与改写分开提交，便于回退）；提交信息带主题名；批次结束更新一次总索引，不中途反复改。

### 5.2 主题 baseline 核验流程（**由我执行，一个主题一个主题过**）

**分工**：Agent（我）负责核验、记录、改写与回写 history；你只做**抽查**与**争议拍板**。节奏：每主题一轮，跟着 §6 批次走；试点主题先跑通格式，再铺开其余主题。

**一轮 7 步**（每步都留下命令与结果，不凭印象判定）：

| 步 | 动作 | 命令 / 产物 |
| --- | --- | --- |
| 1 | 读该主题现状文档头部声明的**核对基线**（如 `17236274`） | — |
| 2 | 取变更窗口：基线之后该主题的代码是否动过 | `git log --oneline <基线>..HEAD -- <主题代码路径>`；为空即记「一致（窗口内无变更）」 |
| 3 | 把现状文档的结论拆成**可核验断言** A1…An（每条一个能判真假的句子） | 断言表落到 `baseline-check-<日期>.md` |
| 4 | 逐条核验 | `rg -n '<符号>' <文件>`、`git log -S'<符号>' -- <路径>`、必要时读关键函数 |
| 5 | 判定四类 | 一致 / **漂移**（文档旧于代码）/ **失效**（结论已不成立）/ **无法核验**（需真机、外部系统、真实 IM） |
| 6 | 处置：漂移 → 改写该条；失效 → 删除该条；两者都记 history；无法核验 → 标注 `待真机核验` | 现状文档 + `history.md` |
| 7 | 出**核验记录**并挂到主题 README 索引 | `docs/develop/<主题>/baseline-check-<日期>.md` |

**核验记录模板**

````markdown
# <主题> baseline 核验记录（<日期>）

> 基线：`17236274` ｜ 执行：Agent ｜ 窗口：`git log 17236274..HEAD -- <代码路径>` 共 N 条提交

| 断言 | 文档出处 | 命令 | 实测 | 判定 | 处置 |
| --- | --- | --- | --- | --- | --- |
| A1 <结论> | `turn-loop.md` §3 | `rg -n 'planContextReplacement' packages/agent-sdk/src` | 命中 3 处 | 一致 | — |
| A2 <结论> | … | … | 0 命中 | 漂移 | 已改写（`history.md` 2026-xx-xx） |

## 无法核验项（需你拍板或真机）

- A9 <结论>：需真实 IM 链路，标 `待真机核验`。
````

**一轮 DoD**：断言 100% 带命令与实测；漂移/失效项 100% 已处置或转入 `in-flight/`；无法核验项逐条写明原因与复核条件；核验记录已进主题 README 索引。

**你的参与**：每主题由你抽 3 条断言复算（我提供命令，谁执行都行）；只有「无法核验」与「需产品决策」的项必须你拍板，其余默认通过。

**重跑时机**：该主题每次迭代收尾（或每次发版）后重跑一轮；核验记录按日期累积、不覆盖（旧记录用于看漂移趋势）。

---

## 6. 分批推进建议（9 个主题 → 8 批）

| 批次 | 主题 | 为什么这个顺序 | 预估 |
| --- | --- | --- | --- |
| 0 | 冻结 + 立规 | 没有清单就没法开工 | 0.5 天 |
| 1（试点） | `agent-sdk`（含 `interface/` 归位；`runtime/` 原地不动） | 已有 README/基准行范例，风险最低；同时把 `interface/` 一次性并完，固化模板与搬迁手法 | 1.5 天 |
| 2 | `storage-session`（最大，52 篇） | 体量最大、最活跃，**单独成批**；按 a/c/i/r 分 3 个子批次，每子批 ≤15 篇 | 2 天 |
| 3 | `tools-mcp` + `safety-approval` | 两者互有引用（shell 安全边界、脚本安全策略、MCP 超时语义） | 1.5 天 |
| 4 | `im-remote` | 飞书/微信/远程三簇互相引用，单独成批最稳 | 1 天 |
| 5 | `desktop-ui`（约 57 篇，本主题最大） | 需引用 `agent-sdk` 与 `storage-session` 的结论，故排在其后 | 1.5 天 |
| 6 | `knowledge-skills` + `platform-eng` + `architect` | 小主题收口；`architect` 只更新基准行与索引，不搬迁 | 0.5 天 |
| 7 | 专项：历史一次性项目整组归档 | `2026-10-01` 云 main 恢复 7 篇、`session-ced59b41` 3 篇、`session-d961cc51` 3 篇 | 0.5 天 |
| 8 | 总索引 + 终审 | 建两个总索引、全仓死链复查、与你终审 | 0.5 天 |

合计约 10.5 天（按每天 1 个主题批次的有效产出估），可按你的节奏拉长；**每批结束停下来给你复核**比一次性做完再验收省返工。

---

## 7. 风险与对策

| # | 风险 | 后果 | 对策 |
| --- | --- | --- | --- |
| 1 | 搬迁破坏跨文档链接 | 大量死链 | 每次搬迁后跑一次链接排查（`rg` 搜旧路径），逐条改指；`archive/INDEX.md` 留旧→新映射；Phase 5 做全仓复查 |
| 2 | 现状文档写错（与代码不符） | 比没有文档更坏 | 强制「核对基线 + 可复现命令」；**逐主题核验（§5.2）+ 你每主题抽 3 条复算**；不许写无法复现的断言 |
| 3 | 大主题超出单次上下文（`storage-session` 52 篇、`desktop-ui` 约 57 篇） | 漏读、误判 | 主题内再分组，每子批 ≤15 篇；按 `AGENTS.md` 纪律做阶段性交接 |
| 4 | history 变成主观叙事 | 不可信 | 每条带提交号；与 `git log` 抽样核对；不确定的写「存疑」 |
| 5 | 「归档」被误当「删除」 | 追溯能力丢失 | 内容零改动 + `git mv` + 索引；归档目录入库 |
| 6 | 顺手改代码 | 混入无关变更 | 本任务硬边界：只改 `.md`（及 INDEX/TSV），代码文件不得出现在提交里 |
| 7 | 与本地过程产物边界模糊 | 复现 `docs/review` 巨量 | 明确：review/plan/analyze 只引用不搬迁 |
| 8 | 主题划分不合适导致二次搬迁 | 返工 | 先试点 1 批复核主题划分，再批量推进 |

---

## 8. 待拍板项（3 条已定，剩 5 条）

**已定**（2026-10-14，按你的回复）：

① **在途项 → `in-flight/` 草稿箱**收载，且收录前必须过 §3.0 代码核验。据此，我原先举的例子里 `mcp-timeout-turn-failure-isolation-plan.md`、`mcp-tool-call-card-display-requirement.md`、`wiki-shared-centralized-storage-requirement.md` 三篇经核验**已经实现**，不进草稿箱（按 A/B 处理；状态字段回写）；只有 `2026-10-11-im-security-review-improvement-*` 这类核验后确实无实现痕迹的才进草稿箱。

② **归档 → 一律 `git mv` 搬迁**，配 `archive/INDEX.md` 旧→新映射，并改完全部引用、做死链检查。

③ **「与最新代码一致」由我负责核验**：一个主题一个主题过 baseline ↔ 代码，流程与记录模板见 §5.2；你只做抽查（每主题 3 条断言）与「无法核验 / 需产品决策」项的拍板。

3. **主题清单是否采纳**（§2.2 已按你的口径粗化为 **9 个**，主题名也已对齐现役术语：`agent-sdk`（原 agent-core 系列 + `interface/` + model-config）、`storage-session`（存储 + 消息）、`tools-mcp`（工具 + MCP）、`desktop-ui`（聊天 UI + 工作区））。若仍想更粗，可再合 `knowledge-skills` 进 `platform-eng`（8 个）；反之若嫌 `agent-sdk` 主题过杂（它同时承载 SDK 契约、runtime 设计、架构与模型接入），可把「LLM 服务 / 思考强度 / 用量统计 / 密钥」拆成 `model-config`（10 个）。我的建议：**先按 9 个定稿**，`model-config` 作为 Phase 1 试点后再定的备选。
4. **历史一次性项目**：`2026-10-01` 云 main 恢复 7 篇（含 3 个 `.tsv`）、`session-ced59b41` / `session-d961cc51` 专题 6 篇，是否整组归档（推荐是），只在相关主题 history 留 1–2 条要点？
5. **整理产物是否入库**：**已必须入库**——`.gitignore` 第 58 行忽略 `docs/analyze/`，worktree 里看不到它。故本轮清单/规则/核验记录落 `docs/develop/_consolidation/`（§5.0）。待定的是收尾时该目录的去留：保留为「整理档案」，还是把核验记录散进各主题后删除？我的建议：**保留**（下轮梳理可复用同一清单）。
6. **history 粒度**：按迭代一条（推荐）还是按提交一条？长主题差 3–5 倍篇幅。
7. **范围边界**：是否顺带更新 `docs/develop/interface/README.md` 的基准行（它现对齐 `8e3c5d12`，已落后于 `17236274`）？以及 `docs/架构`、`docs/knowledge` 是否要补进交叉引用？

---

## 9. 附录 A：主题 → 代表文档（初步归类，供你判断划分是否合理）

| 主题 | develop 侧代表文档 | requirement 侧代表文档 |
| --- | --- | --- |
| `agent-sdk` | `2026-09-29-driver-runtime-lifecycle-improvement-plan.md`、`2026-09-30-execution-lifecycle-reliability-convergence-plan.md`、`agent-loop-single-path-refactor-plan.md`、`context-injection-refactor-plan.md`、`runtime-admission-sdk-reuse-plan.md`、`tool-dispatch-slot-abort-and-transcript-hole-improvement-plan.md`、`failed-turn-continuation-experience-plan.md`、`butler-agent-shortest-path-plan.md`、`agent-core-contract-path-refactor-plan.md`（旧称，文件名保留）、`agent-sdk-architecture-development-plan.md`（724 KB）、`agent-sdk-architecture-migration-baseline.md`、`agent-sdk/runtime/*`（11）、`interface/*`（10） | `tool-invocation-reliability-requirement.md`、`tool-use-id-pairing-requirement.md`、`agent-runtime-admission-policy-requirement.md`、`agent-toolkit-capability-gateway-requirement.md`、`agent-token-usage-analytics-requirement.md`、`llm-service-profiles-requirement.md`、`llm-multi-service-model-config-requirement.md`、`thinking-effort-settings-requirement.md`、`macos-api-key-access-authorization-requirement.md` |
| `architect` | `product-architecture-design.md`、`agent-core-roadmap.md`、`agent-sdk-shape-decision.md`、`rewrite-vs-refactor-cost-assessment.md`、`three-products-architecture-benchmark-summary.md`、三篇外部对照研究 | — |
| `storage-session` | `session-storage-refactor-technical-design.md`（512 KB）、`session-storage-public-interface-design.md`、`session-storage-refactor-migration-plan.md`、`session-storage-a00…a12`/`c00…c01c`/`i00…i11`/`r00…r03` 阶段件、`spill-reference-index-and-backfill-plan.md`、`message-fact-production-pipeline-refactor-plan.md`、`message-fact-persistence-core-refactor-plan.md`、`session-record-eventflow-refactor-plan.md` | `message-fact-production-pipeline-refactor-requirement.md`、`session-auto-title-requirement.md`、`session-manual-title-requirement.md`、`session-list-pending-confirm-badge-requirement.md`、`session-d961cc51-workdir-boundary-and-sandbox-policy-layering-requirement.md` |
| `tools-mcp` | `bash-run-shell-current-state-and-optimization-review.md`、`run-shell-and-tool-execution-lifecycle-optimization-plan.md`、`run-shell-dialect-mismatch-false-positive-and-fatal-turn-abort-improvement-plan.md`、`run-shell-windows-host-init-failure-diagnosis-and-improvement-plan.md`、`ripgrep-integration-technical-design.md`、`grep-recursive-search-capability-release-plan.md`、`web-browser-tools-design.md`、`cli-subagent-integration-design.md`、`tool-invocation-reliability-improvement-technical-design.md`、`edit-file-match-failure-diagnosis-and-improvement-plan.md`、`mcp-integration-development-plan.md`、`mcp-deferred-tool-loading-delivery.md`、`mcp-sse-transport-plan.md`、`mcp-timeout-turn-failure-isolation-plan.md` | `shell-command-tool-requirement.md`、`shell-output-encoding-robustness-requirement.md`、`read-file-tail-and-oversized-tool-result-requirement.md`、`web-browser-tools-requirement.md`、`browser-act-session-trust-requirement.md`、`cli-subagent-integration-requirement.md`、`mcp-integration-requirement.md`、`mcp-deferred-tool-loading-requirement.md`、`mcp-tool-call-card-display-requirement.md` |
| `safety-approval` | `tool-confirmation-framework-implementation-plan.md`、`desktop-auto-approval-plan.md`、`desktop-fail-open-to-user-plan.md`、`desktop-ask-rule-tier-unification-plan.md`、`security-approval-experience-improvement-plan.md`、`script-security-parser-treesitter-upgrade-plan.md` | `confirmation-card-trust-requirement.md`、`tool-confirmation-top-level-design-v2.md`、`security-policy-single-entry-requirement.md`、`shell-security-enhancement-requirement.md`、`security-approval-concurrency-limits-and-observability-requirement.md` |
| `im-remote` | `im-architecture-refactor.md`、`2026-10-11-remote-im-intent-track-development-plan.md`、`remote-im-async-interaction-design.md`、`artifact-decision-remote-im-technical-design.md`、`feishu-integration-phase1–3`、`wechat-integration-phase1`、`remote-private-chat-security-optimization-*` | `feishu-integration-requirement.md`、`wechat-integration-requirement.md`、`remote-im-async-approval-security-requirement.md`、`remote-session-context-awareness-requirement.md`、`artifact-decision-remote-im-requirement.md`、`2026-10-11-im-security-review-improvement-requirement.md` |
| `desktop-ui` | `chat-message-list-renderer-performance-optimization-design.md`、`chat-message-list-streaming-jitter-fix-plan.md`、`chat-turn-cancel-tool-conduction-fix-plan.md`、`composer-model-thinking-entry-development-plan.md`、`会话新建删除卡顿诊断与修改计划.md`、`渲染进程卡顿优化方案.md`、`multi-workdir-technical-design.md`、`explicit-output-directory-candidate-technical-design.md`、`scheduled-task-workdir-model-development-plan.md` | `chat-message-ui-requirement.md`、`composer-model-thinking-entry-requirement.md`、`context-usage-ring-v2-improvements.md`、`file-content-viewer-requirement.md`、`queued-task-bar-requirement.md`、`settings-requirement.md`、`multi-workdir-requirement.md`、`explicit-output-directory-candidate-requirement.md` |
| `knowledge-skills` | —（develop 侧无） | `skills-requirement.md`、`skill-management-ui-requirement.md`、`skill-github-nested-directory-discovery-requirement.md`、`llm-wiki-requirement.md`、`wiki-shared-centralized-storage-requirement.md`、`project-memory-requirement.md` |
| `platform-eng` | `release-guide.md`、`dependency-upgrade-plan-2026-08.md`、`i18n-sync-guide.md`、`automated-test-suite-cleanup-audit.md`、`main-dead-code-cleanup-audit-and-plan-2026-10-14.md`、`tech_design.md` | `i18n-architecture-requirement.md`、`remove-background-task-mechanism.md` |

## 10. 附录 B：本次盘点用到的命令（可重放）

````text
git log --oneline | wc -l                                   # 1529
git log -1 --date=iso --format='%h | %ad | %s'              # HEAD 17236274 2026-10-14（编制时 879c7d04）
git log --date=format:'%Y-%m' --format='%ad' | sort | uniq -c
git ls-files docs | wc -l                                   # 451
git ls-files docs/develop | wc -l                           # 211
git ls-files docs/requirement | wc -l                       # 109
git ls-files docs/analyze | wc -l                           # 0（被 .gitignore 忽略，第 58 行）
git status --short docs | wc -l                             # 2（均在 develop/）
git worktree list                                           # 现有 worktree（§5.0 命名与位置约定）
````

---

**下一步**：你回一句「按 §8 的选择执行」+ 对剩余 5 项的取舍，我就从 **Phase 0（生成 `docs-inventory.tsv` 全量清单 + 模板）** 开工；也可以只先做 **Phase 1 试点**（`tools-mcp` 或 `agent-sdk`），跑通「搬迁 → 现状核验（§5.2）→ history」一条链，看一份成品再定规范。

