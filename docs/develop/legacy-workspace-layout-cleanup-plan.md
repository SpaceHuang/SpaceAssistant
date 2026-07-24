# 旧「目录规范」残存清理计划

> 状态：**Done**（2026-07-24，分支 `refactor/legacy-workspace-layout-cleanup`）  
> 日期：2026-07-24  
> 背景：工作产物管理（artifact）已取代扩展名→子目录重定向；运行时门控已恒为关闭，但实现、IPC、UI、配置与测试仍大量残留。  
> 相关：  
> - 现行替代：`docs/develop/explicit-output-directory-candidate-technical-design.md`  
> - 旧需求（废弃）：`docs/requirement/file-write-directory-layout-requirement.md`  
> - 灰度日志（需同步修订）：`docs/plan/explicit-output-directory-changelog.md`  
> - 计划评审：`docs/review/legacy-workspace-layout-cleanup-plan-review.md`  
> - 计划复审 v2：`docs/review/legacy-workspace-layout-cleanup-plan-review-v2.md`  
> - 计划复审 v3：`docs/review/legacy-workspace-layout-cleanup-plan-review-v3.md`  
> - 计划复审 v4：`docs/review/legacy-workspace-layout-cleanup-plan-review-v4.md`

---

## 1. 目标与非目标

### 1.1 目标

1. **删除不可达的 legacy 运行时**：扩展名重定向、`WriteDirConfirm`、系统提示注入、设置映射表组件及相关 IPC。
2. **清理配置与会话脏数据**：去掉 `config.workspaceLayout` 与 `sessions.metadata.writeDirChoice`（**删除字段，不做语义迁移**）；清理过程**不得**改变会话业务时间戳或最近会话排序。
3. **消除命名混淆**：设置「工作产物」Tab 不再挂在 `workspaceLayout` 这个历史 key 上（可选但建议同轮完成）。
4. **文档对齐现状**：changelog / 设计交叉引用不再写「flag=false 仍可用 legacy」。

### 1.2 非目标

- 不改变工作产物管理（`artifactManagementEnabled`）的产品行为与决策链路。
- **不**把历史 `writeDirChoice` 自动迁移为 `artifactDefaultDir`（既有设计明确禁止）。
- 不重写 `pathSecurity` / 安全写入协议。
- 不顺手大范围重构 `toolChatLoop` 无关分支。
- 不清理用户工作区磁盘上已误写入的离谱路径文件（如 `Users/space/.../Docs/`）；可在发布说明中提示人工核对。
- **不**给通用 `updateSession` 增加「保留 `updatedAt`」隐式例外或可选参数；数据剥离用专用 migration helper。
- **不**在本轮退役或缩减 one-shot 迁移 helper（见 §1.4「迁移保留窗口」）。

### 1.3 成功标准（摘要）

- 仓库内无 `electron/workspaceLayout/` 模块；无 `file-write-dir:*` IPC；无 `WriteDirConfirmPanel` / `pendingWriteDirConfirmStore`。
- `AppConfig` 不再包含 `workspaceLayout`；**从旧版直升本轮最终构建**后，DB 不再保留有效的 `config.workspaceLayout`（由启动 one-shot 完成，而非依赖开发机曾跑过中间 WP）。
- 全部会话 metadata 不再含 `writeDirChoice`（经一次性事务清理 + 保存/导入路径防御性剥除）；若存在无法解析的 metadata，清理不得宣称完成（无完成标记，下次启动重试）。
- 最终发布态仍包含完整迁移入口（helper + `main.ts` 接线 + 无标记时全量清理 + fail-closed 重试）；见 §1.4。
- 一次性清理前后：受影响会话的 `sessions.updated_at` **字节级不变**，`listSessions` 顺序不变，其他 metadata 键不变，且**不会**创建 `artifactDefaultDir`。
- `npm test`、`typecheck:*`、`i18n:check` 通过；grep 关键词仅出现在归档文档、本清理计划，以及**明确保留的**迁移/剥除 helper 中。

### 1.4 不变量（实施全程必须遵守）

| 不变量 | 说明 |
| --- | --- |
| DELETE ONLY | 只删 `writeDirChoice` / `config.workspaceLayout`，禁止映射到 `artifactDefaultDir` |
| 时间戳冻结 | 会话清理**禁止**调用会刷新 `updatedAt` 的 `updateSession`；SQL 只改 `metadata` |
| 原子提交 | 配置删除、会话 metadata 剥离、一次性完成标记在**同一 SQLite transaction** 内提交 |
| Fail-closed | 任一 session `metadata` 无法解析为对象 → **整单事务抛错回滚**；不得跳过该行、不得写完成标记、不得提交任何部分清理 |
| 完成标记语义 | `legacy_workspace_layout_cleaned_at` **仅**表示「已扫描并成功解析全部会话、完成必要剥离、且验证无剩余顶层 `writeDirChoice`」；损坏行未修复前不得写入 |
| 幂等 | 标记已存在 → 直接返回；标记不存在时每次启动重试直至全量成功 |
| 迁移保留窗口 | 本轮最终发布**必须**保留完整 one-shot helper、`main.ts` 启动接线、无标记时全量清理与 fail-closed 重试。**禁止**本轮删除 helper，或缩成「仅检查标记后 return」。helper 退役只能由**未来独立计划**决定，且须以「最低可直升版本」或「强制中间升级链」为前提，证明不再有未迁移的旧库可直接打开 |
| 恢复数据入口 | 会话备份/导入若可能带回 `writeDirChoice`，须由**仍保留的**启动迁移或保存/导入边界剥除处理；不得依赖本轮已删除的代码路径 |
| Artifact 行为不变 | `resolveArtifactDefaultDir` 与工作产物决策链路保持原样 |

---

## 2. 现状结论（为何可以删）

| 门控 | 位置 | 当前行为 |
| --- | --- | --- |
| `shouldUseLegacyWorkspaceRedirect` | `electron/artifacts/featureFlag.ts` | **恒 `false`** |
| `shouldApplyLegacyWorkspaceLayout` | `electron/artifacts/legacyMigration.ts` | **恒 `false`** |
| `shouldShowLegacyWriteDirUi` | `src/renderer/components/Chat/legacyWriteDirUi.ts` | **恒 `false`** |

因此：

- `toolChatLoop` 内目录规范确认 / `applyWorkspaceLayoutRedirect` **运行时不可达**。
- 聊天区 WriteDir 确认卡 / chip **永不展示**。
- 设置页 `ToolsSettingsTab` 的 `workspaceLayout` case 已渲染 `ArtifactSettingsTab`，`WorkspaceLayoutTab` **生产零引用**。
- DB 中仍可能存在 `config.workspaceLayout.enabled=true` 与损坏的 `writeDirChoice`（例如双重嵌套绝对路径），但只污染备份/误导排障，不再驱动行为。
- `updateSession`（`electron/database/operations.ts`）在任意 patch 下都会写 `updatedAt: Date.now()`，且 `listSessions` 按 `updated_at DESC` 排序——因此**不能**用它做批量 metadata 剥离。

**决策**：采用「硬删除 + 一次性事务化数据剥离」，不保留兼容层或 feature flag 回滚开关。若需回滚，依赖 git revert。

---

## 3. 核心设计决定

| 议题 | 决定 |
| --- | --- |
| 数据迁移 | **DELETE ONLY**：删除 `writeDirChoice` 与 `config.workspaceLayout`；禁止映射到 `artifactDefaultDir` |
| 迁移实现 | 专用 helper（见 §5 WP2）；**禁止**经 `updateSession`；单事务；保留 `updated_at`；**fail-closed**（见 §1.4） |
| 触发时机 | 应用启动、打开 DB 之后、与 `cleanupStreamingResiduesOnStartup` 同级调用；**不要**挂在 `config:get`（避免 UI 路径半状态） |
| 完成标记 | `schema_meta` 键（如 `legacy_workspace_layout_cleaned_at`）；**仅在全量扫描+剥离+校验成功后**与数据更新同事务写入；不升 `DB_SCHEMA_VERSION`（无 DDL 变更） |
| 损坏 metadata | **禁止跳过**；解析失败 → 回滚并下次启动重试。若产品将来要容忍坏行，须另设计可重试逐行状态，不得复用本永久门闩 |
| 迁移保留窗口 | 本轮最终构建保留完整启动迁移（见 §1.4）；**不**把「开发机已跑过 WP2」当成「用户库已清理」。退役另立项 |
| `resolveArtifactDefaultDir` | **保留**（artifact 正式 API，与 legacy UI 无关） |
| `sanitizeArtifactSessionMetadataOnSave` | WP2 起扩展为「任意会话保存时剥除 `writeDirChoice`」。本轮**继续保留**该剥除（或等价的导入/恢复边界剥除），作为备份恢复后的防御；**不得**在无替代入口时删除。与 one-shot helper 一并纳入未来退役计划 |
| 设置 nav key | 建议同轮将 `workspaceLayout` **重命名为 `artifacts`**（i18n / `toolsSettingsNav` / `configSlice`），避免残留语义 |
| 旧需求文档 | 文首标注 **Deprecated / Superseded by artifact management**，不删文件以便追溯 |
| 误写磁盘路径 | 不自动搬家/删除用户文件；发布说明提示可检查并手工清理 |

---

## 4. 残存清单与处置

### 4.1 整包删除：`electron/workspaceLayout/`

| 文件 | 处置 |
| --- | --- |
| `redirect.ts` / `redirect.test.ts` | 删除 |
| `writeDirCandidates.ts` / `.test.ts` | 删除 |
| `writeDirConfirmRegistry.ts` / `.test.ts` | 删除 |
| `confirmFlow.ts` | 删除 |
| `sessionWriteDir.ts` / `.test.ts` | 删除；同步去掉 `main.ts` workDir 切换时的 `clearAllSessionsWriteDirChoices` |

### 4.2 工具循环与系统提示

| 位置 | 处置 |
| --- | --- |
| `electron/toolChatLoop.ts`：`useLegacyWorkspaceLayout` / hint / 确认流 / redirect / `tool:redirect` | 整段删除及相关 import、payload 字段 `workspaceLayout` |
| `electron/llmSystemPrompt.ts`：`buildWorkspaceLayoutHint` | 删除；保留 `artifactContextHint` |
| `electron/claudeStreamHandlers.ts` / `main.ts`：`getWorkspaceLayout` | 删除接线 |
| `electron/chatCancelRegistry.ts`：`cancelAllWriteDirConfirmsForRequest` | 删除调用 |
| `electron/toolChatLoop.workspaceLayout.test.ts` | 删除 |
| `electron/llmSystemPrompt.test.ts` 中 layout hint 夹具 | 删除或改写 |

### 4.3 IPC / 共享 API

| 通道或类型 | 处置 |
| --- | --- |
| `file-write-dir:confirm-request` / `confirm-response` / `reset` | 删除（preload、`appIpc`、`src/shared/api.ts`、`src/test/setup.ts`） |
| `WriteDirConfirmRequest` / `Response` / `Choice` / `WriteDirCandidatePayload` | 删除 |
| `CONFIG_KEYS.workspaceLayout`、`readWorkspaceLayoutConfig`、`config:get|set` 的 `workspaceLayout` 字段 | 删除 |
| `src/shared/configSetTypeGate.ts` 对 `workspaceLayout` 的断言 | 删除 |

### 4.4 渲染层

| 资产 | 处置 |
| --- | --- |
| `WriteDirConfirmPanel.tsx` (+ test) | 删除 |
| `pendingWriteDirConfirmStore.ts`、`usePendingWriteDirConfirmSnapshot.ts` | 删除；`confirmStoresInit` / `chatRunnerService` / `ChatView` 去引用 |
| `legacyWriteDirUi.ts` (+ test) | 删除 |
| `WorkspaceLayoutTab.tsx` (+ test) | 删除 |
| `ChatView` 中 panel / chip / `showLegacyWriteDirUi` | 删除 |
| `layout.css` 中 `.chat-write-dir-confirm*` / `.write-dir-confirm-card*` | 删除 |
| `toolsSettingsNav` key `workspaceLayout` | **重命名为 `artifacts`**（见 §3） |

### 4.5 类型与配置表面

| 符号 | 处置 |
| --- | --- |
| `ExtensionSubdirMapEntry`、`WorkspaceLayoutConfig`、`DEFAULT_WORKSPACE_LAYOUT_CONFIG`、`mergeWorkspaceLayoutConfig` | 从 `domainTypes.ts` 删除 |
| `AppConfig.workspaceLayout` | 删除；所有 fixture / snapshot 测试同步改 |
| `src/shared/domainTypes.workspaceLayout.test.ts` | 删除 |

### 4.6 门控与 legacyMigration 收缩

| 符号 | 处置 |
| --- | --- |
| `shouldUseLegacyWorkspaceRedirect` | 删除；所有断言测试删除或改写 |
| `shouldApplyLegacyWorkspaceLayout` | 删除 |
| `shouldShowLegacyWriteDirUi` | 删除（随组件删除） |
| `sanitizeArtifactSessionMetadataOnSave` | WP2 起扩展为全会话剥除 `writeDirChoice`；**本轮保留**（见 §3）；不得在 WP5 删除除非已落地并测过等价导入/恢复边界 |
| `resolveArtifactDefaultDir` | **保留** |
| one-shot `legacyWorkspaceLayoutCleanup`（名称可调整） | **本轮最终发布必须保留完整实现 + 启动接线**；见 §1.4 迁移保留窗口 |

### 4.7 i18n

| Key 前缀 | 处置 |
| --- | --- |
| `chat.writeDirConfirm.*`、`chat.writeDirChip.*` | 删除 |
| `config.workspaceLayout.*`（映射表文案） | 删除 |
| `config.tools.nav.workspaceLayout.*` | 随 nav 重命名改为 `config.tools.nav.artifacts.*`（文案可继续用「工作产物」） |
| `chat.writeSuccess.*` / `chat.artifactDecision.*` / `config.artifactSettings.*` | **保留** |

删除后执行 `npm run i18n:generate-types` 与 `npm run i18n:check`。

### 4.8 文档

| 文档 | 处置 |
| --- | --- |
| `docs/requirement/file-write-directory-layout-requirement.md` | 文首 Deprecated |
| `docs/superpowers/plans/2026-06-30-file-write-directory-layout.md` | 文首 Archived |
| `docs/plan/explicit-output-directory-changelog.md` | 修订「legacy 仍可用 / 不在 MVP 删除」为「已退役并由本计划删除」 |
| `docs/requirement/file-tree-auto-refresh-requirement.md` | 将 redirect 引用改为 `pathSecurity` |
| `docs/develop/artifact-decision-remote-im-technical-design.md` 等 | 去掉「legacy confirm 不受影响」过时句 |
| `docs/develop/cli-subagent-integration-design.md` / `b344321-...` | `AppConfig` 字段列表去掉 `workspaceLayout` |

---

## 5. 工作包拆分

建议按可独立提交、可独立验证的顺序实施。每个 WP 合并前跑聚焦测试 + 全量 `npm test`（至少在 WP3/WP5 边界）。

### WP1 — 切断运行时入口（小、可回滚）

**做啥**

1. 删除 `toolChatLoop` 中 legacy 确认 / redirect / hint 分支与 `workspaceLayout` 参数传递。
2. 删除 `buildWorkspaceLayoutHint` 及调用。
3. `chatCancelRegistry` 去掉 writeDir cancel。
4. 三个恒 false 门控改为直接删除（调用方已无）。

**验收**

- 带 `workspaceLayout.enabled=true` 的本地 DB 启动后，新建 `write_file` **不会**改路径、不弹 WriteDir 卡、系统提示无「目录规范」段。
- `npx vitest run electron/toolChatLoop*.test.ts electron/artifacts/*.test.ts` 通过。

### WP2 — 数据清理（DELETE ONLY，事务化、冻结时间戳、fail-closed）

**做啥**

1. 新增专用 migration helper（建议 `electron/database/legacyWorkspaceLayoutCleanup.ts`，或 `electron/artifacts/` 下同等定位的 one-shot；对外经 `runInTransaction`）：
   - **入口**：`main.ts` 打开 DB 后调用一次（紧邻 `cleanupStreamingResiduesOnStartup`），不要挂在 `config:get`。调用方 catch 失败时只记日志、**不**写标记、不阻断应用其余启动；下次启动继续重试。
   - **幂等门闩**：若 `schema_meta.legacy_workspace_layout_cleaned_at` 已存在 → 直接返回（表示上一次已全量成功）。
   - **单事务内**按固定顺序：
     1. 再次确认无完成标记（防竞态，可选但推荐）。
     2. **先扫描全部** `sessions`：将每行 `metadata` `JSON.parse`；结果必须是非 null 的 plain object。任一解析失败或非对象 → **立即 throw**，整单回滚（此时尚不应已删除 config / 写标记；若实现上 DELETE config 在扫描前，throw 同样依赖事务回滚还原）。
     3. 对解析成功的行：若顶层存在 `writeDirChoice`，从副本删除该键，收集待更新列表；**不得**改写 `updated_at` 或其他列。
     4. `DELETE FROM configs WHERE key = 'config.workspaceLayout'`（须在同一事务内执行；勿用会提前 `db.save()` 的封装，或提供事务内变体）。
     5. 应用待更新：`UPDATE sessions SET metadata = ? WHERE id = ?`（仅 metadata）。
     6. **校验**：确认本事务视野内不存在仍含顶层 `writeDirChoice` 的会话（对已解析对象再检一遍，或对 UPDATE 后的值断言）。
     7. **仅此时**写入 `schema_meta` 完成标记（ISO 或 epoch 字符串均可）。
   - **Fail-closed（唯一允许策略）**：禁止「跳过损坏行仍写完成标记」。永久门闩与「跳过」互斥；本迁移选整体回滚。
   - **禁止**：调用 `updateSession`；禁止给 `updateSession` 加 `preserveUpdatedAt` 之类通用例外。
   - **日志**：
     - 成功：`logAgentEvent`（如 `startup.legacy_workspace_layout_cleanup`），含扫描数 / 剥离会话数 / 是否删除 config。
     - 失败：**事务回滚之后**再记失败摘要与会话 `id`；**不得**记录 metadata 原文或完整 JSON。
2. `sanitizeArtifactSessionMetadataOnSave` 改为**所有会话**保存时剥除 `writeDirChoice`（防御性；当前仅 artifact 会话会剥）。本轮与启动 helper **一并保留**到最终发布（见 §1.4 / WP5）；不得假设「仅开发期临时存在」。
3. 单测（最低集，须用真实 SQLite 夹具；**失败回滚为必测，不可降级为可选**）：
   - 多条新旧会话：清理前后各会话 `updated_at` **完全相等**；
   - `listSessions` 返回顺序与清理前一致；
   - 其他 metadata 字段（含已有 `artifactDefaultDir`、artifact flag 等）不变；
   - **不会**创建 `artifactDefaultDir`；
   - 无 `writeDirChoice` / 无 config 键时仍写完成标记且二次执行无变化；
   - **损坏行 fail-closed（必测）**：构造「前一条可清理（含 `writeDirChoice` + 有 `config.workspaceLayout`）、后一条 metadata 非法 JSON」的 DB；断言调用失败后：`config.workspaceLayout` 仍在、两条 session 的 `metadata`/`updated_at` 均保持原状、**无**完成标记；修复非法行后再次运行 → 全量清理成功并写出标记。
   - **最终发布态直升（必测，可与 WP5 同测但契约在 WP2 定死）**：旧版 SQLite fixture（含 `config.workspaceLayout` + 至少一条带 `writeDirChoice` 的 session，**无**完成标记）由「完成 WP1–WP5 后的最终代码路径」首次打开/调用启动清理入口，断言 helper **仍执行**全量清理并写出标记；不得只测 WP2 中间提交、也不得依赖「标记已被开发机写过」。

**验收**

- 成功路径：清理后 `configs` 无 `config.workspaceLayout`；**全部**会话 metadata 无顶层 `writeDirChoice`；完成标记存在。
- 受影响会话的 `updated_at` 与 `listSessions` 顺序不变。
- 失败路径：任一坏行 → 零提交 + 无标记 + 下次可重试至成功。
- `resolveArtifactDefaultDir` 行为不变；相关 `legacyMigration` / artifact 测试通过。

**实现提示**

```text
// 门闩在事务外可读；写入必须在成功事务末尾
if (schema_meta has cleaned_at) return

try {
  runInTransaction(db, () => {
    const rows = SELECT id, metadata, updated_at FROM sessions
    const updates = []
    for each row:
      const meta = JSON.parse(row.metadata)   // throws → rollback
      if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw
      if ('writeDirChoice' in meta) {
        const next = { ...meta }; delete next.writeDirChoice
        updates.push({ id, metadata: JSON.stringify(next) })
      }
    DELETE configs WHERE key = config.workspaceLayout
    for each u in updates:
      UPDATE sessions SET metadata = u.metadata WHERE id = u.id  -- no updated_at
    // optional re-check: no remaining top-level writeDirChoice in parsed set
    INSERT/REPLACE schema_meta cleaned_at
  })
  db.save() // 一次
  log success
} catch (err) {
  // 事务已回滚；仅 log sessionId / error name；无 marker
  log failure; rethrow or return failed — caller must not write marker
}
```

不必升 `DB_SCHEMA_VERSION`（无 DDL）。标记放 `schema_meta`，避免污染 `AppConfig` / `configs` 业务键空间。

### WP3 — 删除模块与 IPC / 渲染

**做啥**

1. 删除整个 `electron/workspaceLayout/`。
2. 删除 `file-write-dir:*` IPC、preload、api 类型、test setup mock。
3. 删除 WriteDir UI / store / hook / CSS / `WorkspaceLayoutTab`。
4. `ChatView` / `confirmStoresInit` / `chatRunnerService` 去引用。
5. `main.ts` 去掉 workDir 切换清 writeDirChoice。

**验收**

- `rg 'file-write-dir|WriteDirConfirm|workspaceLayout/|applyWorkspaceLayoutRedirect|writeDirChoice' --glob '!docs/**'` 无生产命中（允许本计划与 Deprecated 旧需求文档；WP2 helper 在剥除逻辑删干净前可暂时命中 `writeDirChoice` 字面量）。
- 相关组件测试文件已删；`npm test` 通过。

### WP4 — 类型表面与设置 nav 重命名

**做啥**

1. 从 `domainTypes` / `AppConfig` / `config:get|set` / `configSetTypeGate` / snapshot 测试移除 `workspaceLayout`。
2. nav key：`workspaceLayout` → `artifacts`；i18n 同步；`ToolsSettingsTab` switch case 更新。
3. 删除 `config.workspaceLayout.*` 与 `chat.writeDir*` i18n；`i18n:generate-types` + `i18n:check`。

**验收**

- `typecheck:shared` / `typecheck:renderer` 通过。
- 设置 → 工具 →「工作产物」仍只显示 `ArtifactSettingsTab`，行为不变。

### WP5 — 文档与收尾（保留迁移入口）

**做啥**

1. 按 §4.8 更新/归档文档；修订 changelog「旧行为保留」表。
2. **本轮最终发布必须保留**：
   - 完整 one-shot helper（无标记时全量扫描 / 清理 / 校验 / 写标记；fail-closed 回滚与重试）；
   - `main.ts`（或同等启动路径）对接线；
   - 保存路径上的 `writeDirChoice` 剥除（`sanitize…`），**或**已落地并单测覆盖的导入/会话备份恢复边界剥除。
3. **本轮禁止**：
   - 删除 one-shot helper 整文件；
   - 将 helper 缩成「仅检查 `schema_meta` 标记后 return」、无清理实现；
   - 在无替代剥除入口时删除 `sanitize…` 的 `writeDirChoice` 逻辑；
   - 用「开发机 / CI 在 WP2 已清理过」代替「用户旧库首次打开最终构建」的证明。
4. helper / sanitizer 的真正退役不在本计划范围；未来独立计划须写明最低可直升版本或强制升级链后再删。
5. 全仓 grep 验收（允许保留的迁移/剥除符号命中）；更新本计划状态为 **Done** 并注明合并提交。

**验收**

- changelog 与代码一致：legacy **运行时/UI/IPC** 已删除；迁移入口仍在。
- **直升升级测试（必测）**：无完成标记的旧 fixture + 最终代码 → 清理成功并写标记（与 WP2 契约一致；在最终树或等价导出入口上跑）。
- **恢复路径测试**：若保留 on-save sanitizer — 断言写入含 `writeDirChoice` 的 metadata 会被剥除且不创建 `artifactDefaultDir`；若改走导入边界 — 断言从仍含该键的会话备份/导入恢复后库内无该键。
- `npm test` && `npm run i18n:check` && 相关 typecheck 全绿。

---

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 经 `updateSession` 批量剥 metadata → 全部命中会话 `updated_at` 被刷新、最近列表被重排 | **已定为阻断项**：专用 SQL helper + 单测锁死时间戳与顺序；CR 拒绝任何经 `updateSession` 的清理路径 |
| 部分会话已清理但标记/config 未提交 | 单事务；失败整单回滚 |
| 损坏 metadata 被「跳过」却写入永久完成标记 → 永久漏清 | **fail-closed 唯一策略**（§1.4 / WP2）；禁止跳过；必测「好行+坏行」回滚与修复后重试 |
| 启动因单行坏 JSON 无法启动应用 | helper/调用方 catch：回滚后记日志（仅 session id），不写标记，应用继续；下次启动重试 |
| WP5 删掉 / 缩减 helper → 旧版直升用户永久漏清 | **迁移保留窗口**（§1.4）：最终发布保留完整入口；必测无标记旧 fixture × 最终代码 |
| 外部脚本/旧客户端仍调 `file-write-dir:reset` | 仓库内已确认渲染无调用方；IPC 删除后 invoke 自然失败，可接受 |
| 用户依赖「扩展名自动归类」 | 产品已转向 artifact；发布说明写明关闭且不再回退；引导开启工作产物管理 |
| 会话备份 JSON 仍含 `writeDirChoice` | 不强制改磁盘备份文件；恢复入库后由**本轮仍保留的** on-save sanitizer 或导入边界剥除（见 §3 / WP5），并有对应测试；**不得**声称依赖已删除的剥除逻辑 |
| 误删 artifact i18n / decision UI | 删除前用 key 前缀白名单；CR 核对 `artifactSettings` / `artifactDecision` / `writeSuccess` |
| 测试夹具大面积编译失败 | WP4 单独提交，优先修 `AppConfig` 构造点 |

---

## 7. 验证清单

- [x] 聚焦：原 `workspaceLayout` / WriteDir 测试已删除或改写，无失败引用
- [x] WP2：多会话清理前后 `updated_at` 不变、`listSessions` 顺序不变、无 `artifactDefaultDir` 副作用、二次执行幂等
- [x] WP2：坏 JSON 行 → 调用失败后 config/两条 session/`updated_at`/完成标记均原状；修复后重跑全量成功（必测）
- [x] WP5 / 最终树：无完成标记的旧 SQLite fixture 由最终代码首次打开 → helper 仍全量清理并写标记（必测）
- [x] 恢复路径：on-save 或导入边界仍能剥除 `writeDirChoice`（与 WP5 选定策略一致）
- [x] 最终树仍含完整 helper + 启动接线（非只读门闩）
- [x] `npm test`
- [x] `npm run typecheck:shared` && `npm run typecheck:renderer`
- [x] `npm run i18n:check`
- [ ] 手动：artifact **关** — `write_file` 到 `docs/analyze/foo.md` 路径不变、无确认卡
- [ ] 手动：artifact **开**（新会话）— 带 `artifact` 的写入仍走决策/登记
- [x] grep：生产代码无 `applyWorkspaceLayoutRedirect` / `file-write-dir`；`writeDirChoice` 仅存于归档文档、本计划、以及保留的迁移/剥除 helper
- [x] DB（直升成功路径）：无 `config.workspaceLayout`；会话无 `writeDirChoice`；`schema_meta` 有完成标记（单测覆盖）

---

## 8. 建议提交序列（Conventional Commits）

1. `refactor(artifacts): remove legacy workspace layout runtime hooks`
2. `chore(db): strip workspaceLayout config and writeDirChoice without touching updated_at`
3. `refactor: delete workspaceLayout module, write-dir IPC and UI`
4. `refactor(config): drop WorkspaceLayoutConfig; rename tools nav to artifacts`
5. `docs: archive directory-layout specs; mark legacy cleanup done`

（可按 WP 合并为更少提交，但避免「删模块 + 改产物行为」混在同一 commit。）

---

## 9. 附录：与近期事故的关系

2026-07-24 日志中，LLM 请求写入 `docs/analyze/builtin-subagent-design-conclusions.md`，因：

1. 会话 `artifactManagementEnabled=false` 时仍走 legacy（当时门控为 `!artifact`）；
2. `writeDirChoice` 确认流把**绝对路径**再经 `normalizeRelPathInput` 剥前导 `/` 后相对 `workDir` 拼接，存成双重路径；
3. `.md → Docs` 再拼一层。

最终落到 `Users/space/Documents/Develop/SpaceAssistant/docs/analyze/Docs/...`。

门控已改为永不回退 legacy；本计划删除残存实现与脏配置，从根上避免同类排障噪音与误用。清理脏 metadata 时必须保持会话时间线不变，避免「修配置」变成「重排最近会话」。完成标记只在全库可证明清理成功后写入；损坏行不得被跳过并闩死。用户从旧版直接安装本轮最终构建时，仍须跑完整 one-shot 迁移——开发工作包顺序不等于用户升级路径。
