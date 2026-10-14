# docs 梳理执行规则（Phase 0 产物）

> 开工基线：`main` HEAD `17236274`（2026-10-14，与计划 §5.0 记录的基准一致）
> 执行载体：worktree `.worktrees/docs-consolidation`，分支 `codex/docs-consolidation`
> 计划原文：本目录 [`2026-10-14-docs-consolidation-plan.md`](./2026-10-14-docs-consolidation-plan.md)
> 硬边界：只动 `.md` / `.tsv` / `.json`（文档与索引）；代码文件不得出现在本分支提交里。

## 1. §8 待拍板项采用的默认口径

用户指令为「推进计划，直到全部完成」，未逐条回复 §8。按计划各条自带的建议执行，并在本文件留痕，便于事后调整：

| §8 项 | 采用口径 | 依据 |
| --- | --- | --- |
| 3 主题清单 | **按 9 个主题定稿**（`model-config` 作为备选，本轮不拆） | 计划建议「先按 9 个定稿」 |
| 4 历史一次性项目 | **整组归档**，只在相关主题 history 留 1–2 条要点 | 计划「推荐是」 |
| 5 整理产物去留 | **保留** `docs/develop/_consolidation/`（下轮梳理复用同一清单） | 计划建议「保留」 |
| 6 history 粒度 | **一条 = 一次迭代**（同一计划的多提交合并；转向/事故/跨主题影响允许单列） | 计划「推荐」 |
| 7 范围边界 | 更新 `docs/develop/interface/README.md` 基准行（随 `interface/` 归位一并做）；`docs/知识`、`docs/knowledge` 只补交叉引用，不搬迁 | 计划 §2.5、§2.2 |

空文件（2 个 0 字节）按计划 §8-5 的既有结论**直接删除**（见 `docs-inventory.tsv` 中 `DELETE` 行，共 2 条）。

## 2. 目标结构（9 主题，两目录同名对齐）

`agent-sdk`、`architect`、`storage-session`、`tools-mcp`、`safety-approval`、`im-remote`、`desktop-ui`、`knowledge-skills`、`platform-eng`。

每个 `docs/<develop|requirement>/<主题>/` 的标准形态：

```text
README.md          # 索引：现状文档清单 + 状态表 + 归档指引 + 核验记录入口
<模块>-现状.md      # develop 侧：只写与最新代码一致的事实，带核对基线与可复现命令
需求基线.md         # requirement 侧：当前生效的需求口径（替代现状文档）
history.md         # 迭代流水账（§4 规范）
in-flight/         # 草稿箱：未实施/未收口的在途项
baseline-check-<日期>.md   # §5.2 主题核验记录
```

归档：`docs/<develop|requirement>/archive/<主题>/`，另有 `docs/develop/archive/INDEX.md` 与 `docs/requirement/archive/INDEX.md` 提供旧路径 → 新路径映射。

## 3. 判定规则（实际执行口径）

### 3.1 四类去向

| 去向 | 含义 | 处置 |
| --- | --- | --- |
| **A** | 描述的目标/契约今天仍成立（含接口、规范、指南、顶层设计） | 留主题目录（必要时合并）；写核对基线 |
| **B** | 迭代已完成、结论已进代码；或被取代；或属过程产物（评审/证据/阶段件/复测门禁/台账） | `git mv` 进 `archive/<主题>/`，**内容零改动** |
| **C** | 未实施 / 未收口，但仍有价值 | 留 `in-flight/`，头部补一行 `状态：草稿（未实施）` 或 `状态：实施中（进度见 history.md）` |
| **D** | 方向已否（如 Plan 模式系列） | `git mv` 进 `archive/<主题>/`，头部补一行 `已废弃，见 <取代者>` |

### 3.2 过程产物一律归档（B）

命中即归档，不再逐篇讨论：`*evidence*`、`*audit*`、`*review*`、`*gate*`、`*remeasure*`、`*acceptance*`、`*verification*`、`*test-plan*`、`*implementation-matrix*`、`*status*`、`*estimate*`、`*manifest*`、`*ledger*`、`*profile*`、`*snapshot*`、release-note，以及 `session-storage-a*/c*/i*/r*/m3-*` 阶段件。

### 3.3 状态核验（§3.0）执行方式

- **全量（320 篇）**：按文件名关键词与 `git log`（`--date=short --format='%ad|%h|%s'`，本次导出 1530 条）做最近相关提交匹配，结果落在 `docs-inventory.tsv` 的「代码证据」列——该列是**线索**，不是结论。
- **重点篇目**：按 §3.0 三步（提交检索 / 路径检索 / 符号检索）逐条核验，结果写进对应主题的 `baseline-check-<日期>.md`。
- 计划 §1.5 已核验的 4 篇按代码更正自述状态（`mcp-timeout-turn-failure-isolation-plan.md`、`mcp-tool-call-card-display-requirement.md`、`wiki-shared-centralized-storage-requirement.md`、`2026-10-11-im-security-review-improvement-requirement.md`）。

### 3.4 已知的判定噪声

规则化判定对「头部无状态行」「状态写在正文中段」的文档不敏感，可能判成偏向 A/B 的保守值。处置：逐主题复核时以 `baseline-check-<日期>.md` 的断言表为准；发现误判即改 `docs-inventory.tsv` 并记入该主题 `history.md` 的「存疑」小节。

## 4. 模板

### 4.1 现状文档（develop 侧）

````markdown
# <模块> 现状

> 核对基线：`main` `17236274`（2026-10-14）｜窗口内变更：`git log 17236274..HEAD -- <代码路径>`（N 条 / 无）
> 证据约定：结论用 `rg -n` / `git log -S` 可复现；不写行号（行号是快照）

## 1. <结论标题>

<一句话结论>

复现：`rg -n '<符号>' <路径>`
````

### 4.2 主题 README（索引）

````markdown
# <主题>

> 定位：<一句话>｜主要代码域：`electron/xxx/`、`packages/xxx/`
> 核对基线：`main` `17236274`

| 文档 | 类型 | 状态 | 说明 |
| --- | --- | --- | --- |
| [<模块>-现状.md](./<模块>-现状.md) | 现状 | 生效 | … |
| [history.md](./history.md) | 流水账 | — | … |
| [baseline-check-<日期>.md](./baseline-check-<日期>.md) | 核验记录 | — | … |
| [in-flight/](./in-flight/) | 草稿箱 | N 篇 | … |

归档：本主题已完成迭代原件见 [`../archive/<主题>/`](../archive/<主题>/)（映射见 [`../archive/INDEX.md`](../archive/INDEX.md)）。
````

### 4.3 history.md

````markdown
# <主题> 迭代历史

> 流水账：按时间**正序**记录本主题**已发生**的变更，只写有证据支撑的事实。
> 证据源：`git log`（命令见文末）；与文档冲突时以 `git log` 为准。
> 维护：每次涉及本主题的迭代收尾时追加条目。

## 时间线

| 日期 | 提交 | 变更 | 出处 | 影响与结果 |
| --- | --- | --- | --- | --- |

## 存疑（文档与记录不一致）

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- <代码路径>
```
````

### 4.4 archive/INDEX.md

````markdown
# <develop|requirement> 归档总索引

> 归档件内容零改动（`git mv` 保留历史）；本文件提供旧路径 → 新路径映射与状态标注。

| 原路径 | 现路径 | 状态 | 取代者/说明 |
| --- | --- | --- | --- |
````

### 4.5 baseline-check-<日期>.md

````markdown
# <主题> baseline 核验记录（<日期>）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- <代码路径>` 共 N 条

| 断言 | 文档出处 | 命令 | 实测 | 判定 | 处置 |
| --- | --- | --- | --- | --- | --- |

## 无法核验项（需真机或产品拍板）
````

## 5. 验收边界（AGENTS.md 要求先行对齐）

| 类别 | 项 | 手段 |
| --- | --- | --- |
| 本地可验证 | 死链检查（旧路径引用清零）、索引两级可达、`git status` 干净、inventory 覆盖 320/320 | `rg` + 人工走索引 |
| 需真人拍板 | §8 剩余 5 项取舍；2 个空文件删除；「真在途」判定有异议时 | 用户抽查 |
| 无需真机 | 本任务纯文档，无外部系统依赖 | — |
