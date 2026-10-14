# 管家定时任务 · 工作目录绑定（消除跨日期漂移）方案

**版本：** 1.0（方案待评审，未实施）
**日期：** 2026-10-02
**状态：** 待用户评审 —— 本文只出方案，不改代码
**触发背景：** 产品支持多工作目录（WorkDirProfile）切换，但定时任务（automation/管家）不支持指定工作目录；任务触发时使用「当时的活动目录」，导致同一任务在不同日期的读取上下文与输出结果发生漂移
**关联代码：** `electron/butler/butlerInvoker.ts`、`electron/butler/taskStore.ts`、`electron/workDirManager.ts`、`src/renderer/components/Config/ButlerTaskSettings.tsx`

---

## 1. 结论摘要

| 结论 | 说明 |
|------|------|
| **漂移根因是「任务不持有目录身份，触发时借用活动目录」** | `butlerInvoker.ts:142` 创建会话时用 `getActiveWorkDirProfileId()`——即**触发那一刻**用户恰好切换到的目录。昨天 23:00 在项目 A 下建的任务，今天 09:00 触发时活动目录是项目 B，任务就在 B 里跑 |
| **修复方向：任务级目录绑定（钉住 profile id）** | `AutomationTask` 增加可选 `workDirProfileId`；触发时按「任务绑定 > 活动目录回退」解析，并把**实际使用的目录**记录到 run 行，使漂移可审计 |
| **除会话绑定外还有两处次级漂移点需一并修** | ① 会话台账（session events）落盘目录用的是活动目录而非会话绑定目录；② 历史序列化 `workspaceRoot` 同样用活动目录。工具执行本身已按会话解析，不受影响 |
| **run 行不记录目录 → 事后无法解释结果差异** | `automation_task_runs` 增加 `workdir_profile_id` + `workdir_path` 快照，run 历史可回答「这次执行到底在哪个目录跑的」 |
| **profile 删除目前对任务无感知 → 绑定修复后仍是静默漂移后门** | 删除被任务绑定的 profile 时需联动处理（提示 + 回退为跟随活动目录），否则钉住形同虚设 |

**一句话：给任务一个持久的目录身份（绑 profile id），触发、执行、落盘、审计全链路使用同一身份；未绑定的老任务保持现状（跟随活动目录），零迁移成本。**

---

## 2. 现状与漂移根因

### 2.1 现有链路

定时任务的执行链（`runButlerTask`）：

1. 调度器到点 → 幂等抢占 run 行 → 准入取票；
2. **创建会话**（`butlerInvoker.ts:140-146`）：

```ts
const session = createSession(db, {
  name: `管家 · ${task.prompt.slice(0, 24)}`,
  ...(deps.getActiveWorkDirProfileId ? { workDirProfileId: deps.getActiveWorkDirProfileId() } : {}),
  ownership: 'automation',
  visibility: 'section'
})
```

   `getActiveWorkDirProfileId()` 在 `main.ts:875` 装配为 `workDirManager.getActiveProfileId()`——**触发时刻的活动目录**。
3. `runButlerModelTurn` 中工具执行目录已按会话解析（`butlerInvoker.ts:296` `resolveWorkDirForSession`），但有三处仍取活动目录 `deps.getWorkDir()`。

任务数据模型（`automationTaskTypes.ts` / `taskStore.ts` / `MIGRATION_V15_BUTLER_TABLES_SQL`）中**没有任何目录相关字段**：任务只有 `prompt / schedule / deliveryPref / deliveryTarget / modelOverride`。

### 2.2 三处漂移点

| 编号 | 位置 | 用途 | 漂移影响 |
|------|------|------|----------|
| **D0（主因）** | `butlerInvoker.ts:142` 会话创建 | 会话的 `workDirProfileId` 绑定 | 会话归属目录随触发日活动目录漂移；会话列表中同一任务的历史会话散落在不同目录分组下 |
| **D1** | `butlerInvoker.ts:288` `createButlerSessionEvents({ workDir: deps.getWorkDir() })` 与 `:333` `sessionEventLocation` | 会话台账事件文件落盘目录 | 钉住目录后，台账仍会写进「当时活动目录」的 `.agent/` 事件目录，审计与回看错位 |
| **D2** | `butlerInvoker.ts:249` `buildClaudeToolChatMessages({ workspaceRoot: deps.getWorkDir() })` | 历史中 agent 工具结果的路径序列化基准 | 相对路径被解析到错误目录，历史回看中的文件路径可能指向不存在的位置 |

> 工具**执行**目录不受影响：`butlerInvoker.ts:296-323` 已把 `resolveWorkDirForSession` 的结果传入 `assembleInvocation`，并经 `buildResolveWorkDirCallback` 逐次解析。所以漂移不改变「这次跑对了没有」，但改变「下次在同一目录吗」与「台账/历史在哪里」。

### 2.3 漂移场景

```text
10-01 23:00  用户在项目 A 下创建「每日 09:00 汇总 git 变更」任务
10-02 08:00  用户切到项目 B 处理另一件事，未切回
10-02 09:00  任务触发 → 会话绑定 B → 在 B 里执行 git log/读取文件 → 汇总结果是 B 的内容
10-03 09:00  活动目录又被切到 C → 输出变成 C 的内容
```

每天输出主题不同、且**事后无法解释**（run 行只记了 summary 与 usage，不记目录）。用户感知为「定时任务时好时坏」。

### 2.4 附带缺陷：profile 删除无联动

`workDirManager.removeProfile()`（`workDirManager.ts:306`）只校验「至少保留一个目录」，不检查是否有任务/会话引用该 profile。会话侧已有回退语义（`resolveWorkDirForSession` 找不到 profile 时回退活动目录），任务侧同理会静默回退——即使实现了绑定，删除目录仍是无声的漂移入口。

---

## 3. 方案设计

### 3.1 核心语义：任务绑定 profile id（三态）

给 `AutomationTask` 增加可选字段：

```ts
export type AutomationTask = {
  // ...existing
  /** 任务绑定的工作目录 profile；缺省（undefined/NULL）= 跟随触发时的活动目录（现状行为）。 */
  workDirProfileId?: string
}
```

**三态解析规则**（触发时执行一次，会话创建前）：

| 任务绑定值 | profile 状态 | 解析结果 | run 行记录 |
|-----------|-------------|---------|-----------|
| 未绑定（NULL） | — | 跟随当前活动目录（= 现状，老任务零迁移） | 记实际使用的 profile id + path |
| 绑定 id | profile 存在 | **钉住**该 profile（无论活动目录是什么） | 记绑定的 profile id + 当前 path |
| 绑定 id | profile 已删除 | 回退当前活动目录 + 降级标记 | 记实际 profile id + path + `fallback` 标记 |

设计取舍：

- **绑 id 不绑路径**：profile 改名/改路径（`updateProfile`）后任务自然跟随；与现有会话绑定语义（`Session.workDirProfileId`）一致，复用同一套解析函数。
- **回退而不是失败**：目录被删导致每日汇总类任务连续失败，比降级到活动目录更伤；但回退必须**显式留痕**（run 行标记 + 一次性桌面通知），不重演「静默漂移」。
- **不做「绑定路径字面量」**：避免 profile 与任务两处各存一份路径产生不一致。

### 3.2 执行链改造（`butlerInvoker.ts`）

```ts
// runButlerTask 内，会话创建前解析一次，贯穿整个 run
const profiles = deps.workDirManager?.listProfiles() ?? []
const boundId = task.workDirProfileId
const pinned = boundId ? profiles.find(p => p.id === boundId) : undefined
const resolvedProfileId = pinned ? boundId : deps.getActiveWorkDirProfileId()
const workdirFallback = Boolean(boundId && !pinned)   // 钉住目标已删除

const session = createSession(db, {
  name: `管家 · ${task.prompt.slice(0, 24)}`,
  ...(resolvedProfileId ? { workDirProfileId: resolvedProfileId } : {}),
  ownership: 'automation',
  visibility: 'section'
})
```

随后：

1. **run 行快照**（新增 `updateAutomationTaskRun` 字段）：把 `resolvedProfileId`、`resolveWorkDirForSession` 得到的 path、`workdirFallback` 写入 run 行；
2. `workdirFallback = true` 时经 `deliveryPorts.notifyDesktop` 发一条一次性警告（「任务 X 绑定的目录已不存在，本次已在活动目录执行」），**不阻断执行**；
3. **修 D1/D2**：`runButlerModelTurn` 内三处 `deps.getWorkDir()` 改为按会话解析的 workDir（函数内 `butlerInvoker.ts:296` 已有现成变量，提升其解析时机或复用）：
   - `createButlerSessionEvents({ workDir: <会话解析目录> })`；
   - `sessionEventLocation: { workDir: <会话解析目录>, ... }`；
   - `buildClaudeToolChatMessages({ workspaceRoot: <会话解析目录> })`。

> 注意：手动触发（`trigger: 'manual'`）与定时触发走同一函数、同一解析规则——手动触发**不应**「临时用活动目录」，否则「点了立即运行验证，次日凌晨调度却用了别的目录」这类认知错位依旧存在。表单里看得见的绑定才是唯一事实。

### 3.3 数据模型与迁移

`schema.ts` 新增（现最新为 V27，顺延 V28）：

```sql
-- MIGRATION_V28_AUTOMATION_TASK_WORKDIR_SQL
ALTER TABLE automation_tasks ADD COLUMN workdir_profile_id TEXT;
ALTER TABLE automation_task_runs ADD COLUMN workdir_profile_id TEXT;
ALTER TABLE automation_task_runs ADD COLUMN workdir_path TEXT;
ALTER TABLE automation_task_runs ADD COLUMN workdir_fallback INTEGER NOT NULL DEFAULT 0;
```

- `automation_tasks.workdir_profile_id`：任务绑定，NULL = 跟随活动目录；
- `automation_task_runs.workdir_*`：执行快照，历史行 NULL = 未记录（升级前的旧 run 不回填）；
- runs 表同时存 id 与 path 快照的原因：profile 事后改名/改路径后，历史 run 的「当时在哪跑」仍可解释。

### 3.4 存储层（`taskStore.ts`）

- `TaskRow` / `rowToTask` / `createAutomationTask` / `updateAutomationTask` 的 patch Pick 列表加入 `workDirProfileId`（写入 `workdir_profile_id`，`undefined → NULL`）;
- `updateAutomationTaskRun` 的 patch 支持三个新字段；
- 新增两个联动 helper：

```ts
/** 绑定到指定 profile 的任务数（删除目录前的影响面提示）。 */
countTasksBoundToProfile(db, profileId): AutomationTask[]
/** 将绑定该 profile 的任务全部回退为「跟随活动目录」（置 NULL），返回影响任务数。 */
unbindTasksFromProfile(db, profileId): number
```

### 3.5 profile 删除联动（`workDirManager` / IPC）

- `workdir:remove` 处理链（现 `appIpc.ts`）在执行删除**前**调用 `countTasksBoundToProfile`：
  - 影响数 > 0 → 返回给渲染端，UI 弹确认框：「有 N 个定时任务绑定此目录，删除后将回退为跟随活动目录」（列出任务名）；
  - 用户确认 → `removeProfile` 成功后调用 `unbindTasksFromProfile`，任务回退为未绑定态；
  - 用户取消 → 不删除。
- `updateProfile` 改路径**无需**任务侧处理（id 绑定天然跟随；run 行 path 快照保证历史可解释）。
- 实现位置二选一（实现时定）：helper 放 `taskStore.ts`、由 `workdir:remove` handler 串行调用（推荐，`workDirManager` 不反向依赖 butler 表）；或下沉进 `workDirManager.removeProfile` 内部（内聚但引入模块间依赖）。

### 3.6 UI（`ButlerTaskSettings.tsx`）

1. **编辑表单**新增「工作目录」`Select`：
   - 首选项「跟随当前活动目录（触发时）」（value 空串 → 提交时映射为 undefined）；
   - 其余为 `window.api.workdirList()` 返回的 profile（显示名称，sensitive 目录加标记）；
   - 校验：提交值必须存在于 profile 列表（防止选完目录后目录被删再提交）。
2. **任务卡片**新增目录 Tag：绑定态显示目录名，未绑定显示「跟随活动」；
3. **run 历史**显示实际执行目录（path 快照）；`workdir_fallback = 1` 的行加降级标记（如「目录已删除，已回退」）；
4. IPC 面无需新增通道：`butlerCreateTask` / `butlerUpdateTask` 的 payload 均为 `Partial`，字段加进 shared 类型即自动透传；`butlerIpc.ts` 创建/更新时校验 `workDirProfileId` 存在性（不存在即拒绝写入，错误走既有 `ButlerTaskWriteResult.error`）。

### 3.7 敏感目录（sensitive）策略

`WorkDirProfile.sensitive` 现语义为「禁止**远程**访问与切换」（飞书/微信远程指令路径）。管家任务是本机无人值守执行，且门控已强制只读，与远程切换不是同一威胁模型：

- **允许**把任务绑定到 sensitive 目录（本机用户的自主决定）；
- 表单中 sensitive 选项加提示文案；不在主进程做硬拦截；
- 注意投递面：绑定 sensitive 目录的任务若 `deliveryPref: feishu/wechat`，result summary 可能携带目录名/文件名出网——表单中当二者同时出现时提示一句即可（非阻断）。

---

## 4. 变更清单（按层）

| 层 | 文件 | 变更 |
|----|------|------|
| shared | `src/shared/automationTaskTypes.ts` | `AutomationTask` / `AutomationTaskInput` 增 `workDirProfileId?`；`AutomationTaskRun` 增 `workDirProfileId? / workDirPath? / workdirFallback?` |
| 主进程 | `electron/database/schema.ts` | `MIGRATION_V28_AUTOMATION_TASK_WORKDIR_SQL`（3 表加列） |
| 主进程 | `electron/butler/taskStore.ts` | 列映射、create/update 透传、run 快照字段、`countTasksBoundToProfile` / `unbindTasksFromProfile` |
| 主进程 | `electron/butler/butlerInvoker.ts` | 触发时解析绑定 → 会话创建用解析结果 → run 行写快照 → fallback 桌面警告；`runButlerModelTurn` 三处 `deps.getWorkDir()` 改会话解析目录（D1/D2） |
| 主进程 | `electron/butler/butlerIpc.ts` | create/update 校验 profile 存在性 |
| 主进程 | `appIpc.ts`（workdir:remove 链） | 删除前影响面查询 + 删除后 `unbindTasksFromProfile` |
| 渲染 | `ButlerTaskSettings.tsx` | 表单 Select、卡片 Tag、run 历史目录列与降级标记、删除目录确认弹窗（配合 workdir 设置组件） |
| 渲染 | `i18n/resources/{zh-CN,en-US}/config.json` | 新 key（`butler.form.workDir`、`butler.workDir.followActive`、`butler.workDir.fallbackNotice` 等），zh-CN 先行，跑 `i18n:generate-types` + `i18n:check` |
| 类型 | `src/shared/api.ts` | 随 shared 类型自动更新，无通道增删 |

---

## 5. 兼容性与迁移

- 老任务 `workdir_profile_id` 为 NULL → 跟随活动目录 = **现状行为，零数据迁移**；升级后行为完全不变，用户在表单里主动绑定后才开始钉住。
- 升级前产生的 run 行无目录快照 → 历史列表该列显示「—」，不回填。
- 手动触发/调度触发共用同一解析规则（§3.2），不存在两条语义。
- 表结构变更仅 `ADD COLUMN`，SQLite 直接支持，无需重建表。

---

## 6. 测试与验收

### 6.1 可单测验证（electron 项目，`npm run test:electron` 定向跑）

| 用例 | 断言 |
|------|------|
| taskStore 往返 | create/update 带 `workDirProfileId` → 读回一致；不带 → NULL → rowToTask 无该键 |
| 触发解析·钉住 | 任务绑定 profile B、活动目录为 A → 创建的会话 `workDirProfileId === B`；run 行记录 B 的 id+path、fallback=0 |
| 触发解析·回退 | 任务绑定已删除的 profile id → 会话回退活动 profile；run 行 fallback=1；桌面警告被调用一次 |
| 触发解析·未绑定 | 老任务（无绑定）→ 会话绑定当时活动 profile（现状回归） |
| **不变量测试**（AGENTS.md 纪律） | mulberry32 生成「随机切换活动目录 + 触发钉住任务」操作序列：每步后断言该任务所有 run 行记录的 profile id 恒等于绑定 id（活动目录任意漂移不影响钉住任务）；未绑定任务的 run profile 随切换而变 |
| D1/D2 一致性 | `runButlerModelTurn` 中 session events sink 与 `sessionEventLocation` 使用的 workDir === 会话绑定 profile 的 path（而非活动目录） |
| 删除联动 | `countTasksBoundToProfile` 计数正确；`unbindTasksFromProfile` 后任务 `workDirProfileId` 为 NULL 且 `updatedAt` 刷新、排程不受影响 |
| IPC 校验 | create/update 传不存在的 profile id → 拒绝并返回 error |

### 6.2 需真机 / 人工验证（开发环境无法完全自动化）

- 真实目录 A/B 双 profile + 每日任务：切换活动目录后次日触发，确认会话落在绑定目录、台账文件落在绑定目录的 `.agent/` 下；
- 删除被绑定目录的确认弹窗交互与任务回退后的下次触发行为；
- 表单在 0 个 profile（极端配置）下的降级展示；
- 桌面警告通知的实际到达（`Notification.isSupported()` 分支）。

---

## 7. 边界与非目标

- 不做任务级多目录 / 目录组；一个任务一个绑定；
- 不做既有 automation 会话的目录迁移（历史会话保持原绑定）;
- 不改动飞书/微信远程切换目录的语义（aliases / sensitive 远程规则不变）;
- 不做「定时任务触发时自动切活动目录」（会干扰用户前台工作区，风险大于收益）;
- delivery 目标校验、prompt 内容增强等不在本文范围。

---

## 8. 开放问题（评审时定）

1. **profile 删除联动强度**：本文取「确认弹窗 + 回退为跟随活动目录」；是否要更硬的「存在绑定时禁止删除」（逼迫用户先解绑）？建议维持软处理，避免目录清理被任务阻塞。
2. **fallback 是否可选择「失败而非回退」**：可在任务上加 per-task 选项，v1 先统一回退+留痕，观察反馈后再加。
3. **卡片 Tag 与 run 历史目录列的展示密度**：设置页空间有限，path 快照建议 hover 展示全文。
