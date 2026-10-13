# 存储占用页修复与压缩优化计划：刷新风暴 + 归档卡 20% 根因修复（P1–P3）+ 压缩 I/O 效率与 worker 化（P4–P5）

> 状态：**v3 待实施**（基准重定为 HEAD `ea273da6`；v1 基于 `6fe55d43` 定位根因，v2 新增 P4/P5，v3 吸收评审 `docs/review/2026-10-13-storage-settings-refresh-storm-and-compact-busy-fix-plan-review.md` 阻断项 B1–B3，并经实测修正其 B2 结论——见 §1.2 D2 第二条）
> 日期：2026-10-13（v3 同日修订）
> 关联现象：用户报告「设置-存储占用页面进入之后一直在自动刷新用量；归档并压缩按钮点击后，一直卡在 20%」（本机安装环境，旧构建）。**注意：`ce06b3b5`（profile 扫描移入 managed workers）已重写症状 A 的根因链代码，症状 A 是否仍复现需先在当前打包版本验证（§1.1），再决定是否移除 §1.1/P3 与收敛标题。**
> 关联模块：`electron/storage/sessionStorageMaintenance.ts`、`electron/ipc/storageMaintenanceIpc.ts`、`src/renderer/components/Config/StorageSettingsTab.tsx`、`electron/storageProfile/storageProfileCoordinator.ts`

---

## 一、问题与根因

### 1.1 症状 A：进入页面后一直在自动刷新用量——根因链已被 `ce06b3b5` 消除，待复现验证后决定移除本节

**历史根因 D3（已消除，留档）**：v1 基准 `6fe55d43` 上，`useTypedTranslation` 返回的 `t` 每次渲染都是新引用（`typedT` 无 `useCallback`，`src/renderer/i18n/useTypedTranslation.ts:9-15`），`StorageSettingsTab.tsx` 旧版把它放进 `refresh = useCallback(..., [t])` + `useEffect(..., [refresh])` 依赖链，形成「刷新→重渲染→新 t→再刷新」无限循环；每轮触发一次 `collectSessionStorageProfile` 全量 DB 扫描（当时在主进程同步执行），主进程被长期占满。

**当前状态（实测 `ea273da6`，与评审 B1 一致）**：

- `StorageSettingsTab.tsx:20-21` 改用 `translate.current` ref 透传，`:35-47` 的 `loadOverview = useCallback(..., [])` 空依赖 + mounted/request-id 双守卫，`:70-78` effect 依赖 `[loadOverview]` 引用稳定——**循环不存在**；全仓已无组件把 `t` 放进依赖数组。
- profile 收集移入 managed worker（`StorageProfileCoordinator` / `storageProfileWorkerClient`），`storage:get-profile` 通道已删除（`electron/ipc/storageMaintenanceIpc.test.ts:19` 断言其不存在），主进程不再被扫描占满。
- `useTypedTranslation.ts:9-15` 的 `typedT` 仍无 `useCallback`（属实），但已无不稳定引用的消费方——**P3 从「修 bug」降级为防御性可选改进**（见 Phase 3）。
- 测试断言现状：`StorageSettingsTab.test.tsx` 已是 `toHaveBeenCalledOnce()`（`:48`/`:58`/`:123`），v1 所引「`:28` 放宽为 `>= 2`」的证据已不存在。

**处置（评审修订建议 2）**：先在当前打包版本复现「进入存储页持续刷新」；若不复现（预期如此，旧构建先升级验证），移除本节与 Phase 3、标题收敛为「压缩可用性与效率」；若仍复现，说明旧构建之外另有因素，重新立项排查。

### 1.2 症状 B：归档并压缩卡在 20%

20% 是前端写死的假进度（现 `StorageSettingsTab.tsx:168`：archive=20%、vacuum=55%、reclaim=80%）。用户旧构建上的「永远卡住」由 D1 + D2 叠加造成；在当前 HEAD 上两者各已修复一半，剩余缺口如下。

**D1（根因，唯一遗留功能性缺陷，评审核实成立）**：忙碌预检查把空闲 claim 当活跃轮次。

`electron/storage/sessionStorageMaintenance.ts:105-112` 的 `activeSessionTurnCount`（claims 子句在 `:108`）：

```sql
(SELECT COUNT(*) FROM session_execution_claims WHERE status IN
  ('queued','claimed','executing','transcript_committed','commit_uncertain')) + ...
```

但在 `session_execution_claims` 表里 `status='queued'` 是**释放后的空闲态**，不是排队中：

- `sessionTranscript.ts:117`（`releaseSessionExecution`，释放路径）：`SET turn_id='',owner_id='',status='queued'` —— 释放后每会话永久保留一行；
- `sessionTranscript.ts:100-101`（`claimSessionExecution`）：`claim.status !== 'queued'` 才视为被占用，即 `queued` = 可获取/空闲；
- 对照组：`electron/storage/periodicSqliteMaintenance.ts:10` 的同款检查**不含** `'queued'`，语义正确。`activeSessionTurnCount` 的状态列表是从 `session_execution_queue` 表（那里 `queued` 才是真等待，释放时整行 DELETE，`sessionTranscript.ts:119`）复制过来的，属复制粘贴错误。

净效果：任何会话只要完成过一个轮次，就会留下一条 `queued` 空闲 claim，`activeSessionTurnCount` 永远 > 0，**手动归档压缩在首次使用后即永久不可用**，每次点击毫秒级抛 `STORAGE_MAINTENANCE_BUSY`（本机 85 条空闲 claim 实测，§1.4）。

**D2（呈现层，剩余缺口比 v2 诊断小、但比评审 B2 认定的多一层）**：错误码稳定化已引入但**谓词失效**。

- ✅ 已修复（`ce06b3b5` 后现状）：渲染层 catch 已有 `setProgress(null)`（`StorageSettingsTab.tsx:95`）——「永远卡 20% + 按钮 loading」在当前 HEAD 已不可能复现（旧构建现象 = D1 即时抛错 + 旧版无复位叠加）；错误统一经 `stableMaintenanceError`（`storageMaintenanceIpc.ts:42-45`）收敛为稳定码字串。
- ❌ **仍失效（实测，修正评审 B2 的「busy 判别有效」结论）**：`stableMaintenanceError` 的谓词是 `error.message.includes('MAINTENANCE_BUSY')`，而 `compactSessionDatabase` 抛出的 `StorageMaintenanceError` 的 **message 是英文句子**（`'database maintenance requires all session turns to be idle'`，`sessionStorageMaintenance.ts:114-116`），code 才是 `'STORAGE_MAINTENANCE_BUSY'`——谓词**永不命中**，busy 落入通用 `STORAGE_MAINTENANCE_FAILED`。错误透传链已核实无包装：`withMaintenance`/`runMaintenance`（`storageProfileCoordinator.ts:67-99`）在 catch 中原样 `throw error`，不存在把 code 拼进 message 的层。`storageMaintenanceIpc.test.ts` 对该映射**零测试覆盖**。`STORAGE_MAINTENANCE_INSUFFICIENT_SPACE`（`:155`/`:180`）同样落入通用文案（这一条与评审 B2 认定一致）。
- 净症状（当前 HEAD，D1 修复后预期）：点击压缩若遇忙碌/空间不足 → 立即失败 + 通用「存储维护失败，请稍后重试」，**看不到「仍有会话运行中」这一真实原因**。修复收敛为 P2 两条小任务（谓词修复 + INSUFFICIENT_SPACE 映射/文案）。

**附注（修好 D1 后仍存在的体验问题，由 Phase 4 / Phase 5 解决）**：`compactSessionDatabase` 整体是主进程同步执行（`sessionStorageMaintenance.ts:118-228` 无任何 `await`），729MB 库跑一次约产生 **3.7 GB 读 + 2.2 GB 写**（明细见 §4.0），期间应用整体冻结数分钟，进度条只停 20% 直到瞬间跳 100%。Phase 4 削减重复 I/O 并接真字节进度，Phase 5 把重活挪出主线程并用 `VACUUM INTO` 消除主进程阻塞。

### 1.3 为什么不清理数据、不改释放语义

- 85 条空闲 claim **不是脏数据**，是 `releaseSessionExecution` 的设计产物，且 `claimSessionExecution:104` 依赖该行做 generation 单调递增（`(claim?.generation ?? 0) + 1`），删除会破坏 generation 链。正确修法是改查询谓词，不是动数据、也不是改 claim/release 协议。
- `queued` + 非空 `turn_id` 的 claims 行在真实流程中**不会产生**（INSERT 只以 `claimed` 入行 `:106-107`，release 必然清空 `turn_id`），修复无需为它防御。

### 1.4 本机实测证据（2026-10-13，安装环境 `%APPDATA%/spaceassistant`）

| 证据 | 观测值 | 指向 |
| --- | --- | --- |
| `session_execution_claims` 中 `status='queued'` 行数 | **85**，`turn_id`/`owner_id` 全部为空串 | D1：空闲 claim 使忙碌计数永 > 0 |
| `session_execution_queue` / `messages(status queued|streaming)` / `turns(活跃态)` | 均 0 行 | 排除其它忙碌来源，唯一阻塞即 D1 |
| `session-archives/` 目录内容 | 仅 `legacy-json/`，**无任何 compact 归档目录** | compact 从未走到建归档目录（预检查即抛错；失败且未过校验时归档目录会被删除，`sessionStorageMaintenance.ts:216`） |
| DB 规模 | 764 MB（+4 MB WAL）、spill 8.4 MB | P4 §4.0 的 I/O 计量量级 |
| 测试断言 | v1 所引 `StorageSettingsTab.test.tsx:28` 放宽为 `>= 2` **已不存在**（当前为 `toHaveBeenCalledOnce()`，`:48`/`:58`/`:123`） | D3 根因链随 `ce06b3b5` 一并消除，证据失效 |
| `stableMaintenanceError` 映射 | `storageMaintenanceIpc.test.ts` 零断言；谓词 `message.includes('MAINTENANCE_BUSY')` 对 `StorageMaintenanceError` 永不命中（实测 HEAD） | D2 剩余缺口：busy/INSUFFICIENT_SPACE 均落通用文案 |

---

## 二、修复方案总览

五个 Phase（基准 `ea273da6`）：P1 修唯一遗留功能缺陷 D1；P2 收缩为 D2 剩余缺口的两条小任务（评审 B2 修正后）；P3 降级为防御性可选项（评审 B1/B3）；P4–P5 解决压缩的阻塞与效率（诉求来源：用户评审「现在这样的方案很吓人」——主进程同步冻结数分钟 + 6 GB 级 I/O 放大）：

| Phase | 缺陷/目标 | 改动面 | 优先级 |
| --- | --- | --- | --- |
| P1 | D1 忙碌预检查误判（唯一遗留功能缺陷） | `sessionStorageMaintenance.ts` + 其测试 | P0，先行实施 |
| P2 | D2 剩余缺口：`stableMaintenanceError` 谓词失效 + INSUFFICIENT_SPACE 未映射 | `storageMaintenanceIpc.ts`、`StorageSettingsTab.tsx`、i18n | P1 |
| P3 | 防御性可选：`t` 引用稳定化（无现存消费方受影响） | `useTypedTranslation.ts` + 既有测试文件追加用例 | P2（可选，复现验证后可移除） |
| P4 | 压缩 I/O 效率（读放大 5→2 遍、FK 全表校验、重复 VACUUM）+ 字节级进度埋点 | `sessionStorageMaintenance.ts`、新增 `streamingCopy.ts`、`StorageSettingsTab.tsx`、`storageTypes.ts` | P1 |
| P5 | 压缩挪出主线程（worker_threads + `VACUUM INTO`），主进程零阻塞、全程真实进度 | 新增 worker 模块与编排器重构、启动对账、`safeDbMaintenance.ts`、UI | P2 |

依赖关系：P1 是 P4/P5 的功能前提（可压缩才有可优化）；P4 与 P2/P3 相互独立；**P5 复用 P4 的流式复制/哈希原语与字节进度通道（P4 无抛弃工作量）**；P4-T5 的真百分比 UI 在 P5-T8 演进而非重写。P1→P2 建议先行合入交付（小改动快收益），P3 待 §1.1 复现验证结论决定去留，P4/P5 按阶段独立提交、独立验收。

## 三、验收边界（开工前对齐）

**前置项（评审修订建议 2，P3 去留的判定条件）**：在当前打包版本复现验证症状 A——进入存储页观察是否仍持续刷新。预期不复现（根因链已随 `ce06b3b5` 消除，旧构建先升级）；不复现则移除 §1.1 与 Phase 3、标题收敛；仍复现则重新排查立项。

**当前环境可单测验证**：P1/P2 全部、P4/P5 全部代码改动与测试（vitest electron + renderer 项目）、P3 的 hook 用例。

**需真机（本机安装环境）验收**：

1. 症状 A 复现验证（前置项本身）；
2. 无会话运行时点「归档并压缩」真实执行（`session-archives/` 出现新目录、DB 文件变小、进度 20→55→80→100）；
3. 有会话/IM 轮次运行时点击，出现「仍有会话运行中…」文案（依赖 P2 谓词修复）且按钮恢复可点。

---

## 四、详细任务清单

> 每个任务给出**机械可验证的完成判据（DoD）**。行号以 2026-10-13 main（`6fe55d43`）为基准。

### Phase 1：忙碌预检查修正（D1）

- [x] **P1-T1 红：先写「完整释放后可压缩」回归测试（当前代码必须跑红）**
  - 文件：`electron/storage/sessionStorageMaintenance.test.ts`
  - 新增用例 `allows compaction after every claim has been released`：对同一 session 依次调用公开 API `claimSessionExecution` → `releaseSessionExecution`（import 自 `electron/database/sessionTranscript.ts`）走完整一轮，然后直接调用 `compactSessionDatabase`。
  - **DoD**：`npm exec vitest run --project electron electron/storage/sessionStorageMaintenance.test.ts` 中该用例**红**（当前抛 `STORAGE_MAINTENANCE_BUSY`），其余既有用例全绿。
  - 注意：测试库走 `createTempDatabase`，compact 会真实 VACUUM，用小数据量即可。

- [x] **P1-T2 绿：修正 `activeSessionTurnCount` 的 claims 谓词**
  - 文件：`electron/storage/sessionStorageMaintenance.ts:105-112`（claims 子句 `:108`）
  - 改动：claims 子句状态列表 `'queued','claimed','executing','transcript_committed','commit_uncertain'` → **移除 `'queued'`**，与 `periodicSqliteMaintenance.ts:10` 完全对齐；`session_execution_queue` 子句、turns 子句、messages 子句**一律不动**（queue 表的 `queued` 是真等待，必须保留）。
  - 不做：不清理既有 85 条空闲行、不改 `releaseSessionExecution`、不给 `queued+turn_id≠''` 加防御分支（真实流程不产生，见 §1.3）。
  - **DoD**：P1-T1 用例转绿；同文件既有用例（busy 三连 + queued 拒绝）按 P1-T3 调整后全绿；`npm run build:electron:incremental` 无错。

- [x] **P1-T3 修正被错误语义钉死的既有测试**
  - 文件：`electron/storage/sessionStorageMaintenance.test.ts:171-183`
  - 现状：`it.each(['session_execution_claims','session_execution_queue'])('refuses compaction for a queued turn in %s')` 中 claims 分支手工插入 `status='queued'` 且 `turn_id='queued-t'` 的行——真实流程不产生此形状，断言了错误语义。
  - 改动：**claims 从 `it.each` 中移出**；queue 分支保留原断言（queue 的 queued 仍拒绝）；新增用例断言「claims 空闲行（`turn_id=''、status='queued'`，即 release 后形状）**不**触发 busy」。
  - **DoD**：改名后用例 `refuses compaction for a queued turn in session_execution_queue` 单独存在；`npm exec vitest run --project electron electron/storage/sessionStorageMaintenance.test.ts` 全绿。

- [x] **P1-T4 不变量测试（AGENTS.md「票据类模块」强制要求）**
  - 文件：`electron/storage/sessionStorageMaintenance.test.ts` 末组新增
  - 内容：mulberry32 固定种子生成随机操作序列（对 N 个 session 随机执行 claim/release/cancelQueuedSessionExecution/commitSessionTranscript），每步后断言跨函数不变量：
    - 「`activeSessionTurnCount` 导出后的忙碌计数 > 0」⇔「存在 status ∈ {claimed, executing, transcript_committed, commit_uncertain} 的 claims 行 ∨ queue 表存在未删除行 ∨ 存在活跃 turns/messages 行」；
    - **全部票据释放后忙碌计数必为 0**（本缺陷的直接不变量，回退修复应转红）。
  - 需先把 `activeSessionTurnCount` 从模块私有 `export`（或经 `compactSessionDatabase` 的 rejects 断言间接验证，二选一，**推荐直接 export** 以便逐断言）。
  - 参考模板：`electron/butler/butlerAdmission.test.ts` 末组用例。
  - **DoD**：不变量用例全绿；临时把 P1-T2 的修改回退，该用例必须转红（红绿同步验证，做完恢复）。

### Phase 2：D2 剩余缺口——`stableMaintenanceError` 谓词修复 + INSUFFICIENT_SPACE 映射（收缩版）

> v2 的「code-as-message 重构」已无必要：错误稳定化层已存在（评审 B2 正确部分），渲染层 `setProgress(null)` 与 busy 文案分支也已在。剩余缺口实测为 §1.2-② 的谓词失效 + INSUFFICIENT_SPACE 未映射，两条小任务即可闭合。

- [x] **P2-T1 修复 `stableMaintenanceError` 谓词 + 补映射 + IPC 层测试**
  - 文件：`electron/ipc/storageMaintenanceIpc.ts:42-45`
  - 改动：判别从 `error.message.includes('MAINTENANCE_BUSY')` 改为对 `StorageMaintenanceError` 的 code 判别（`import { StorageMaintenanceError } from '../storage/sessionStorageMaintenance'`，`error instanceof StorageMaintenanceError ? error.code : ...` 兜底现有 message.includes 以防其他层拼接）；返回值三分：`STORAGE_MAINTENANCE_BUSY` / `STORAGE_MAINTENANCE_INSUFFICIENT_SPACE` / `STORAGE_MAINTENANCE_FAILED`。
  - 测试：`storageMaintenanceIpc.test.ts` 新增——注入 `StorageMaintenanceError('STORAGE_MAINTENANCE_BUSY', '英文句子')` 形态的错误，断言 handler 抛出的 message 恰为 `'STORAGE_MAINTENANCE_BUSY'`（当前实现此用例必红，即本任务的红色验证）；INSUFFICIENT_SPACE 同理。
  - **DoD**：两条新用例红→绿；`storageMaintenanceIpc.test.ts` 既有断言（含 `:19` get-profile 不存在）全绿；`npm run build:electron:incremental` 通过。

- [x] **P2-T2 渲染层 INSUFFICIENT_SPACE 文案 + i18n key**
  - 文件：`src/renderer/components/Config/StorageSettingsTab.tsx:95-97`（compact catch）
  - 改动：错误分支加第三支：`reason.message.includes('STORAGE_MAINTENANCE_INSUFFICIENT_SPACE')` → `t('storage.insufficientSpace')`；busy 分支不动（P2-T1 修复后即可生效）。
  - i18n：`zh-CN/config.json` 与 `en-US/config.json` 的 `storage` 命名空间新增 `insufficientSpace`（zh 建议：「磁盘剩余空间不足，归档压缩需要约与数据库相当的空间」），随后 `npm run i18n:generate-types`。
  - 测试：`StorageSettingsTab.test.tsx` 追加——compact reject message 为 `STORAGE_MAINTENANCE_INSUFFICIENT_SPACE` → 渲染 insufficientSpace 文案；再补一条 busy → `storage.busy`（钉住 P2-T1 的端到端效果）。
  - **DoD**：`npm exec vitest run --project renderer src/renderer/components/Config/StorageSettingsTab.test.tsx` 全绿；`npm run i18n:check` 与 `:strict` 通过；`npm run typecheck:renderer` 通过。

### Phase 3（可选，防御性）：`useTypedTranslation` 引用稳定化

> 定性（评审 B1/B3）：`typedT` 仍无 `useCallback` 属实，但全仓已无把 `t` 放进依赖数组的消费方——**不修任何现存 bug**。价值仅是消除未来踩坑面；§1.1 复现验证若确认症状 A 消失，本 Phase 整体移除。

- [x] **P3-T1（可选）hook 用 `useCallback` 固定 `t`**
  - 文件：`src/renderer/i18n/useTypedTranslation.ts:9-15`
  - 改动：`typedT` 包 `useCallback`，deps `[t]`（react-i18next 的 `t` 仅在语言/命名空间变化时变引用）；`i18n`、`ready` 透传不变。
  - **DoD**：`npm run typecheck:renderer` 通过；全仓渲染测试无新红。

- [x] **P3-T2（可选）在既有测试文件追加引用稳定性用例（评审 B3：文件已存在，勿新建）**
  - 文件：`src/renderer/i18n/useTypedTranslation.test.tsx`（已存在，21 行，追加而非新建）
  - 追加用例（`renderHook`）：rerender 多次后 `result.current.t` 引用不变；`i18n.changeLanguage('en-US')` 后引用变化且译文正确。
  - **DoD**：`npm exec vitest run --project renderer src/renderer/i18n/useTypedTranslation.test.tsx` 全绿。

### Phase 4：压缩 I/O 效率优化（保持进程内执行，为 P5 备料）

#### 4.0 现状 I/O 计量（为什么吓人）

以本机 764 MB DB + S 字节 spill 为单位，现状一次压缩的磁盘流量：

| 步骤（`sessionStorageMaintenance.ts`） | 读 | 写 | 说明 |
| --- | --- | --- | --- |
| `copyFileSync` DB（:168） | 764 | 764 | 独立一遍复制 |
| `cpSync` spill ×2（:170-171） | S | S | |
| 哈希源 DB（verify :75） | 764 | — | 与复制重复读源 |
| 哈希归档 DB（verify :75） | 764 | — | 读回校验 |
| `integrity_check` 归档（:78） | 764 | — | 全结构校验 |
| `foreign_key_check` 归档（:79） | ≥764 | — | 逐行 FK 索引回查，**常为最慢单步** |
| spill 清单 ×2（:82-85） | 2S | — | cpSync 已读过一遍源，共 3 遍 |
| `VACUUM`（:190） | 764 | ~1528 | 写临时库 + 回写全库 |
| 合计（DB 部分） | **≈5×764 ≈ 3.7 GB** | **≈3×764 ≈ 2.2 GB** | Windows Defender 对每个新文件实时扫描再乘系数 |

设计原则：**归档（恢复用备份）保持「读回校验」强度不降；省的是重复读与过度校验**。本阶段全部改动在 P5 中原样复用，无抛弃工作量。

- [ ] **P4-T1 流式复制 + 双侧哈希原语 `copyFileWithHash`**
  - 新文件：`electron/storage/streamingCopy.ts`
  - 签名：`copyFileWithHash(sourcePath, destPath, options?: { signal?: AbortSignal; onProgress?: (bytes: number) => void }): Promise<{ bytes: number; sourceSha256: string; destSha256: string }>`
  - 实现：4 MiB chunk 循环——读源即更新 sourceSha256 并写入 dest（省掉 `copyFileSync` 的独立一遍读）；写毕读回 dest 流式算 destSha256（**保持现状读回校验强度**）；每 chunk 检查 signal、回调 onProgress。
  - **DoD**：`electron/storage/streamingCopy.test.ts` 新建，用例：随机 5 MB 文件双哈希与 `fileSha256` 一致；onProgress 单调递增至 bytes；abort 中途抛 `STORAGE_MAINTENANCE_CANCELLED`；dest 注入坏字节 → destSha256 失配可检出。

- [ ] **P4-T2 目录流式复制 + 双侧清单 `copyTreeWithManifest`**
  - 文件：同上；签名 `copyTreeWithManifest(sourceRoot, destRoot, options?): Promise<{ bytes: number; sourceManifest: string[]; destManifest: string[] }>`
  - 实现：一遍遍历完成复制+双侧逐文件哈希清单（替代 `cpSync` + `directoryContentManifest` ×2，spill 从 3 遍读降为 1 遍读 + 1 遍读回）；保留现语义：symlink / 非常规文件抛错（对齐 `:61-64` 的错误消息）、空目录/不存在返回空清单。
  - **DoD**：单测覆盖嵌套目录、空 spill、根不存在、symlink 拒绝、进度字节合计；`verifySessionMaintenanceArchive`（:82-85）改用返回的 manifest 比对后既有测试全绿。

- [ ] **P4-T3 归档校验瘦身：`integrity_check` + `foreign_key_check` → `quick_check`**
  - 文件：`sessionStorageMaintenance.ts:76-81`
  - 论证：字节恒等（哈希对）已排除复制引入的损坏；FK 违例不可能由复制产生（源库自身状态随文件原样复制），`foreign_key_check` 的逐行索引回查是纯冗余；保留 `quick_check` 单遍结构兜底（防「源库在快照前已损坏」的场景）。
  - **DoD**：新增用例——归档 DB 注入损坏（翻转页字节）→ 哈希失配或 quick_check 拒绝、compact 报错且归档被清理（未过校验路径 :216）；既有 verify/maintenance 测试全绿。

- [ ] **P4-T4 二级快路径：消灭重复全库 VACUUM**
  - 文件：`sessionStorageMaintenance.ts:184-195`
  - 分档（导出常量 `FULL_VACUUM_FREELIST_RATIO = 0.3`）：
    - **L0**：`freelist_count === 0` → 跳过整理，直接 complete（`reclaimedPages = 0`，报告 `vacuumMode: 'none'`）；
    - **L1**：`auto_vacuum` 已为 `incremental`（首跑后永久生效）且 `freelist_count / page_count ≤ 0.3` → 仅 `PRAGMA incremental_vacuum`（秒级，报告 `vacuumMode: 'incremental'`）；
    - **L2**：其余 → 现状全量 `VACUUM`（报告 `vacuumMode: 'full'`）。
  - 收益：第二次起（多数真实使用形态：删了东西→点压缩）从数分钟降为秒级。
  - **DoD**：三档各一条单测；「连续两次 compact」用例断言第二次 `vacuumMode ∈ {none, incremental}` 且 `durationMs` 显著小于首次；L1 下 `freelist_count` 归零被断言。

- [ ] **P4-T5 字节级进度埋点 + UI 真百分比（同步路径版）**
  - 文件：`src/shared/storageTypes.ts`、`sessionStorageMaintenance.ts`、`StorageSettingsTab.tsx`（compact `:86-98`、Progress 组件 `:168`）
  - 改动：`StorageMaintenanceProgress` 增加可选 `completedBytes?: number; totalBytes?: number`（向后兼容，既有 `completedPages/remainingPages` 保留）；archive/verify 阶段经 onProgress 发真实字节（源自 P4-T1/T2 的 onProgress）；渲染层 percent 优先 `completedBytes/totalBytes` 计算、缺字节时回落 `:168` 的旧档位映射。
  - **DoD**：主进程测试断言进度序列按字节单调不减、`totalBytes` 与实际一致；渲染测试断言 percent 由 bytes 推导。

- [ ] **P4-T6 维护报告增补**
  - 文件：`writeMaintenanceReport`（:97-103）调用点（:209-213）
  - 新增字段：`vacuumMode`、`stageDurationsMs: { archive, verify, vacuum, total }`、各阶段字节数。`formatVersion` 升 2（增量字段，向后兼容）。
  - **DoD**：报告 schema 测试更新；为 §五 V6 的前后对比提供数据。

### Phase 5：压缩挪出主线程（worker_threads + `VACUUM INTO` + 全程真实进度）

#### 5.0 设计决策

**选型：worker_threads（非 utilityProcess）。**

| 维度 | worker_threads（选定） | utilityProcess |
| --- | --- | --- |
| 仓库先例 | ✅ `spillReferenceWorker.ts`（compiled/.ts 双路径 + 进程内降级，:38-45）、`builtinExecutors.ts:1557`（eval worker） | ❌ 全仓无先例，需新建 bootstrap 与生命周期管理 |
| 崩溃隔离 | 线程级（原生崩溃会带崩进程——node:sqlite 纯 JS binding，风险低） | 进程级 |
| 杀超时 | `worker.terminate()`（既有 regex worker 同款，`builtinExecutors.ts:1569-1573`） | `process.kill()` |
| 结论 | 沿用既有模式，改动面最小 | 若隔离实测不足再升级（记录为后备路径） |

**核心机制：`VACUUM INTO`（SQLite ≥3.27，node:sqlite 可用）替代 in-place `VACUUM`。**

worker 用**只读连接**对源库执行 `VACUUM INTO '<staging>'`：只读源、写新文件——主进程连接全程可用（聊天/IM/设置零阻塞）；staging 文件大小可直接轮询 → **整理阶段的真实字节进度**；产物天然无 freelist（`incremental_vacuum`、`auto_vacuum` 舞蹈整段删除）。

**快照一致性（防换入过期数据）**：`VACUUM INTO` 基于快照，主库在整理期间的写入不会进入 staging。防线三层：① 换入前重查 `activeSessionTurnCount`（P1 谓词）；② `PRAGMA data_version` 探针——快照前记值、整理后复核，变更即重做（≤3 次，重做读到的已是新状态）；③ 3 次耗尽抛忙碌类错误、保留归档、**永不换入过期 staging**。回调写入门（IM 新轮次、用户改配置）无需专门代码。

**临界区（秒级）**：`wal_checkpoint(TRUNCATE)` → close 主连接 → `rename(live → archive)`（旧库即归档副本，免一遍复制）→ `rename(staging → live)`（Windows 撞瞬态只读句柄时有限重试 5×200ms）→ reopen → 校验（schema_version、page_count、`freelist_count===0`）。

**崩溃恢复**：staging 命名 `<db>.compact-staging-<ts>`；启动对账——live 存在→删孤儿 staging；live 缺失+staging 在→完成替换后继续启动（rename 原子性保证不存在半截 live）。

**回退开关**：env `SPACEASSISTANT_IN_PROCESS_COMPACT=1` → 走 P4 后的进程内路径（发布保底）。

**先决 spike（评审补充建议，排在 P5-T2 之前，各半天内产出结论回填本节）**：

- [ ] **P5-S1 只读连接执行 `VACUUM INTO` 的 WAL 可行性**：node:sqlite `readOnly` 打开在 WAL 模式下依赖 `-shm/-wal` 可读与目录写权限，`VACUUM INTO` 的快照读语义需用本机 764MB 库实测一次（含：worker 线程内打开、staging 落盘、目标文件已存在时报错语义）。
  - **DoD**： spike 脚本 + 结论小节（可行 / 需 RW 打开 + 补偿 fence / 不可行则 P5 核心机制改选 in-place VACUUM-in-worker 变体并重估 §5.0）。
- [ ] **P5-S2 临界区 close/reopen 对其它 `AppDatabase` 持有方的影响面**：主连接经 `getDbConnection` 共享，close→rename→reopen 窗口内的读请求落点需逐一清点。已知持有方：`StorageProfileCoordinator`（现状 `runMaintenance` 已先 abort/排干 started readers、`maintenanceByDatabase` fence 拒绝窗口内新请求，`storageProfileCoordinator.ts:87-90`/`:47`/`:70`——编排器继续经由 IPC handler 的 `withMaintenance` 包装即可继承该 fence）、IM 桥、spill worker、periodic maintenance 定时器。
  - **DoD**：持有方清单表（每方：窗口内行为 / 是否被既有 fence 覆盖 / 需要编排器补的动作）；若存在未被覆盖方，编排器临界区前置显式排干步骤（进 P5-T3 任务范围）。

- [ ] **P5-T1 协议与类型**
  - 新文件：`electron/storage/sessionStorageMaintenanceWorkerProtocol.ts`（主/worker 共用消息类型：`{type:'progress', phase, completedBytes, totalBytes} | {type:'result', …现状返回值} | {type:'error', code, message}`）；`src/shared/storageTypes.ts` phase 联合增 `'swap'`。
  - **DoD**：`npm run typecheck:shared` + `typecheck:renderer` 通过。

- [ ] **P5-T2 worker 模块**
  - 新文件：`electron/storage/sessionStorageMaintenanceWorker.ts`（`parentPort` 消息驱动，模式照抄 `spillReferenceCollectorWorker.ts`）
  - 职责：接收 `{dbPath, spillRoot, degradedRoot, stagingPath, archivePath}` → 复制归档（复用 P4-T1/T2，含双侧哈希）→ quick_check 归档 → **只读连接** `VACUUM INTO staging`（staging 路径先确保不存在）→ `quick_check` staging → 按 200ms 轮询 staging 字节 + 复制回调上报进度（节流 ≥100ms 或 ≥8 MB）→ 回 result。
  - **DoD**：worker 单测（`new Worker` 直拉，覆盖进度上报、归档校验失败、VACUUM INTO 失败路径）；进度消息速率被断言（≤10 条/秒）。

- [ ] **P5-T3 main 编排器重构**
  - 文件：`sessionStorageMaintenance.ts`——`compactSessionDatabase` 拆为编排器（保持现有签名与返回值字段全部兼容）：fence/precheck（P1 谓词不动）→ 记 `data_version` → spawn worker（双路径解析 + 进程内降级，仿 `spillReferenceWorker.ts:38-45`）→ 透传进度到既有 `storage:maintenance-progress` → 临界区（§5.0）→ 写报告（P4-T6 字段）。
  - **DoD**：`sessionStorageMaintenance.test.ts` 既有用例全绿（外部行为不变，仅时长分布变化）；新增「worker 缺失编译产物时进程内降级」用例。

- [ ] **P5-T4 快照一致性**
  - **DoD**：单测两条——worker 整理期间主连接写入（触发 data_version 变更）→ 断言重做且换入后数据含该写入；连续 3 次变更 → 断言报忙碌、归档保留语义与现状一致（`:216-226`）。

- [ ] **P5-T5 崩溃恢复对账**
  - 文件：`main.ts` 启动序列（`safeDbMaintenanceRequested` 判定附近，`:138`/`:665`）
  - **DoD**：单测两条（构造文件布局）——live 在+staging 孤儿 → 启动删除 staging；live 缺失+staging 在 → 完成替换、库可打开、报告补记 `recoveredAtSwap: true`。

- [ ] **P5-T6 watchdog 与取消通道**
  - 实现：worker 无字节进展 >120s → `terminate()` + 清理 staging + 抛 `STORAGE_MAINTENANCE_TIMEOUT`（新错误码，渲染层落通用失败文案）；`AbortSignal` 贯穿 worker 消息（P4-T1 已埋 chunk 级检查）。
  - **DoD**：单测——注入停滞 worker → 断言 terminate、staging 清理、错误码正确。

- [ ] **P5-T7 回退开关**
  - **DoD**：单测——env 置位时断言进程内路径函数被调用、worker 未 fork；未置位走 worker。

- [ ] **P5-T8 渲染层收口**
  - 文件：`StorageSettingsTab.tsx`、i18n `storage.phase.*`
  - 改动：新增 `swap` 阶段文案（zh：「正在切换压缩后数据库…」/ en 对应）；percent 全程取 `completedBytes/totalBytes`（P4-T5 通道），无长时间停滞后突跳。
  - **DoD**：渲染测试——收到带 bytes 的进度序列时 percent 单调推进；`npm run i18n:check` 通过。

- [ ] **P5-T9 `safeDbMaintenance` 接入编排器**
  - 文件：`safeDbMaintenance.ts:12`——启动修复模式同样走 worker 路径（启动期不再冻结）；`main.ts:138`（`safeDbMaintenanceRequested`）与 `:665`（启动接入点）的 `measureStartupPhase` 包装保留。
  - **DoD**：`--safe-db-maintenance` 模式冒烟（dev 启动参数）+ 关联测试绿。

- [ ] **P5-T10 真机量化验收数据回填**
  - **DoD**：按 §五 V7 执行后，将四阶段耗时/字节与修复前基线对照表回填至本文档 §1.4 之后新小节。

---

## 五、收尾验收

- [ ] **V1 定向测试一次合并跑**：`npm exec vitest run --project electron electron/storage/sessionStorageMaintenance.test.ts electron/ipc/storageMaintenanceIpc.test.ts --project renderer src/renderer/components/Config/StorageSettingsTab.test.tsx src/renderer/i18n/useTypedTranslation.test.tsx` 全绿（P3 实施时）。
- [ ] **V2 关联面**：`npm run test:related -- electron/storage/sessionStorageMaintenance.ts electron/ipc/storageMaintenanceIpc.ts` 无新红。
- [ ] **V3 静态检查**：`npm run build:electron:incremental`、`npm run typecheck:renderer`、`npm run i18n:check`（新增 key 时含 `:strict`）全过。
- [ ] **V4 全量**：`npm test`（Phase 收尾/提交前各一次，不作为增量循环手段）。
- [ ] **V5 真机验收**：§3 第 1 条症状 A 复现验证（决定 P3 与 §1.1 去留）；第 2/3 条按原样确认并记录（含压缩前后 `session-archives/`、DB 体积对比截图/数据；第 3 条依赖 P2-T1 谓词修复生效）。
- [ ] **V6（P4 收尾，真机）效率基线对比**：同一 764 MB 库——修复前记录一次完整压缩耗时；P4 后首次压缩耗时下降 ≥40%（以 `maintenance.json` 的 `stageDurationsMs` 为准），同库第二次压缩走 L0/L1 快路径耗时 < 30 s；数字回填 §1.4 附表。
- [ ] **V7（P5 收尾，真机）主进程活跃性 + 全程真进度**：压缩全程聊天窗口可输入/滚动、进行中的流式会话不受阻；进度百分比随字节单调推进（无「长期 20% 后突跳」）；压缩后消息数与最近消息内容与压缩前一致（无快照过期丢数据）；`--safe-db-maintenance` 启动修复模式下窗口可交互。

## 六、明确不在本次范围（后续单独立项）

1. **设置页「取消压缩」入口**：P5 已内置 AbortSignal 通道与 watchdog terminate，但 UI 暂不提供取消按钮；`STORAGE_MAINTENANCE_CANCELLED` 仍只由内部 signal 触发、`STORAGE_MAINTENANCE_TIMEOUT` 落通用失败文案。
2. **升级到 utilityProcess 真进程隔离**：若 worker_threads 路径实测出现隔离不足（原生崩溃带崩主进程），再按 §5.0 选型表迁移——编排器/协议设计已按可替换边界拆分。
3. `useTypedTranslation` 之外的 effect 依赖模式巡检——`ce06b3b5` 后全仓已无把 `t` 放进依赖数组的消费方；若 §1.1 复现验证确认症状 A 消失，连 P3 一并从本计划移除，此项随之关闭。

## 七、风险与回退

| 风险 | 评估 | 缓解 |
| --- | --- | --- |
| P1 放宽判定导致压缩撞上真实在跑的轮次 | 低：queue/turns/messages 三个子句未动，活跃轮次仍被拦截；claims 的 `queued` 空闲行本身不持有任何执行资源 | P1-T4 不变量测试 + 真机验收第 3 条 |
| P3 影响 `t` 语义（语言切换不及时更新） | 低：`useCallback` deps 含 react-i18next 的 `t`，语言切换时 `t` 引用本身会变 | P3-T2 用例 2 钉死 |
| P2-T1 谓词改为 instanceof 后跨 worker 边界的错误形态 | 低：`StorageMaintenanceError` 抛自主进程侧 `compactSessionDatabase`，不经 worker/IPC 序列化即到达 `stableMaintenanceError` | 保留 `message.includes` 兜底分支；P2-T1 两条映射测试钉死 |
| P4-T3 放弃 `foreign_key_check` 削弱校验 | 低：字节恒等（哈希对）已排除复制损坏，FK 违例不可能由复制引入；`quick_check` 单遍兜底仍在 | P4-T3 损坏注入用例（哈希失配或 quick_check 拒绝） |
| P4-T4 L1 档不做全量整理导致碎片残留 | 低：仅释放空闲页不碎片整理，L2 阈值（30%）兜底重度碎片场景；`vacuumMode` 写进报告可观测 | V6 真机记录 `vacuumMode` 分布 |
| P5 临界区（close→rename→reopen）窗口崩溃导致 live 缺失 | 中：rename 原子，不存在半截 live；最坏停在与归档/串换等价的状态 | P5-T5 启动对账（staging 完成替换）；旧库已在归档中双保险 |
| P5 `VACUUM INTO` 快照过期 → 换入丢增量写入 | 高危但已闭合：data_version 探针 + fence 复查 + ≤3 次重做，**永不换入过期 staging** | P5-T4 两条单测 + V7 真机比对消息数 |
| P5 worker 崩溃/卡死 | 低：watchdog 120s terminate + 清理；env 开关可回退进程内路径 | P5-T6/T7 单测；发布初期保留 `SPACEASSISTANT_IN_PROCESS_COMPACT=1` 保底 |
| P5 Windows rename 撞瞬态只读句柄（profile 收集等） | 低：句柄生命周期均为毫秒级；EBUSY 有限重试 5×200ms | P5-T3 重试逻辑单测（注入 EBUSY→成功） |
| 回退方式 | P1–P3、P4、P5 为三个独立提交单元，可按单元单独 revert | 每阶段独立提交；P5 另有运行时回退开关 |
