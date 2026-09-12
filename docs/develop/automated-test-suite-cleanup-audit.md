# 自动化测试模块清理审计与建议（修订版 v2）

- 审计基线：`main` @ `f89c4ca`（单一提交，全部结论在该提交上复核）
- 修订说明：v1 以 `1f6e794` 为基线，经评审（`docs/review/automated-test-suite-cleanup-audit-review.md`）判定不通过后整体修订。本版已按评审门禁：在 `f89c4ca` 干净 worktree 上重跑全量测试与 `typecheck:renderer`，删除范围收窄，所有「删除」动作前置强制门禁。
- 实测数据（`f89c4ca` 干净副本，先执行 `npm run i18n:generate-types`）：
  - `vitest run`：**513 个测试文件（2 failed / 511 passed）、3227 个用例（6 failed / 3221 passed）、约 94 秒**；
  - `npm run typecheck:renderer`：**4 个类型错误，失败**；
  - 当时的失败原因是下方已闭合的合并回归；该问题已在后续提交修复。
- 结论摘要：测试纪律整体良好（无 skip/todo/only 遗留）。本轮清理聚焦三项：**两个度量脚本移出默认测试集**、**feishu/wechat 薄包装重复用例在接线 smoke 先行的门禁下合并**、**两处弱断言补齐**。v1 中「删除 workspaceLayout 迁移测试」的建议**已整体撤回**（见第二节）。

## 评审回应对照

| 评审意见 | 本版处理 |
|---|---|
| P0-1 基线过期，已修复问题不得列为执行步骤 | 基线换为 `f89c4ca` 并全量重测；历史 P0 已移出执行建议；其余判断逐项在新基线复核 |
| P0-2 删除 workspaceLayout 迁移测试违反保留不变量 | 全部撤回：该测试与 JSON 导入剥离用例移入「必须保留」，退役需独立计划（第二节） |
| P1-4 薄包装删除缺「接线契约先落位」门禁 | 每个拟删文件给出「现有断言 → 覆盖去向」逐项映射表；「先补/迁 smoke → 聚焦测试通过 → 再删原用例」设为不可跳过的工作包门禁（第三节） |
| perf 脚本不能仅搬到 scripts/ | 改为独立 vitest project + 显式 npm script 入口（第一节） |
| worktree 清扫不混入测试清理 | 移入「范围外事项」（第六节） |
| `getLegacyJsonDbPath` 独立处理 | 独立小清理，与 JSON→SQLite 迁移退役决策解耦（第二节） |

---

## 已闭合的历史发现

`e9b1f6c` 合并时误删的「服务模型列表拉取」链路已由 `ba30381`（`fix(llm): restore service model fetch IPC`）恢复，相关 IPC、preload 桥接、共享类型和草稿模型参数现已回归主线，不再作为本轮清理步骤。

- `toolConfirmRegistry.ts` 缺逗号：`f89c4ca` 已补（v1 基线 `1f6e794` 上的 38 套件加载失败已消失）；
- `classifyPathWithSymlink`：`pathClassifier.ts:55` 已恢复导出，`extractors.test.ts` 相关用例在本次全量运行中通过。

---

## 一、度量脚本移出默认测试集：独立 vitest project 方案

两个文件被 renderer project 的 include（`src/**/*.test.{ts,tsx}`）匹配，每次 `npm test` 都执行，但其自我定位是本机性能采集（软断言、硬编码 `cpu: 'Apple M2'` / `os: 'macOS 26.5.2'`、往 `docs/develop/` 写结果 JSON）：

- `src/renderer/components/Chat/ChatMessageList.perf.measure.test.tsx`
- `src/renderer/components/Chat/ChatMessageList.perf.batch2.measure.test.tsx`

它们依赖 Vitest 的 jsdom 环境、mock 与测试生命周期，**搬到 `scripts/` 裸跑并不可行**（评审已指出）。正确做法是加第三个 project 并从默认入口排除：

```ts
// vitest.config.mts  projects 数组追加：
{
  test: {
    name: 'renderer-perf',
    include: ['src/**/*.perf.measure.test.tsx'],
    environment: 'jsdom',
    globals: true,
    pool: 'threads',
    maxWorkers: 1,          // 采集互斥，避免并行干扰计时
    setupFiles: ['./src/test/setup.ts']
  }
}
// renderer project 的 include 追加排除：
//   include: ['src/**/*.test.{ts,tsx}'],
//   exclude: ['src/**/*.perf.measure.test.tsx', '**/node_modules/**']
```

```json
// package.json
"test": "vitest run --project electron --project renderer",
"perf:chat-list": "vitest run --project renderer-perf"
```

配套：结果 JSON 改由脚本参数指定输出目录或移入 gitignore（`docs/develop/chat-message-list-batch*-remeasure-results.json` 现被每次 `npm test` 改写，这也是它们一直出现在 git status 里的原因）；`chat-message-list-batch*-remeasure-gate.md` 的验收门槛若要 CI 级防回归，应写成对**相对比较**的硬断言放回 renderer project，而非依赖采集脚本。

> 注：`electron/shell/shellLifecycleBenchmark.test.ts` 名字含 benchmark 但是真实回归测试（缓冲上限、节流事件数上限、生命周期幂等硬断言），保留。

---

## 二、迁移路径测试（不属于本轮范围）

本轮不删除、不合并迁移路径测试，也不对 JSON→SQLite、workspaceLayout 或确认策略迁移做退役判断。未来如需退役，应另立计划，并先验证外部恢复/导入旧数据及活跃启动路径等保留约束。

---

## 三、薄包装冗余测试：接线 smoke 先行（强制门禁）

背景不变：IM 能力已泛化为 `electron/remote/im*` + `confirmation/imChannel.ts` 基类，feishu/wechat 侧剩 12~47 行薄包装，两侧测试与通用层重复。**但通用层只能证明算法，不能证明每个 wrapper 传入了正确的 channel、文件名、轮转参数、identity key 或 metadata 接线**——这正是评审 P1-4 指出的盲区（例如把 `feishu` 写成 `wechat`、漏掉 retention，通用层测试全部照绿）。

**工作包门禁（不可跳过）**，对每个拟删文件按序执行：
1. 先补/迁 wrapper smoke（下方映射表「smoke 覆盖」列），聚焦测试通过；
2. 再删重复行为用例，聚焦测试通过；
3. 最后跑 `npm test` 全量。

### 3.1 可合并文件（映射表：现有断言 → 覆盖去向）

| 拟删/合并文件 | 现有断言 | 通用层已有 | 须先落位的 wrapper smoke |
|---|---|---|---|
| `feishu/feishuProcessedStore.test.ts` | 7 天 purge 等 | `remote/imProcessedStore.test.ts` 已覆盖同类行为 | 断言 `channel: 'feishu'` 与注入的 `logEvent` 为 `logFeishuCliEvent`（模块仅 12 行，构造参数即全部自有逻辑） |
| `wechat/weChatProcessedStore.test.ts` | 同上镜像 | 同上 | 同上（wechat 侧） |
| `feishu/feishuSessionResolver.test.ts` | 3 个会话复用用例（决策逻辑在 `imSessionResolver`） | `remote/imSessionResolver.test.ts` 已覆盖 | 断言 wrapper 接线：`identityKey = chatId`、新建时写入 `metadata.feishuChatId`/`feishuMessageId`、**复用时更新 `feishuMessageId`**（`onReuse` 是 wrapper 自有逻辑） |
| `wechat/weChatSessionResolver.test.ts` | 同上镜像 | 同上 | 同上（wechat 侧对应字段） |
| `feishu/feishuAuditLogger.test.ts` | append+tail 用例（通用层真子集） | `remote/imAuditLogger.test.ts` | 断言 feishu 特有配置：`feishu-audit.log`、`5MB`、`5` 份备份（**与 wechat 不同**，正是 wrapper 存在的意义） |
| `wechat/weChatAuditLogger.test.ts` | 同上镜像 | 同上 | 断言 `wechat-audit.log`、`10MB`、`3` 份备份 |
| `feishu/feishuRemoteAgent.test.ts` | credentials 解析 2 用例与 `remote/imRemoteAgent.test.ts` **逐字级重复**（新基线复核仍成立）；I8/I9/I10 等注入用例 | credentials 两用例通用层已覆盖 | 保留 I8/I9/I10 等 appendix/locale/appDb/workDir 接线用例不删 |
| `wechat/weChatRemoteAgent.test.ts` | 同上镜像 | 同上 | 同上 |
| `feishu/feishuRemoteOutbound.test.ts` | 4 用例中 3 个被通用层+`shared/remoteOutboundFormat.test.ts` 覆盖 | 已覆盖 | 压缩为一条飞书常量接线 smoke（`maxLen=4000`、截断后缀） |
| `feishu/feishuCliLogger.test.ts`、`wechat/weChatCliLogger.test.ts` | init/flush 断言流与 `remote/imCliLogger.test.ts` 近乎同构 | 已覆盖 | 保留 secret→`[REDACTED]` 脱敏断言（**建议先补进 im 侧再删**）+ 一条 preprocess 接线 smoke |
| `feishu/feishuImChannel.test.ts`、`wechat/weChatImChannel.test.ts` | 约一半用例（Y/N 解析、超时、cancelAllPending、桌面代答）测 `imChannel.ts` 基类 | `confirmation/imChannel.test.ts` 已覆盖 | 保留 owner/p2p 入站鉴权、飞书确认文案、trust 误触用例（子类真实逻辑） |

### 3.2 其它重复组（维持 v1 判断，新基线复核）

| 组 | 结论 |
|---|---|
| `electron/toolChatLoop.shell.test.ts`（8 用例，全部直接调 `precheckRunShellTool`，未经过循环）vs `electron/shell/shellToolLoopHelpers.test.ts`（5 用例） | 重复覆盖。合并到后者；前者只保留真正经过 toolChatLoop 的集成用例（当前一个都没有，合并后文件可整体删除） |
| `confirmation/extractors/commandSequenceExtractor.test.ts` | 仅 2 个 effectiveCwd 用例，主覆盖在同目录 `extractors.test.ts`，合并 |
| `claudeStreamHandlers.pairing.test.ts` vs `src/shared/toolResultPairing.test.ts` | **不重复**：集成壳 vs 核心算法，保留两者 |

### 3.3 顺带的覆盖缺口（清理时一并补）

- `remote/weChatProgressAdapter.ts`：**零测试**；
- `remote/feishuProgressAdapter.ts`：仅 `remoteConfirmPolicy.test.ts:57` 一条最小 channel smoke（`channel==='feishu'`、`sendTyping` undefined）——v1 误记为「无专属测试」，已修正。建议补齐与 im 基类契约一致的用例。

---

## 四、空壳/弱断言与静默跳过（新基线逐项复核，维持 v1 判断）

| 位置 | 问题 | 建议 |
|---|---|---|
| `electron/browser/rateLimitService.test.ts`「no-ops when rateLimitEnabled is false」 | 函数体只有两次 `acquire`，零断言 | 补断言（耗时近 0 / limiter 内部状态未变） |
| `electron/browser/rateLimiter.test.ts`「waitForAvailable resolves after window slides」 | 仅靠不挂死间接通过 | 补时序值断言 |
| `electron/workDirBinding.test.ts:173`「rejects non-writable directory」 | win32 下静默 `return`，报告 passed 而非 skipped | 改 `ctx.skip()`（对齐 `safeAtomicWrite.test.ts:59`） |

其余平台守卫（`processOutputEncoding`、`shellSpawnEnv`、`runShellExecutor` 的 win32/darwin 分支）属合理平台专属用例，保留。

---

## 五、命名误导但不建议删的（防止过度清理）

- `electron/shell/shellLifecycleBenchmark.test.ts`：硬断言回归测试；
- `electron/sessionTitleSuggest.manualTitle.test.ts`：「manual」指产品语义，全 mock 自动测试；
- `electron/shell/scriptContentSecurity.{test,b,residual}.test.ts` 三件套：A/B/R 三份安全 fixture 清单的刻意拆分，自带一致性守卫（可选：主文件补 `.a.` 后缀对称）；
- 迁移路径测试不在本轮清理范围内。

---

## 六、范围外事项（不混入本轮清理提交）

1. **worktree 清扫**：`.worktrees/` 下多个 worktree 含未合入 main 的分支，必须逐个检查脏状态、合并状态与所有者后单独处理，不能按目录批量删除。
2. **`getLegacyJsonDbPath` 死导出**：可作为独立小型清理先行提交，与本轮测试清理解耦。
3. **`src/renderer/i18n/types.ts`**：干净检出后需先跑 `npm run i18n:generate-types` 再测试——已知流程，非问题。

---

## 执行建议（按优先级）

| 优先级 | 动作 | 工作量 |
|---|---|---|
| P1 | 两个 `ChatMessageList.perf.*.measure` 改为独立 `renderer-perf` project + `npm run perf:chat-list`（第一节） | 小 |
| P2 | feishu/wechat 薄包装清理，严格按 3.1/3.2 映射表与三步门禁执行 | 中 |
| P2 | 空壳测试补断言、静默 return 改 `ctx.skip()`（第四节） | 小 |
| P3 | `getLegacyJsonDbPath` 死导出删除（独立提交）；`weChatProgressAdapter` 补测试；`toolChatLoop.shell.test.ts` 等合并 | 小 |

**验证顺序（每个工作包收尾必跑）**：聚焦测试 → `npm test` → `npm run typecheck:renderer` → `npm run typecheck:shared`；凡涉及 Electron 生产模块删改的工作包，追加 `npm run build:electron`。

**预期收益**：合并/删除约 10 个薄包装测试文件与若干重复用例组；`npm test` 不再默认执行本机度量脚本（也不再每次改写 `docs/develop/` 下的结果 JSON）。**本轮不计入迁移测试删除收益。**

---

## 审计口径说明（v2）

- 历史实测数据基于 `f89c4ca` 干净 worktree：`Test Files 513 (2 failed)`、`Tests 3227 (3221 passed / 6 failed)`、93.86s；`typecheck:renderer` 4 个类型错误均同源于当时的合并回归，该回归已由 `ba30381` 修复。
- v1 的全部关键判断（薄包装行数与接线、credentials 用例逐字重复、死导出、弱断言、perf 脚本行为）均已在 `f89c4ca` 上逐项复核；有改动的结论（feishuProgressAdapter 覆盖情况、getLegacyJsonDbPath 行号）已在正文修正。
- 迁移路径「可达性」判断除发布时间线外，本次补齐了活跃调用点核查（`main.ts:239` / `main.ts:327`）与 `legacy-workspace-layout-cleanup-plan.md` §1.4 不变量比对；发布时间线依据 git tag（v0.1.5）与版本 bump 提交（0.1.6 / 0.1.7）。
