---
pageType: doc
docType: requirement
module: p-ui
relatedModules: [p-workspace, s-capability, p-storage]
boundary: product-host
status: active
sourceStatus: "待评审"
sourceDocs:
  - docs/requirement/wiki-import-ingest-requirement.md
codeAnchors:
  - src/renderer/services/wikiImportService.ts:16
  - src/renderer/services/wikiImportService.ts:30
  - src/renderer/services/wikiImportService.ts:7
  - electron/wiki/wikiImport.ts:43
  - electron/wiki/wikiImport.ts:90
  - src/shared/outbound/wikiCommandService.ts:1
  - src/renderer/components/FileTree/fileTreeContextMenuItems.ts:1
  - src/shared/policy/defaultRules.ts:20
relatedCards:
  - modules/product-host/p-ui/requirement-llm-wiki.md
reviewVersions: []
supersedes: []
supersededBy: []
updated: 2026-09-26
---

# Wiki 外部文件导入并 Ingest — 需求要点

> **原文**：[docs/requirement/wiki-import-ingest-requirement.md](../../../../../requirement/wiki-import-ingest-requirement.md)
> v1.1 · 2026-05-24 · 508 行 · 状态「待评审」
> **主责模块**：`p-ui`（交付面为「收录到 Wiki」的各 UI 入口）
> **附属模块**：`p-workspace`（会话与沙箱前置）、`s-capability`（raw 只读拦截、文本类型判定）、`p-storage`（`.wiki-meta.json` 记录）

## 要解决的问题

**路径断裂**：Ingest 只处理 `{wikiRoot}/raw/` 下的文件，但用户自然路径是
「在文件列表选中项目内任意资料 → 希望一步收录」。原实现要求手动复制到 `raw/`，与心智模型不符。

## 交付内容

统一入口「**收录到 Wiki**」：选中 workDir 内符合条件的文件 → 应用**自动**完成
`拷贝至 raw/` → 触发既有 Ingest。用户无需理解 `raw/` 与 `wiki/` 的分层。

### 五个入口

| 编号 | 位置 | 优先级 |
|------|------|--------|
| E1 | 文件列表分段树 — 文件右键 | P0 |
| E2 | 详情面板工具栏 | P1 |
| E3 | Wiki 分段 `raw/` 文件右键 | 已有（Phase 2.5 统一文案） |
| E4 | 聊天命令 `/wiki ingest\|摄取\|提取 <path>` | P0 |
| E5 | 引用的文件列表 | P2 |

## 关键设计约定

**① 职责边界：拷贝由应用层完成，不由 LLM**

| 步骤 | 执行者 |
|------|--------|
| 拷贝至 raw | **主进程 / 应用 IPC**（非 LLM 工具） |
| read raw、写 wiki、更新 index/log | **LLM + 既有 Skill** |

「LLM 不得写 `raw/`」的拦截**维持不变**，但机制已从执行层迁至**策略层**
（`src/shared/policy/defaultRules.ts` 的 `wiki-raw-write-deny`，`locked: true` + `deny`；
`toolCallGate` 产出 `wiki-raw-target` 信号）。详见父需求卡的偏差节。

**② 拷贝而非移动** —— 源文件保留；不支持「导入后删除源文件」（OQ-I4 已决议）。

**③ 命名与冲突**：目标 `{wikiRoot}/raw/{basename(src)}`，首版**扁平化**（不保留源目录结构），
冲突默认 `auto-rename`（`{stem}-{YYYYMMDD-HHmmss}{ext}`）；不做 `overwrite`（违背 raw 审计语义）。

**④ 已决议的开放问题**

| # | 问题 | 决议 |
|---|------|------|
| OQ-I1 | 各入口文案是否统一？ | **是**，统一「收录到 Wiki」 |
| OQ-I2 | 冲突默认策略？ | 首版 `auto-rename` |
| OQ-I3 | Shift+收录 = 移动？ | **不做** |
| OQ-I4 | 导入后删除源文件？ | **否**（仅拷贝） |
| OQ-I5 | 记 `importedSources`？ | 可选，P2 |

## 非目标（首版）

监听文件夹自动 Ingest；二进制 / PDF / Office 解析（延续 OQ-7 仅文本）；
剪贴板粘贴创建 raw；workDir 外文件导入。

## 新增 IPC

| 通道 | 功能 |
|------|------|
| `file:copy` | 工作目录内安全拷贝，创建父目录 |
| `wiki:import-raw` | 封装命名/冲突规则 + 文本校验；`copied:false` 表示已在 raw |

## ⚠️ 与当前代码的偏差（2026-09-26 ingest 复核）

**① 实现已完成，且命名与原文不同**

原文预期的 `importAndIngest` / `canImportToWiki` 未采用，实际实现为
`src/renderer/services/wikiImportService.ts` 的 `importRawToWiki`（:16）、
`collectToWiki`（:30）、`canShowCollectToWiki`（:7）。

**② 原文 §11.3 / §17 的文件路径三处已失效**

| 原文写法 | 当前实际 |
|----------|----------|
| `src/renderer/services/wikiCommandService.ts` | `src/shared/outbound/wikiCommandService.ts` |
| `src/renderer/components/FileTree/FileTreeContextMenu.tsx` | 已拆为 `fileTreeContextMenuItems.ts` + `FileTreeContextMenuOverlay.tsx` |
| `src/renderer/components/FilePane/FilePane.tsx` | 该文件已不存在；职责由 `DetailPanelFileList.tsx` 与 `WikiPane` 承担 |

**③ 主责模块判定说明**：原文 §17 列出的 9 个改动文件中 6 个属前端
（UI 入口为主交付面），故主责判为 `p-ui` 而非 `s-capability` ——
尽管「raw 只读」是其安全约束之一。

## 派生链

- **父需求**：[LLM Wiki 支持](requirement-llm-wiki.md)（本需求是该需求的 Phase 2.5 补全）
  已记入 `relatedCards`
- **评审**：无配对评审（实测 `docs/review/` 中无同名系列）
