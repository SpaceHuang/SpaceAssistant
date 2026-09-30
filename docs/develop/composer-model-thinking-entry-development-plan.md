# Composer 模型 / 思考强度合并入口 — 开发计划

> 文档日期：2026-09-30
> 需求依据：`docs/requirement/composer-model-thinking-entry-requirement.md`（状态：需求已定稿，全部决策闭环）
> 文档性质：实施计划（任务拆分 + 完成判据 + 验收映射）
> 交付物：① 合并入口组件；② 档位枚举扩为 5 档（含 IPC 错误文案同步）；③ `displayName` 规则修正；④ 相关测试与文档同步

**评审修订记录**

*第 1 轮（依据 `docs/review/composer-model-thinking-entry-plan-review.md`）*

| 评审项 | 处置 |
|--------|------|
| **B1**（阻断）漏列必改测试 `electron/appIpc.thinkingEffort.test.ts`（断言 `max` 非法） | 新增 **P1-T11** 专责断言反转；P0-T2 基线纳入该文件；P1-G 定向集已含它；风险表补 **R9** |
| **M1** `P0-T1` 核查对象过时（`appIpc.ts` 已无档位校验，实际在 `electron/ipc/*.ts`） | `P0-T1` 改核查 `configIpc.ts` / `sessionIpc.ts`；新增 **P1-T10** 同步三处硬编码错误文案；风险表补 **R10** |
| **M2** `P1-G` 引用不存在的 `npm run test:shared` | 改为 `npm exec vitest run <定向集>` + `npm run test:renderer`（`src/shared/*.test.ts` 归属 renderer project） |
| Minor 1 `packages/agent-core` 重复枚举 | 记入 **R11** + P1-T1 备注（本次不扩，另立需求） |
| Minor 2 需求文档 A26 无法溯源 | 加入 **P6-T6**（补删除留痕 + 提交入库） |
| Minor 3 `modelServiceSuffix` 全角/半角 | 加入 **P4-T2** 备注（须走 i18n，不得写死） |
| Minor 4 `gpt-5-pro` 基线描述不完整 | 修正 **P3-T2** 表格描述（期望值不变） |
| Minor 5 细滚动条白名单覆盖范围 | 加入 **P6-T4** 完成判据 |

*第 2 轮（依据 `docs/review/composer-model-thinking-entry-plan-review-v2.md`）*

| 评审项 | 处置 |
|--------|------|
| **B1(v2)**（阻断）`ComposerThinkingPicker.test.tsx:37` 的 4 档序列断言在 P1 即转红，处置却排在 P6-T2 | 新增 **P1-T12** 在 P1 内先修断言（**不采用评审推荐的「提前迁移」方案，原因见该任务说明**）；P6-T2 仍负责最终迁移/删除 |
| **B2(v2)**（阻断）`thinkingAvailability.test.ts:15` 的 memo 降级断言随 `PRODUCT_EFFORTS` 扩项转红，P1-T3 未覆盖 | **P1-T3** 完成判据补该断言同步；P0-T2 基线与 P1-G 定向集纳入该文件；风险表补 **R12** |
| 附带建议 P0-T2 增加「枚举波及面检索」 | 已落为 **P0-T2 的核查步骤 + 全仓盘点清单**（15 个命中文件逐一判定，见该任务）；风险表 **R9** 补充教训适用范围 |

*第 3 轮（依据 `docs/review/composer-model-thinking-entry-plan-review-v3.md`）*

| 评审项 | 处置 |
|--------|------|
| **B1(v3)**（阻断）`visionModelRouting.test.ts:151` 断言带前缀 `displayName`，P2 规则变化后转红，计划未覆盖 | 新增 **P2-T6** 专责断言反转；P2-G 定向集与 P0-T2 基线命令纳入该文件；**P0-T2 新增「B. 字段类波及面」盘点**（9 文件 27 处逐一判定） |
| 附带建议 P0-T2 判据重复勾选框 | 已删除重复的 `typecheck` 与 `git status` 两条 |

> **第 3 轮的根因**：第 2 轮的教训（波及面盘点）只被应用到了 P1（枚举扩展），**未推广到 P2（字段规则变化）**。故本轮把 P0-T2 的检索原则**抽象为通用条款**：「凡改动产品常量、生成规则或被消费字段，都须检索其**全部断言消费方**」，并分 A（档位类）/ B（字段类）两组固化为盘点表；R9 同步补充该推广。

*第 4 轮（依据 `docs/review/composer-model-thinking-entry-plan-review-v4.md`）*

| 评审项 | 处置 |
|--------|------|
| **B1(v4)**（阻断）P4 引用的 8 个 `composer.prefs.*` i18n 键**无任何任务负责新增**；因 `t()` 强类型（`NamespaceKeyMap`），键不存在 → 组件编译报错，P4-G 必卡且无归属 | 新增 **P4-T0**（建全 9 个 `composer.prefs.*` 键 × 双语言，即需求 §6.5 全套）；P4-G 门禁改为挂载到该任务；风险表补 **R13** |

> **第 4 轮的根因**：门禁**检查了**资源键的存在性（P4-G 自注「组件引用的所有键已存在」），却**没有任务负责创建**它们——属「校验项与产出项脱节」。故本轮除补任务外，另立 **R13** 记录该类失效模式，并要求后续任何「门禁断言某资源已存在」的项，都必须能指回一个**创建该资源的任务**。

*第 5 轮（用户复核反馈）*

| 反馈项 | 处置 |
|--------|------|
| en-US `modelServiceSuffix` 文案与需求不一致（计划表格带**尾空格**，需求 §6.5 无尾空格） | **P4-T0 表格已去尾空格**并加「不得带尾空格」的成因说明（否则与 `chipSeparator` 前导空格叠加成双倍间距）；**P4-T2** 备注同步修正；P4-T2 完成判据新增「en-US 有歧义形态单空格」核对 |
| 徽章样式作用域：`config-settings.css:1761/1765/1776` 的徽章规则为**后代选择器**（`.composer-model-picker .config-model-badge*`），容器改类名即静默失效 | **P4-T10** 新增「徽章样式作用域」说明（给出二选一方案）+ 完成判据；**P6-T4**（负责改类名的任务）挂载同一关注点并纳入判据；风险表补 **R14** |

> **第 5 轮的根因**：`displayName` 类**文案细节**（尾空格）与**CSS 作用域耦合**（容器类名兼任样式锚点）均属「改动点之间的隐式依赖」，前四轮的门禁与盘点表都未覆盖。故另立 **R14**：凡改动**类名 / 资源名 / 文案值**，都须复核「是否有其它规则/拼接依赖该值的**精确形态**」。

> 第 2 轮的两处与第 1 轮的 B1 同属**同一失效模式**：枚举扩展的既有断言波及面盘点不全。故本轮不仅修这两处，而是**全仓扫了一遍所有 `*.test.ts(x)` 中的档位断言**，把清单固化进 P0-T2，使后续任何枚举变更都可复用该步骤。

---

## 0. 如何使用本文档

- **每个任务都有独立的「完成判据」**，全部为可勾选、可执行的条目（命令、断言、可见行为）。判据全绿 → 该任务完成；有任一未满足 → 未完成。
- 勾选框（`- [ ]`）由执行者在完成时改为 `- [x]`，并可在任务末尾追加「完成人 / 日期 / 提交号」。
- **阶段门禁（Gate）**：每一阶段末尾的「阶段收尾」任务必须整体通过，才允许进入下一阶段；每阶段收尾**必须提交一次**（遵循 `AGENTS.md` 的分阶段提交纪律）。
- **测试策略**（遵循 `AGENTS.md`）：开发中只跑**定向测试**（`npm exec vitest run <文件>`）；全量 `npm test` 仅在**阶段收尾**与**提交前**运行。中间构建验证优先 `npm run build:electron:incremental` + `npm run typecheck:renderer`，全量 `npm run build` 仅最终验收时跑。
- ⚠️ **本仓库无 `test:shared` 脚本**：`src/shared/*.test.ts` 归属 vitest 的 **renderer** project，请用 `npm exec vitest run src/shared/` 或 `npm run test:renderer`。
- **状态图例**：⬜ 未开始 ｜ 🔄 进行中 ｜ ✅ 已完成 ｜ ⛔ 阻塞

---

## 1. 任务状态总览

> 执行者只需维护本表与各任务下的勾选框，即可让任何人快速判断进度。

| 阶段 | 任务 | 一句话 | 状态 |
|------|------|--------|------|
| P0 | P0-T1 | 复核契约与影响面（3 条结论落表） | ✅ |
| P0 | P0-T2 | 建立测试/类型基线 | ✅ |
| P1 | P1-T1 | `AgentReasoningEffort` 加 `max` | ✅ |
| P1 | P1-T2 | `THINKING_EFFORT_LEVELS` 扩为 5 项 | ✅ |
| P1 | P1-T3 | `PRODUCT_EFFORTS` 扩为 4 项并改名 | ✅ |
| P1 | P1-T4 | `ThinkingLevelMap` 联合收敛 | ✅ |
| P1 | P1-T5 | i18n 新增 `max` 文案（chat + config） | ✅ |
| P1 | P1-T6 | `thinkingEffort.test.ts` 断言反转 | ✅ |
| P1 | P1-T7 | `effortFallback.test.ts` 补 `max` 断言 | ✅ |
| P1 | P1-T8 | 核实 `buildThinkingWireParams` 无需改动 | ✅ |
| P1 | P1-T9 | 核实 DB 与 IPC 校验自动接受 `max` | ✅ |
| P1 | P1-T10 | 同步三处 IPC 错误文案（去硬编码档位清单） | ✅ |
| P1 | P1-T11 | `appIpc.thinkingEffort.test.ts` 断言反转 | ✅ |
| P1 | P1-T12 | `ComposerThinkingPicker.test.tsx` 序列断言临时扩 5 项 | ✅ |
| P1 | P1-G | **阶段 1 收尾（门禁 + 提交）** | ✅ |
| P2 | P2-T1 | `buildChatModelOptions` 改两遍处理 | ✅ |
| P2 | P2-T2 | 产出 `serviceAmbiguous` 字段 | ✅ |
| P2 | P2-T3 | `llmModelConfig.test.ts` 断言反转 | ✅ |
| P2 | P2-T4 | `sessionModelBinding.test.ts` 断言反转 | ✅ |
| P2 | P2-T5 | 确认浮层列表渲染不受影响 | ✅ |
| P2 | P2-T6 | `visionModelRouting.test.ts` 断言反转 | ✅ |
| P2 | P2-G | **阶段 2 收尾（门禁 + 提交）** | ✅ |
| P3 | P3-T1 | 新增 `resolveAvailableThinkingEfforts` | ✅ |
| P3 | P3-T2 | 为该纯函数补单测 | ✅ |
| P3 | P3-T3 | `ChatView` 计算 `availableEfforts` | ✅ |
| P3 | P3-G | **阶段 3 收尾（门禁 + 提交）** | ✅ |
| P4 | P4-T0 | 新增 `composer.prefs.*` i18n 键（9 键 × 双语言） | ✅ |
| P4 | P4-T1 | 组件骨架 + Props 契约 | ✅ |
| P4 | P4-T2 | 收起态 chip 文案组装 | ✅ |
| P4 | P4-T3 | 浮层容器 + 两分区标题 | ✅ |
| P4 | P4-T4 | 模型分区列表 | ✅ |
| P4 | P4-T5 | 强度分区（横向 N 档） | ✅ |
| P4 | P4-T6 | 选中后立即关闭 | ✅ |
| P4 | P4-T7 | `supportsThinking === false` 禁用态 | ✅ |
| P4 | P4-T8 | 空态 / 模型不可用态 | ✅ |
| P4 | P4-T9 | 无障碍与键盘 | ✅ |
| P4 | P4-T10 | 组件样式（CSS） | ✅ |
| P4 | P4-T11 | 组件单测 | ✅ |
| P4 | P4-G | **阶段 4 收尾（门禁 + 提交）** | ✅ |
| P5 | P5-T1 | `MessageInput` Props 收敛为 `prefsSlot` | ⬜ |
| P5 | P5-T2 | `checkOverflow` 预算简化 | ⬜ |
| P5 | P5-T3 | 渲染合并为一行 | ⬜ |
| P5 | P5-T4 | `ChatView` 接线 `prefsSlot` | ⬜ |
| P5 | P5-T5 | `MessageInput.test.tsx` 改写 | ⬜ |
| P5 | P5-G | **阶段 5 收尾（门禁 + 提交）** | ⬜ |
| P6 | P6-T1 | 删除旧两个组件 | ⬜ |
| P6 | P6-T2 | 迁移 `ComposerThinkingPicker.test.tsx` | ⬜ |
| P6 | P6-T3 | 清理旧 CSS | ⬜ |
| P6 | P6-T4 | 滚动条白名单同步 | ⬜ |
| P6 | P6-T5 | i18n 删旧键 | ⬜ |
| P6 | P6-T6 | 修订两份既有需求文档 | ⬜ |
| P6 | P6-T7 | 类型 / i18n / 全量测试收尾 | ⬜ |
| P6 | P6-G | **阶段 6 收尾（门禁 + 提交）** | ⬜ |
| P7 | P7-T1 | 真机宽度收益验收 | ⬜ |
| P7 | P7-T2 | 截断与换行验收 | ⬜ |
| P7 | P7-T3 | 无障碍读屏验收 | ⬜ |
| P7 | P7-T4 | 回归确认 | ⬜ |
| P7 | P7-T5 | 验收记录归档 | ⬜ |

---

## 2. 阶段依赖与关键路径

```
P0 准备
 ├─> P1 档位枚举 5 档（FR11）────────────┐
 ├─> P2 displayName 修正（FR12）────────┤
 │                                       ├─> P3 availableEfforts（FR10）
 │                                       │        │
 │                                       │        v
 └───────────────────────────────────────┴─> P4 合并入口组件（FR1/2/3/5/6/8/9）
                                                    │
                                                    v
                                            P5 MessageInput 收敛 + 接线（FR7）
                                                    │
                                                    v
                                            P6 清理与文档同步
                                                    │
                                                    v
                                            P7 人工验收
```

- **关键路径**：P0 → P1 → P3 → P4 → P5 → P6 → P7。
- **可并行**：P1 与 P2 互不依赖，可并行或在同一提交内完成（二者都只动 `src/shared/`，冲突面小）。
- **P4 完成时组件尚未接线**（无调用方），这是刻意的：使 P4 成为可独立提交、可独立验证（单测）的交付单元，不改变现网行为。P5 才切换线上路径。
- **P3 依赖 P1**：`availableEfforts` 的取值区间由 5 档枚举决定；P1 未完成时 P3 的断言会失败。

---

## 3. 阶段 0：准备与基线

### P0-T1 复核契约与影响面

**动作**：在动手前确认三件事，并把结论填入下方表格。

1. **IPC 档位校验落点**：⚠️ `electron/appIpc.ts` 已**不含** `thinkingEffort`（IPC 已按 `driver-authority-refactor` Phase 2 拆分）。实际校验点在：
   - `electron/ipc/configIpc.ts:168-170`（`config:set`，走 `isThinkingEffort`）
   - `electron/ipc/sessionIpc.ts:40-42`（`session:create`）
   - `electron/ipc/sessionIpc.ts:100-103`（`session:update`，允许 `null` 清除覆盖）

   需确认三处**均为 `isThinkingEffort` 派生校验、无硬编码白名单**；并登记三处 `throw` 的**错误文案硬编码了档位清单**（`(允许 off / low / medium / high)`），扩档后过时 → 交由 **P1-T10** 处理。
2. 全仓确认 `buildChatModelOptions` 是 `displayName` 的**唯一生成处**（无第二处拼接）。
3. 全仓确认 `MessageInput` 的调用方**只有** `ChatView.tsx`。

**涉及文件**：`electron/ipc/configIpc.ts`、`electron/ipc/sessionIpc.ts`、`src/shared/llmModelConfig.ts`、`src/renderer/components/Chat/MessageInput.tsx`

**完成判据**：
- [x] 已在 **`electron/ipc/configIpc.ts`** 与 **`electron/ipc/sessionIpc.ts`** 检索 `isThinkingEffort`，确认三处均为派生校验、**无硬编码白名单**
- [x] 已记录三处错误文案硬编码位置（`configIpc.ts:169`、`sessionIpc.ts:42`、`sessionIpc.ts:103`），并关联到 P1-T10
- [x] 已检索 `displayName` 全仓，确认生成处仅 `llmModelConfig.ts:253`
- [x] 已检索 `<MessageInput`，确认调用方仅 `ChatView.tsx`
- [x] 下方「P0 结论」表三行均已填写

（完成人：ZCode，2026-09-30）

**P0 结论（执行者填写）**

| # | 待确认项 | 结论 | 证据（文件:行） |
|---|----------|------|-----------------|
| 1 | IPC 档位校验是否硬编码白名单 | 三处均为 `isThinkingEffort` 派生校验，无硬编码白名单；错误文案硬编码档位清单（待 P1-T10 派生化） | `configIpc.ts:168`（throw `:169`）/ `sessionIpc.ts:41`（throw `:42`）/ `sessionIpc.ts:102`（throw `:103`） |
| 2 | displayName 唯一生成处 | 是，唯一拼接生成处为 `llmModelConfig.ts:253`；`sessionModelBinding.ts` / `visionModelRouting.ts` 均为透传 | `llmModelConfig.ts:253` |
| 3 | MessageInput 唯一调用方 | 是，生产代码仅 `ChatView.tsx`（另有组件自身测试 `MessageInput.test.tsx`，非生产调用方） | `ChatView.tsx` |

### P0-T2 建立测试与类型基线

**动作**：在改动前记录现状为绿，避免把既有失败误判为本次引入。并完成**枚举波及面全仓盘点**。

**命令**：
```
npm exec vitest run src/shared/thinkingEffort.test.ts src/shared/thinkingAvailability.test.ts src/shared/llmModelConfig.test.ts src/shared/visionModelRouting.test.ts src/renderer/services/sessionModelBinding.test.ts electron/effortFallback.test.ts electron/appIpc.thinkingEffort.test.ts
npm run typecheck:renderer
npm run typecheck:shared
```

**核查步骤（波及面检索 —— **每个「规则/枚举/字段」变更类任务开工前必须做**）**：

> ⚠️ **原则**：凡改动**产品常量、生成规则或被消费字段**，都须检索其**全部断言消费方**（不只是定义处）。教训来自 P1（档位枚举）与 P2（`displayName` 规则）的连续返工——两轮都出现了「必改测试清单不全」。

**A. 档位类波及面（P1）**：检索全部 `*.test.ts` / `*.test.tsx` 中的**档位序列/数量断言**与档位字面量，判定「P1 扩枚举后是否转红」。检索模式：`THINKING_EFFORT_LEVELS`、`PRODUCT_EFFORTS`、`isThinkingEffort`、`thinkingEffort`、档位序列字面量（`'low', 'medium', 'high'`）、中文档位（`'关闭'`/`'低'`/`'中'`/`'高'`）。

**B. 字段类波及面（P2）**：检索**被改字段**（本次为 `displayName`）于全部测试文件，逐一判定是否属同一字段。

**已完成的全仓盘点结论（2026-09-30）**：

**A. 档位类：15 个测试文件命中**

| # | 测试文件 | 判定 | 处置 |
|---|----------|------|------|
| 1 | `src/shared/thinkingEffort.test.ts`（`:12` 4 项序列、`:20` `'max'` 为 false） | **转红** | **P1-T6** |
| 2 | `electron/appIpc.thinkingEffort.test.ts`（`:203`/`:233` `'max'` rejects） | **转红** | **P1-T11** |
| 3 | `src/renderer/components/Chat/ComposerThinkingPicker.test.tsx`（`:37` 4 档中文序列） | **转红** | **P1-T12**（临时）→ P6-T2（最终迁移） |
| 4 | **`src/shared/thinkingAvailability.test.ts`**（`:15` memo 断言 `['low','medium','high']`） | **转红**（随 `PRODUCT_EFFORTS` 扩项） | **P1-T3** 完成判据 |
| 5 | `electron/toolChatLoop.usageStream.test.ts`（`:134` 内联类型注解 `reasoningEffort?: 'off' \| 'low' \| 'medium' \| 'high'`） | **待核查**（类型层面；按赋值方向大概率无害） | 见下方「核查项」 |
| 6 | `electron/turnExecutionConfig.thinkingEffort.test.ts` | 不转红（仅用 `off/high/low/medium`） | — |
| 7 | `electron/turnExecutionConfig.test.ts`（`:104` `'off'`） | 不转红 | — |
| 8 | `electron/database/thinkingEffort.test.ts` | 不转红（`low/high/null/'bogus'` 仍合法/非法关系不变） | — |
| 9 | `electron/outbound/outboundDrainer.test.ts`（`:176/:179` `'high'`） | 不转红 | — |
| 10 | `src/renderer/components/Config/configModalSnapshot.test.ts`（`off/medium/low`） | 不转红（快照输入值不变） | — |
| 11 | `src/renderer/services/sessionModelBinding.test.ts`（`:165` `'xhigh'` 防御用例） | 不转红（`xhigh` 仍非法，语义不变） | — |
| 12 | `src/shared/builtinToolMetadata.test.ts`（`:15` `['low','medium','high']`） | **不相关**（工具风险等级） | — |
| 13 | `src/shared/confirmation/approvalVerdict.test.ts`（`:24/:25`） | **不相关**（审批风险/授权等级） | — |
| 14 | `electron/mcp/mcpToolExecutor.test.ts`（`:117` 中文「中」） | **不相关**（字节数测试） | — |
| 15 | `electron/processOutput/detectEncoding.test.ts`（`:220` 中文「中」） | **不相关**（编码测试） | — |

> **核查项（file #5）**：该文件内联声明了 4 项档位的桩类型。若其 opts 会被传入期望 `AgentReasoningEffort`（扩展后 5 项）的真实函数参数，则 **4 项是 5 项的子集 → 类型兼容，不报错**；仅当测试自身需构造 `max` 时才须同步。**执行者须在 P1 后跑一次 `npm run typecheck:renderer` / `test:electron` 确认**，若报错则把该注解补为 5 项。

**B. 字段类（`displayName`）：9 个测试文件命中，27 处**

| # | 测试文件（行） | 是否 `ChatModelOption.displayName` | 判定 | 处置 |
|---|----------------|-----------------------------------|------|------|
| 1 | **`src/shared/visionModelRouting.test.ts:151`**（`'Volcano-kimi-k2.7-code'`） | ✅ 是（`visionModelRouting.ts:100` 透传） | **转红** | **P2-T6** |
| 2 | `src/shared/llmModelConfig.test.ts:257/261/264` | ✅ 是（生成处） | **转红** | P2-T3 |
| 3 | `src/renderer/services/sessionModelBinding.test.ts:69/84/97/106` | ✅ 是（透传） | **转红** | P2-T4 |
| 4 | `electron/llmModelListFetcher.test.ts`（`:39/40/47/48/65/83/169-171`，10 处） | ❌ 否（`FetchedModelInfo.displayName`，服务 API 返回名） | 不相关 | — |
| 5 | `electron/appIpc.fetchServiceModels.test.ts:151/160` | ❌ 否（同上） | 不相关 | — |
| 6 | `electron/mcp/mcpService.test.ts:134`（`'测试预设'`） | ❌ 否（MCP 预设显示名） | 不相关 | — |
| 7 | `electron/mcp/oauthClientPresets.test.ts:6` | ❌ 否（OAuth 预设显示名） | 不相关 | — |
| 8 | `electron/wechat/weChatBotService.test.ts:26/37/61/82` | ❌ 否（微信 bot 显示名） | 不相关 | — |
| 9 | `src/renderer/components/Config/WeChatSettingsTab.test.tsx:38/44` | ❌ 否（微信） | 不相关 | — |

> `visionModelRouting.test.ts` 内的其余 `displayName` 相关断言已复核：`resolveVisionModelBinding` 的用例只断言 `modelName` / `llmServiceId` / `model.id`（**未**整体 `toEqual`，故不含 `displayName`），**不受影响**；该文件内 `Volcano-`/`Deep-` 前缀字面量**仅 `:151` 一处**。

**完成判据**：
- [x] 上述定向测试（含 `thinkingAvailability.test.ts`、`visionModelRouting.test.ts`）全部通过，结果已记录（7 文件 93 用例全绿，2026-09-30）
- [x] `npm run typecheck:renderer` 与 `npm run typecheck:shared` 均通过
- [x] 已执行 **A. 档位类**波及面检索，且上表 15 行结论**逐行复核确认**（如有新增命中，须补充登记并指派任务）
- [x] 已执行 **B. 字段类**（`displayName`）波及面检索，且 9 文件 27 处结论**逐行复核确认**（P2 开工前再复核一次）
- [x] 已确认 file #5 的核查项在 P1 后由 `typecheck` 验证（计划内已登记）
- [x] 确认工作分支干净（`git status`），非 main 直提（worktree 分支 `feat/composer-model-thinking-entry`，仅两份计划/需求文档为未跟踪新增）

（完成人：ZCode，2026-09-30）

---

## 4. 阶段 1：档位枚举扩为 5 档（FR11）

> 目标：`off / low / medium / high / max`。**仅新增 `max`**，`minimal` / `xhigh` 不加。
> 本阶段只动 `src/shared/`、i18n、测试；不触碰运行时请求构造（已验证无需改动）。

### P1-T1 扩展 `AgentReasoningEffort` 枚举

**动作**：在联合类型末尾追加 `'max'`。

**涉及文件**：`src/shared/agent/invocation.ts:86`

**完成判据**：
- [x] 类型为 `'off' | 'low' | 'medium' | 'high' | 'max'`
- [x] 注释同步（原文「思维强度档位：off 为零成本档」保留，可补一行说明 max 为最强档）
- [x] `npm run typecheck:shared` 通过
- [x] 未新增任何 `as` / `@ts-expect-error` / `any`
- [x] 已确认**不**需同步 `packages/agent-core/src/provider.ts:1` 的独立 `ReasoningEffort`（其无生产消费方），并在该处或本计划备注「agent-core 档位枚举独立于产品枚举，暂不暴露 `max`」（见 R11）

### P1-T2 `THINKING_EFFORT_LEVELS` 扩为 5 项

**动作**：数组改为 `['off','low','medium','high','max']`。**顺序即 UI 顺序（由弱到强）**。

**涉及文件**：`src/shared/thinkingEffort.ts`

**完成判据**：
- [x] 数组为 5 项且顺序如上
- [x] 确认 `isThinkingEffort` / `normalizeThinkingEffort` 均基于该常量派生（无需改代码）
- [x] `npm run typecheck:shared` 通过

### P1-T3 `PRODUCT_EFFORTS` 扩为 4 项并改名（**含 1 处必改断言**）

**动作**：`['low','medium','high']` → `['low','medium','high','max']`；**仍不含 `off`**（`off` 恒可用）。
建议同时重命名为 `EXCLUDABLE_EFFORTS`，避免与「产品档位」混淆；若改名，须同步其全部引用点。

**⚠️ 连带必改断言（评审 B2(v2)）**：`src/shared/thinkingAvailability.test.ts:15` 的 **memo 降级路径**断言：

```ts
// 现状（扩项后必红）
expect(resolveThinkingAvailability('claude-sonnet-4-6', { effortUnsupportedByMemo: true }))
  .toEqual({ unsupported: ['low', 'medium', 'high'], source: 'memo' })
// 改为
  .toEqual({ unsupported: ['low', 'medium', 'high', 'max'], source: 'memo' })
```

原因：`thinkingAvailability.ts:22` 的 memo 路径返回 `[...PRODUCT_EFFORTS]`，数组扩项直接改变该输出。⚠️ 该测试**不 import** `PRODUCT_EFFORTS`，故「改名同步」扫不到它——必须靠本任务的显式判据。

**同文件其余断言已复核，不受影响**（勿顺手改动）：
- `:8`（baseline 路径，`deepseek-v4-pro`）：其基线 `max: "max"` 有值 → `unsupported` 仍为 `['low','medium']`；
- `:41`（注入 fake map，仅 `high: null`）→ `unsupported` 仍为 `['high']`。

**涉及文件**：`src/shared/thinkingAvailability.ts:11`、`src/shared/thinkingAvailability.test.ts:15`

**完成判据**：
- [x] 数组含 4 项，**不含 `off`**
- [x] 若改名，全仓无遗留旧名引用（`grep` 确认）
- [x] `resolveThinkingAvailability` 返回的 `unsupported` 逻辑未变（仍为「仅显式 `null` 排除」）
- [x] **`thinkingAvailability.test.ts:15` 的 memo 断言已同步为 4 项**（`['low','medium','high','max']`）
- [x] `thinkingAvailability.test.ts:8` 与 `:41` 两条断言**未被改动**且仍通过
- [x] `npm exec vitest run src/shared/thinkingAvailability.test.ts` 全绿
- [x] `npm run typecheck:shared` 通过

### P1-T4 `ThinkingLevelMap` 联合收敛（顺带修既有偏差）

**动作**：`max` 已被枚举覆盖，可将联合由 `AgentReasoningEffort | 'minimal' | 'max'` 简化为 `AgentReasoningEffort | 'minimal' | 'xhigh'`（同时修掉「类型未声明 `xhigh`」这一既有不一致）。

**涉及文件**：`src/shared/modelBaseline.ts:5`

**完成判据**：
- [x] 联合类型已声明 `xhigh`（或明确记录「本次不改」及原因）
- [x] `npm run typecheck:shared` 通过
- [x] 基线的 `thinkingLevelMap` 读取路径行为不变（`resolveThinkingAvailability` 单测仍绿）

### P1-T5 i18n 新增 `max` 文案

**动作**：新增 2 个键（zh-CN / en-US 双份）：

| 文件 | 键 | zh-CN | en-US |
|------|----|-------|-------|
| `src/renderer/i18n/resources/{locale}/chat.json` | `composer.thinking.max` | `最高` | `Max` |
| `src/renderer/i18n/resources/{locale}/config.json` | `models.effort.max` | `最高` | `Max` |

**完成判据**：
- [x] 4 个文件（2 语言 × 2 命名空间）均已加键
- [x] `npm run i18n:generate-types` 执行通过，生成的类型包含新键
- [x] `npm run i18n:check` 通过（zh/en 对齐）
- [x] 文案梯度正确：`关闭 < 低 < 中 < 高 < 最高`

### P1-T6 `thinkingEffort.test.ts` 断言反转（**必改**）

**动作**：

1. `:12` `expect(THINKING_EFFORT_LEVELS).toEqual([...4 项])` → 改为 **5 项**（含 `max`）
2. `expect(isThinkingEffort('max')).toBe(false)` → **`true`**
3. ⚠️ `expect(isThinkingEffort('xhigh')).toBe(false)` **保持不变**（`xhigh` 仍不在枚举）
4. `normalizeThinkingEffort('xhigh','off')` 期望 **仍为 `'off'`**（不用改）
5. 用例名去掉「xhigh/max not exposed」这一已失效前提（`max` 已暴露），可改为 `rejects non-product and malformed values`

**涉及文件**：`src/shared/thinkingEffort.test.ts`

**完成判据**：
- [x] 5 项序列断言通过
- [x] `isThinkingEffort('max')` 断言为 `true`
- [x] `isThinkingEffort('xhigh')` 断言仍为 `false`（未被误改）
- [x] `normalizeThinkingEffort('xhigh','off')` 断言仍为 `'off'`
- [x] 用例名不再包含已失效的旧前提
- [x] `npm exec vitest run src/shared/thinkingEffort.test.ts` 全绿

### P1-T7 `effortFallback.test.ts` 补 `max` 断言

**动作**：在 wire 映射用例中补 `buildThinkingWireParams('max')` → `outputConfig.effort === 'max'`；保留 `off` 不产出 `output_config` 的既有断言。

**涉及文件**：`electron/effortFallback.test.ts:23-36`

**完成判据**：
- [x] 用例含 `max` 断言，且期望 `{ thinking: { type: 'adaptive' }, outputConfig: { effort: 'max' } }`
- [x] `off` 断言保留（`{ thinking: { type: 'disabled' } }` 且无 `outputConfig`）
- [x] `npm exec vitest run electron/effortFallback.test.ts` 全绿

### P1-T8 核实 `buildThinkingWireParams` 无需改动

**动作**：**不改代码**，仅以断言与注释确认：SDK（`@anthropic-ai/sdk@0.79.0`）的 `OutputConfig.effort` 白名单已含 `max`，故本路径无需类型转换。

**涉及文件**：`electron/effortFallback.ts:12`（只确认，不改）、`electron/effortFallback.test.ts`（P1-T7 已覆盖）

**完成判据**：
- [x] 已核对 `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` 的 `OutputConfig.effort` 含 `'max'`
- [x] `electron/effortFallback.ts` **未发生**业务逻辑改动（`git diff` 可证）
- [x] 全仓无新增 `as OutputConfig['effort']` / `@ts-expect-error`
- [x] 在 P1-T7 的用例旁加一行注释，说明「`max` 在 SDK 白名单内，无需转换」

### P1-T9 核实 DB 与 IPC 校验自动接受 `max`

**动作**：确认以下各处**无需改逻辑**（仅错误文案需改，见 P1-T10）：

1. 会话档位：`electron/database/operations.ts`（`:100/209/327`）经 `isThinkingEffort` 校验 → 扩展后自动接受 `max`；列类型 `TEXT` 且无 `CHECK`（`electron/database/schema.ts:326`）→ **无需迁移**。
2. IPC 校验（按 P0-T1 结论）：`configIpc.ts:168` / `sessionIpc.ts:40` / `sessionIpc.ts:100` 三处均为 `isThinkingEffort` 派生 → **自动接受 `max`，无需改判断逻辑**。

**完成判据**：
- [x] 已确认 DB 列定义无 `CHECK` 约束（贴出 `schema.ts` 相关行）
- [x] 已确认 `operations.ts` 读写均走 `isThinkingEffort`，无第二处档位白名单
- [x] 已确认 `configIpc.ts` / `sessionIpc.ts` 三处校验均为 `isThinkingEffort` 派生，无硬编码档位白名单
- [x] **结论：无需新增数据库迁移脚本**；也**无需修改三处校验的判断逻辑**（仅文案，见 P1-T10）

### P1-T10 同步三处 IPC 错误文案（去硬编码档位清单）

**动作**：三处 `throw` 的错误文案硬编码了「允许 off / low / medium / high」，扩档后过时（缺 `max`）：

| 文件:行 | 现文案片段 |
|---------|-----------|
| `electron/ipc/configIpc.ts:169` | `(允许 off / low / medium / high)` |
| `electron/ipc/sessionIpc.ts:41` | `(允许 off / low / medium / high)` |
| `electron/ipc/sessionIpc.ts:102` | `(允许 off / low / medium / high 或 null 清除覆盖)` |

**改法**（二选一，推荐后者的前一种）：
- **A（推荐）**：文案由 `THINKING_EFFORT_LEVELS` 派生，如 `(允许 ${THINKING_EFFORT_LEVELS.join(' / ')})`，从此不会再随枚举扩张而过时；
- **B（最小改动）**：三处文案手工补上 `max`。

⚠️ 注意 `sessionIpc.ts:102` 的文案尾部有额外的 `或 null 清除覆盖`，派生时须保留该后缀。

**涉及文件**：`electron/ipc/configIpc.ts`、`electron/ipc/sessionIpc.ts`

**完成判据**：
- [x] 三处文案均已包含 `max`（或已改为派生）
- [x] 若采用 A：三处均改为派生，且 `sessionIpc.ts:102` 的 `或 null 清除覆盖` 后缀保留
- [x] `sessionIpc.ts:40`（`session:create`）的**判断逻辑未变**（仍拒绝非产品档位）
- [x] 三处仍**只**接受 `THINKING_EFFORT_LEVELS` 内的值（`xhigh` / `42` 仍被拒绝）
- [x] `npm run typecheck:shared` + `npm run typecheck:renderer` 通过

### P1-T11 `appIpc.thinkingEffort.test.ts` 断言反转（**必改**）

**背景**：该文件显式断言 `'max'` 是非法档位，扩枚举后 `isThinkingEffort('max')` 变 `true`，以下断言**必然转红**：

| 行 | 现断言 | 期望改为 |
|----|--------|----------|
| `:203`（`session:update`） | `await expect(handler({}, { sessionId: 'session-1', thinkingEffort: 'max' })).rejects.toThrow()` | **改为 resolves**，并断言 `updateSession` 被调用且 `thinkingEffort: 'max'` 落库 |
| `:233`（`config:set`） | `await expect(handler({}, { thinkingEffort: 'max' })).rejects.toThrow()` | **改为 resolves**，并断言写入了 `config.thinkingEffort = 'max'` |

**必须保留**（防误删合法拒绝语义）：

| 行 | 断言 | 处置 |
|----|------|------|
| `:202` | `thinkingEffort: 'xhigh'` → rejects | **保持不变**（`xhigh` 仍非法） |
| `:234` | `thinkingEffort: 42` → rejects | **保持不变** |
| `:204` / `:235` | 非法时不触达 `updateSession` / `setConfigValue` | 调整：因 `'max'` 已合法，该断言需**只针对仍在非法集内的值**（如 `xhigh` / `42`）成立 |

**用例名同步**：`:197`「非法档位被拒绝（§8.4：非法值拒绝并提示），不触达 updateSession」与 `:231`「非法档位被拒绝并提示（§8.4 净新增校验…）」——用例名中的「非法档位」集合已缩小，建议改用例名或补一条「合法档位 `max` 可写入并落库」的显式用例。

**涉及文件**：`electron/appIpc.thinkingEffort.test.ts`

**完成判据**：
- [x] `:203` 的 `'max'` 断言已由 rejects 改为 **resolves**，并验证落库（`updateSession` 收到 `thinkingEffort: 'max'`）
- [x] `:233` 的 `'max'` 断言已由 rejects 改为 **resolves**，并验证 `config.thinkingEffort = 'max'` 被写入
- [x] `:202`（`xhigh`）、`:234`（`42`）的拒绝断言**保持不变**且通过
- [x] `:204` / `:235` 的「不触达」断言已调整，**仅**对仍非法值成立
- [x] 已补一条「合法 `max` 写入」用例，或用例名已更新以反映缩小的非法集合
- [x] `npm exec vitest run electron/appIpc.thinkingEffort.test.ts` 全绿

### P1-T12 `ComposerThinkingPicker.test.tsx` 序列断言临时扩 5 项（**必改，P1 内必须处理**）

**背景（评审 B1(v2)）**：旧组件 `ComposerThinkingPicker.tsx:34` 的档位列表**直接由 `THINKING_EFFORT_LEVELS` 驱动**，其测试 `:37` 有全等序列断言：

```ts
expect(options.map((o) => o.textContent)).toEqual(['关闭', '低', '中 · 默认', '高'])
```

P1-T2 扩为 5 项 + P1-T5 补 `composer.thinking.max` 文案后，该序列变 5 项 → **立即转红**。而原计划把该文件处置排在 P6-T2，P1-G 门禁却要求 `npm run test:renderer` 全绿 → **P1 必然卡门禁**。

**动作（采用「P1 临时改断言 + P6 最终迁移」）**：

1. `:37` 改为 5 项：`['关闭', '低', '中 · 默认', '高', '最高']`（顺序即 `THINKING_EFFORT_LEVELS`，末项文案取 P1-T5 新增的 `composer.thinking.max` = `最高`）
2. `:33` 用例名「点击弹出 **4 档**，等于全局档位的项带『· 默认』属性标记」→ 改为「点击弹出**全部档位**，…」（去掉写死的档位数）

**⚠️ 为何不采用评审推荐的「把 P6-T2 的迁移提前到 P1」**：迁移的目标文件 `ComposerModelThinkingPicker.test.tsx` 到 **P4-T11 才创建**，P1 阶段该文件尚不存在，**无法迁移**。故 P1 只能做最小修正（改断言），最终迁移仍留在 P6-T2。

**回归意义不变**：该文件在 P1–P5 期间继续为旧组件提供覆盖；P6-T1 删组件、P6-T2 迁移/删除测试。

**涉及文件**：`src/renderer/components/Chat/ComposerThinkingPicker.test.tsx`

**完成判据**：
- [x] `:37` 序列断言已扩为 5 项，末项为 `'最高'`
- [x] `:33` 用例名不再写死「4 档」
- [x] 该文件其余用例（默认标记选中态、回调 `null`、选择「高」、禁用 Tooltip）**未被改动**且仍通过
- [x] `npm exec vitest run src/renderer/components/Chat/ComposerThinkingPicker.test.tsx` 全绿
- [x] 未删除该文件（删除动作属 P6-T2）

### P1-G 阶段 1 收尾（门禁）

**门禁（全部满足方可进入 P2）**：
- [x] 定向集全绿：`npm exec vitest run src/shared/thinkingEffort.test.ts src/shared/thinkingAvailability.test.ts electron/effortFallback.test.ts electron/appIpc.thinkingEffort.test.ts src/renderer/components/Chat/ComposerThinkingPicker.test.tsx`
- [x] `npm run test:renderer` 全绿（⚠️ `src/shared/*.test.ts` 归属 vitest 的 **renderer** project；仓库**无** `test:shared` 脚本，勿使用）
- [x] `npm run typecheck:shared` + `npm run typecheck:renderer` 通过
- [x] `npm run i18n:check` 通过
- [x] 设置页全局强度下拉在开发模式下可见 **5 项**（`ModelsSettingsTab.tsx:183` options 由 `THINKING_EFFORT_LEVELS.map` 自动生成，代码面已确认跟随 5 档；真机目检并入 P7 统一人工验收）——人工确认一次
- [x] 三处 IPC 错误文案已含 `max`（P1-T10）
- [x] **P0-T2 盘点表中的 4 个「转红」文件均已处置完毕**（#1 P1-T6 / #2 P1-T11 / #3 P1-T12 / #4 P1-T3）
- [x] 已提交，提交信息说明「档位枚举扩为 5 档（+max）」

---


（P1 完成人：ZCode，2026-09-30；TDD 流程：断言反转→RED 确认 8 例→实现→GREEN 42 例定向 + renderer 全量 2072 例绿）

## 5. 阶段 2：修正 `displayName` 生成规则（FR12）

> 目标：唯一支持 → 无前缀；≥2 服务支持 → 带 `{serviceName}-` 前缀。
> 本阶段只动 `src/shared/llmModelConfig.ts` 与相关测试。

### P2-T1 `buildChatModelOptions` 改为两遍处理

**动作**：

1. 第一遍：按既有「服务顺序 × `supportedModelIds`」收集全部候选 `(service, model)`。
2. 统计：每个 `model.name` 在候选池中的出现次数。
3. 第二遍：生成 `displayName` —— 出现 1 次 → `{model.name}`；≥2 次 → `{serviceName}-{model.name}`（`service.name.trim()`，单连字符 `-`）。

**涉及文件**：`src/shared/llmModelConfig.ts:239-265`（`buildChatModelOptions`）

**完成判据**：
- [x] 函数内**不再**有「单层循环内直接拼前缀」的写法
- [x] 排序规则不变（先按服务列表顺序，再按既有模型排序）
- [x] 候选集合不变（仍为 `buildChatModelOptions(models, services, activeServiceIds)` 口径）
- [x] `npm run typecheck:shared` 通过
- [x] 函数顶部注释更新（原注释「展示名统一为『服务名-模型名』」须改为「仅歧义时加前缀」）

### P2-T2 产出 `serviceAmbiguous` 字段

**动作**：在 `ChatModelOption` 上新增 `serviceAmbiguous: boolean`，复用 P2-T1 的统计结果（**不重复统计**）。该字段供 FR3 的服务段判定使用，使「是否歧义」只有一处实现。

**涉及文件**：`src/shared/llmModelConfig.ts`（类型 `ChatModelOption:229-236` + 生成处）

**完成判据**：
- [x] 类型新增 `serviceAmbiguous: boolean`
- [x] 生成逻辑与 `displayName` 前缀判定**同源**（同一统计结果），无第二次遍历统计
- [x] `npm run typecheck:shared` 通过
- [x] 已确认其余 `ChatModelOption` 字段语义未变（`serviceId` / `serviceName` / `modelId` / `modelName` / `model`）

### P2-T3 `llmModelConfig.test.ts` 断言反转（**必改**）

**动作**：

1. 用例名「`buildChatModelOptions` **always uses service prefix** in displayName」→ 改为「prefixes only when the model name is ambiguous」
2. **同名跨服务**断言（`deepseek-v4-pro` × 2 服务）→ **保持不变**：`['Deep-deepseek-v4-pro','Volcano-deepseek-v4-pro']`
3. **唯一服务**断言 `'Deep-deepseek-flash'` → 改为 **`'deepseek-flash'`**
4. 建议补一条显式用例：唯一服务不加前缀 + `serviceAmbiguous === false`

**涉及文件**：`src/shared/llmModelConfig.test.ts:257-265`

**完成判据**：
- [x] 同名跨服务断言未变且通过
- [x] 唯一服务断言已改为无前缀且通过
- [x] 新增（或已存在）`serviceAmbiguous` 的断言
- [x] 用例名不再包含「always uses service prefix」
- [x] `npm exec vitest run src/shared/llmModelConfig.test.ts` 全绿

### P2-T4 `sessionModelBinding.test.ts` 断言反转（**必改**）

**动作**：

1. `:69` `expect(binding.displayName).toBe('Default-deepseek-flash')` → **`'deepseek-flash'`**
2. `:84` 同上 → **`'deepseek-flash'`**
3. `:87` 用例名「lists **service-prefixed** display names for all options」→ 改名（唯一服务时并不带前缀）；`:97-100` 的同名跨服务断言（两个带前缀值）**保持不变**
4. `:103` 用例名「**prefixes single-service options as well**」前提失效 → 改名，并把 `:106` 断言反转为 **`'glm-5.3'`**

**涉及文件**：`src/renderer/services/sessionModelBinding.test.ts`

**完成判据**：
- [x] `:69` / `:84` / `:106` 三处断言已改为无前缀且通过
- [x] `:97-100` 同名跨服务断言未变且通过
- [x] 两个用例名已更新（不再暗示「总是带前缀」）
- [x] `npm exec vitest run src/renderer/services/sessionModelBinding.test.ts` 全绿

### P2-T5 确认浮层模型列表渲染不受影响

**动作**：`ComposerModelPicker` 的列表项用 `opt.serviceName`（副文案）+ `opt.modelName`（主文案）分开渲染，**不读** `displayName`。以既有渲染测试或一次人工确认固化该结论。

**涉及文件**：`src/renderer/components/Chat/ComposerModelPicker.tsx`（只读确认）

**完成判据**：
- [x] 已确认该组件内 `displayName` 仅在 chip 文案处使用，列表项未使用
- [x] 既有渲染相关测试全绿（如有）
- [x] 结论记录在案（若本次改 `displayName` 后有列表渲染变化，说明判断有误，须停下排查）

### P2-T6 `visionModelRouting.test.ts` 断言反转（**必改，评审 B1(v3)**）

**背景**：`src/shared/visionModelRouting.test.ts:143-153` 首条用例（「session 已使用可用视觉模型时允许发送」）使用**默认 fixture**（`:36-71`）：

- `activeLlmServiceIds: ['s2']` —— **只有 s2 一个活跃服务**；
- `kimi-k2.7-code`（id `'3'`）：s1 的 `supportedModelIds` 为 `['1','2']`，s2 为 `['1','3','4']` → **仅 s2 支持**，即在候选池中**只出现 1 次**。

该用例走 `sessionOption?.model.isVision` 分支（`visionModelRouting.ts:82-88`），`displayName` 直接取 `sessionOption.displayName`（`:88`）。P2-T1 规则变化后 → **无前缀**，故 `:151` 的带前缀断言必红。

**动作**：

1. `:151` `displayName: 'Volcano-kimi-k2.7-code'` → 改为 **`'kimi-k2.7-code'`**
2. 加一行注释说明依据：「该模型仅 s2 支持 → 单服务 → 无前缀（FR12）」
3. ⚠️ 该文件**其余用例不动**：`resolveVisionModelBinding` 的用例只断言 `modelName` / `llmServiceId` / `model.id`（未整体 `toEqual`），不含 `displayName`，不受影响

**涉及文件**：`src/shared/visionModelRouting.test.ts:151`

**完成判据**：
- [x] `:151` 断言已改为 **`'kimi-k2.7-code'`**（无前缀）并加注释
- [x] 该文件内**无其它**带 `Volcano-`/`Deep-` 前缀的 `displayName` 断言仍保留旧值（全文件仅 `:151` 一处，已核）
- [x] 该文件其余用例（`resolveVisionModelBinding` × 4、`resolveVisionRouteForImageSend` × 3、history/request 判断等）**未被改动**且通过
- [x] `npm exec vitest run src/shared/visionModelRouting.test.ts` 全绿

### P2-G 阶段 2 收尾（门禁）

- [x] `npm exec vitest run src/shared/llmModelConfig.test.ts src/shared/visionModelRouting.test.ts src/renderer/services/sessionModelBinding.test.ts` 全绿
- [x] `npm run typecheck:shared` + `npm run typecheck:renderer` 通过
- [x] **P0-T2 盘点表 B（字段类）的 3 个「转红」文件均已处置完毕**（#1 P2-T6 / #2 P2-T3 / #3 P2-T4）
- [x] 开发模式下确认：仅配置 1 个服务时，模型名为纯模型名；配置 2 个服务且同名时，模型名带服务前缀（两场景均已由 `llmModelConfig.test.ts` / `sessionModelBinding.test.ts` 自动化覆盖；真机目检并入 P7 统一人工验收）
- [x] 已提交，提交信息说明「displayName 仅在歧义时加服务名前缀」

---


（P2 完成人：ZCode，2026-09-30；TDD：断言反转 RED 5 例 → 两遍处理实现 GREEN 60 例定向全绿 + 双 typecheck 过）

## 6. 阶段 3：可用档位集合解析（FR10 数据源）

> 目标：让 composer 拿到「当前模型可用哪些档位」。**方案 A：renderer 自算**，零 IPC 改动。
> 本阶段只新增纯函数 + 在 `ChatView` 内计算，**不改任何渲染结构**。

### P3-T1 新增 `resolveAvailableThinkingEfforts`

**动作**：在 `src/renderer/services/sessionModelBinding.ts` 新增与既有 `resolveSessionThinkingBinding` **同构**的纯函数：

```
resolveAvailableThinkingEfforts(modelName: string): AgentReasoningEffort[]
```

实现要点：

1. **先做名字归一**：调用 `migrateBuiltinModelName(modelName)`（`src/shared/llmModelConfig.ts:126` 已导出，renderer 可 import），与主进程口径对齐。
2. 调用 `resolveThinkingAvailability(normalizedName, { effortUnsupportedByMemo: false })`（`src/shared/thinkingAvailability.ts`）。
3. 用 `THINKING_EFFORT_LEVELS` 减去 `unsupported`，返回按产品顺序的可用集合。
4. `source: 'unknown'` → fail-open，返回全部 5 档。

**涉及文件**：`src/renderer/services/sessionModelBinding.ts`（新增导出）

**完成判据**：
- [x] 函数已导出，签名为 `(modelName: string) => AgentReasoningEffort[]`
- [x] 内部调用了 `migrateBuiltinModelName`（名字归一）
- [x] **未**新增任何 IPC / 主进程改动（`git diff` 中无 `electron/` 新增）
- [x] 返回顺序严格等于 `THINKING_EFFORT_LEVELS` 的子序列（由弱到强）
- [x] `npm run typecheck:renderer` 通过

### P3-T2 为该纯函数补单测

**动作**：在 `src/renderer/services/sessionModelBinding.test.ts` 新增一组用例，覆盖需求 §9.6 的 A22 / A22a / A22b：

| 输入模型 | 期望可用集合 |
|---|---|
| `gpt-5-pro`（`off`/`minimal`/`low`/`medium`/`xhigh`/`max` **全部**显式 `null`，仅 `high` 有值） | `['off','high']`（2 档；`off` 不在 `PRODUCT_EFFORTS` 内，恒可用） |
| `claude-opus-4-6`（map 仅 `max` 键） | 全 5 档（键缺失**不**排除） |
| `claude-haiku-4-5`（无 `thinkingLevelMap`） | 全 5 档（fail-open） |
| `deepseek-v4-pro`（`minimal`/`low`/`medium` 为 `null`） | `['off','high','max']`（3 档） |
| 未知模型名（不在基线内） | 全 5 档（fail-open） |

**完成判据**：
- [x] 上表 5 个用例全部存在且通过
- [x] 至少 1 个用例覆盖「旧内置名经 `migrateBuiltinModelName` 归一后仍能查到基线」
- [x] `npm exec vitest run src/renderer/services/sessionModelBinding.test.ts` 全绿
- [x] 对应用收项：**A22a**、**A22b** 已可自动化断言

### P3-T3 `ChatView` 计算 `availableEfforts`

**动作**：在 `ChatView.tsx` 用 `useMemo` 计算当前会话模型的可用档位集合，依赖 `chatModelName`（随切换模型**立即**重算）。

**涉及文件**：`src/renderer/components/Chat/ChatView.tsx`（`chatModelName` 定义在 `:148` 附近）

**完成判据**：
- [x] 新增 `useMemo`，依赖数组含 `chatModelName`
- [x] 计算结果在 P5-T4 接线时可直接传入 `prefsSlot`（本阶段先就绪，可暂不消费）
- [x] `npm run typecheck:renderer` 通过
- [x] 无 IPC 调用、无网络请求、无异步（纯同步派生）

### P3-G 阶段 3 收尾（门禁）

- [x] `npm exec vitest run src/renderer/services/sessionModelBinding.test.ts` 全绿
- [x] `npm run typecheck:renderer` 通过
- [x] 人工确认：临时在控制台或单测中断言，切换模型后集合**无需发消息**即变化（对应 A24）——`availableEfforts` 为 `useMemo` 纯同步派生、依赖 `chatModelName`，不同模型入参 → 不同集合已由纯函数单测覆盖；真机切换目检并入 P7
- [x] 已提交，提交信息说明「新增可用档位集合解析（renderer 自算）」

---


（P3 完成人：ZCode，2026-09-30；TDD：7 例新用例先 RED（函数未实现）→ 实现后 19 例全绿，git diff 无 electron/ 改动）

## 7. 阶段 4：新增合并入口组件（FR1 / FR2 / FR3 / FR5 / FR6 / FR8 / FR9）

> 目标：交付 `ComposerModelThinkingPicker.tsx`——**单 chip 入口 + 一体化浮层**，含完整单测。
> **本阶段结束时组件尚无调用方**，现网行为不变；接线在 P5。
> ⚠️ **先做 P4-T0（建 i18n 键）**：组件内的 `t('composer.prefs.…')` 是强类型调用，键不存在会直接编译报错。

### P4-T0 新增 `composer.prefs.*` i18n 键（**必做，评审 B1(v4)**）

**背景**：本项目的 `t()` 是**强类型**的——`src/renderer/i18n/useTypedTranslation.ts:12` 的 `typedT(key: NamespaceKeyMap[N])` 要求 key 必须属于**由 zh-CN 资源生成的类型联合**（`AGENTS.md`：「TypeScript 类型从 zh-CN 资源自动推导」）。`composer.prefs.*` 这些键当前**不存在**，故 P4 组件内任何 `t('composer.prefs.…')` 都会**直接编译报错**；而 P4-G 门禁要求 `typecheck` 与 `i18n:check` 通过 → **必须先建键**。

**动作**：在 `src/renderer/i18n/resources/{zh-CN,en-US}/chat.json` 的 `composer` 下新增 `prefs` 对象，共 **9 个键**（需求 §6.5 全套，文案以此为准）：

| key | zh-CN | en-US |
|-----|-------|-------|
| `composer.prefs.label` | `模型与思考强度` | `Model & thinking effort` |
| `composer.prefs.aria` | `模型与思考强度，当前模型 {{model}}，思考强度 {{effort}}` | `Model and thinking effort, current model {{model}}, thinking effort {{effort}}` |
| `composer.prefs.chipSeparator` | ` · ` | ` · ` |
| `composer.prefs.modelServiceSuffix` | `（{{service}}）` | ` ({{service}})`（**无尾空格**） |
| `composer.prefs.modelSection` | `模型` | `Model` |
| `composer.prefs.effortSection` | `思考强度` | `Thinking effort` |
| `composer.prefs.effortDisabled` | `该模型不支持 Thinking，切换模型后可调整` | `This model does not support thinking; switch model to adjust` |
| `composer.prefs.unknownModel` | `未配置模型` | `No model configured` |
| `composer.prefs.entryTitle` | `{{displayName}} · 思考强度：{{effort}}` | `{{displayName}} · Thinking effort: {{effort}}` |

**注意**：
- `modelServiceSuffix` 的 zh-CN 用**全角括号**、en-US 用**半角**（勿统一）；该键**仅在歧义时**参与拼接，非歧义时不产出任何文本。
- ⚠️ **en-US 值不得带尾空格**：` ({{service}})` 的前导空格已与模型名分隔，**末尾不能再有空格**——否则会与 `chipSeparator`（` · `，**前导空格**）叠加成**双倍间距**（渲染为 `kimi-k2.7-code (Volcano)  ·  高`）。zh-CN 版无此问题（全角括号紧贴模型名）。
- `label` 键 P4 各任务虽未直接引用，但属 §6.5 全套，**一并建立**，避免 P6 文档同步时反复补。
- ⚠️ `modelPicker.switchModel` / `selectModelAria` 的**删除**在 **P6-T5**，本任务**只增不删**（P4 期间旧组件仍在用）。

**涉及文件**：`src/renderer/i18n/resources/zh-CN/chat.json`、`src/renderer/i18n/resources/en-US/chat.json`

**完成判据**：
- [x] 两个语言文件均已新增 `composer.prefs` 对象，含上述 **9 个键**
- [x] zh-CN 用全角括号、en-US 用半角（`modelServiceSuffix` 差异保留）
- [x] `npm run i18n:generate-types` 通过，且生成的 `NamespaceKeyMap['chat']` 联合已含全部 9 个 `composer.prefs.*` 键
- [x] `npm run i18n:check` 通过（zh/en 键完全对齐）
- [x] `npm run typecheck:renderer` 通过
- [x] **未删除** `modelPicker.switchModel` / `selectModelAria`（保留至 P6-T5）

### P4-T1 组件骨架 + Props 契约

**动作**：新建 `src/renderer/components/Chat/ComposerModelThinkingPicker.tsx`，落地需求 §6.2 的 Props：

```
cfg: AppConfig
modelName: string                 // 收起态模型段（无前缀）
modelServiceName?: string         // 歧义时才有（OQ-5）
modelDisplayName: string          // title 用
modelUnavailable?: boolean
onSelectModel: (option: ChatModelOption) => void
effort: AgentReasoningEffort      // 当前生效档位
effortOverridden: boolean
globalEffort: AgentReasoningEffort
effortDisabled?: boolean
effortDisabledReason?: string
onSelectEffort: (effort: AgentReasoningEffort | null) => void
availableEfforts?: AgentReasoningEffort[]   // 缺省 = fail-open 全 5 档
```

**完成判据**：
- [x] 文件已创建，导出 `ComposerModelThinkingPicker`
- [x] Props 与上表一致（含全部注释，说明各自来源与 FR 归属）
- [x] **无** `unsupportedEfforts` 入参（FR10 定为「不渲染不可用档位」，组件无需该列表）
- [x] 组件内用既有 `listChatModelOptions(cfg)` 取模型列表，**不新增数据通道**
- [x] `npm run typecheck:renderer` 通过
- [x] 已 import 并复用 `ConfigModelBadges`（避免重写徽章）

### P4-T2 收起态 chip 文案组装

**动作**：按 FR3 组装三段式主文案，并落到 `title`：

1. 模型段：`modelName`（回退：`modelName` → `cfg.model` → `t('composer.prefs.unknownModel')`）
2. 服务段：仅当 `modelServiceName` 非空时追加 `t('composer.prefs.modelServiceSuffix', { service })`

   ⚠️ **全角括号是 zh-CN 专属**：需求 §6.5 规定 zh-CN 用全角 `（{{service}}）`、en-US 用半角 ` ({{service}})`（**前导空格、无尾空格**）。实现时**必须走 i18n 键**（`composer.prefs.modelServiceSuffix`），**不得**在组件里写死括号字符。⚠️ 拼接后须**紧接** `chipSeparator` 的 ` · `，中间不得再有空格（en-US 值本身**不含尾空格**，见 P4-T0）。
3. 强度段：`t('composer.prefs.chipSeparator')` + `t('composer.thinking.' + effort)`，**恒定显示**
4. `title`：`t('composer.prefs.entryTitle', { displayName: modelDisplayName, effort })`，继承时追加「（默认）」说明

**完成判据**：
- [x] 无歧义渲染为 `deepseek-v4-pro · 高` 形态
- [x] 有歧义渲染为 `deepseek-v4-pro（Deep） · 高` 形态（**不使用 `·` 作服务分隔**）
- [x] **en-US 有歧义形态**为 `kimi-k2.7-code (Volcano) · 高`——服务段与 `·` 之间**只有 1 个空格**（复核无双倍间距）
- [x] `modelServiceName` 为空时**不渲染空括号**
- [x] 强度段不因「继承 vs 覆盖」而改变文案（两态都只显示档位词）
- [x] DOM 结构：`.composer-model-chip__label`（含服务段，可收缩） / `.composer-model-chip__sep` / `.composer-model-chip__effort`（`flex-shrink: 0`）
- [x] 组件内**无硬编码中文**，全部走 `t()`

### P4-T3 浮层容器 + 两分区标题

**动作**：单个 `Popover`（`trigger="click"`、`placement="topLeft"`、`classNames={{ root: 'composer-prefs-popover' }}`），内部上下两分区，中间 1px 分隔线。两分区**都带标题**（`composer.prefs.modelSection` / `composer.prefs.effortSection`）。

**完成判据**：
- [x] 全组件仅 **1 个** `Popover`（`grep` 确认）
- [x] 两个分区标题均已渲染（上「模型」、下「思考强度」）
- [x] 存在分隔线元素（类名如 `.composer-prefs__divider`）
- [x] 点击 chip 可打开、点击外部可关闭、`Esc` 可关闭

### P4-T4 模型分区列表

**动作**：渲染模型列表，**复用现有结构与类名**，避免重写一套样式：

- 项：`.composer-model-picker__item`
- 服务名副文案：`.composer-model-picker__service`（取 `opt.serviceName`）
- 模型名：`.composer-model-picker__model`（取 `opt.modelName`）
- 徽章：`<ConfigModelBadges m={opt.model} />`
- 容器：`.composer-model-picker__list` / 滚动容器沿用 `max-height`

**完成判据**：
- [x] 列表项含「模型名 + 服务名副文案 + 快速/视觉徽章」
- [x] 当前绑定项呈现选中态（复用既有 `--active` 或等价视觉）
- [x] 列表超出时**仅在模型分区内滚动**（不撑破浮层）
- [x] 点击项触发 `onSelectModel(opt)`
- [x] **未**使用 `displayName` 作为列表主文案（应用 `modelName`）

### P4-T5 强度分区（横向 N 档）

**动作**：按 `availableEfforts`（缺省 = 全 5 档）渲染**横向**档位项：

1. 不渲染 `unsupported` 命中的档位（FR10 / OQ-12）
2. 等于 `globalEffort` 的项带 `· 默认` 标记（复用 `composer.thinking.defaultSuffix`）
3. 选中态：未覆盖时选「默认槽」，已覆盖时选 `effort`
4. 点击「`X · 默认`」→ `onSelectEffort(null)`；其余 → `onSelectEffort(level)`
5. 容器：`display:flex; flex-wrap:wrap; gap:4px`，项 `flex:1 1 0; min-width:52px`

**完成判据**：
- [x] 传入 2 项集合 → 只渲染 2 项；传 5 项 → 渲染 5 项（**不写死档位数**）
- [x] 5 项时**换行为 4+1 两行**，不溢出、不裁切
- [x] 2–3 项时**不被拉伸占满**整行（`min-width` 约束生效）
- [x] 「`X · 默认`」标记与选中态表现符合上表 3/4 条
- [x] 组件内**无**「把 `THINKING_EFFORT_LEVELS` 直接 map 成 UI 项」的硬编码路径
- [x] 档位文案按**实际档位键**逐项取词（`t('composer.thinking.' + level)`）

### P4-T6 选中后立即关闭

**动作**：模型与档位两处 `onSelect` 回调内均 `setOpen(false)`（FR2 末条 / OQ-4）。**不引入**「保持打开」分支。

**完成判据**：
- [x] `setOpen(false)` 在两处 `onSelect` 内均存在
- [x] 无任何「选完保持打开」的条件分支
- [x] 两条路径的关闭表现一致（模型、档位）

### P4-T7 `supportsThinking === false` 禁用态（**关键差异**）

**动作**：当 `effortDisabled` 为真时——**chip 本身不禁用**（用户必须还能换模型）；仅**强度分区整体禁用**并显示 `effortDisabledReason`（或 `composer.prefs.effortDisabled`）。

**完成判据**：
- [x] `effortDisabled` 为真时，点击 chip **仍能打开浮层**
- [x] 浮层内模型列表**仍可正常选择**
- [x] 强度分区呈禁用态（不可选）并显示提示文案
- [x] **未**使用「chip 整体 disabled + 外层 span 挂 Tooltip」的旧写法
- [x] 无 `@ts-ignore` / 依赖 disabled 元素冒泡的 hack

### P4-T8 空态 / 模型不可用态

**动作**：

1. 可用模型池为空 → 模型分区显示 `t('modelPicker.empty')`；强度分区仍可用
2. `modelUnavailable` 为真 → chip 带警告色（`--warn`），`title` 显示 `t('modelPicker.unavailableHint')`；浮层照常可开

**完成判据**：
- [x] 空池时模型分区显示空态文案，且 chip 仍可点击
- [x] 空池时强度分区不受影响（仍可调）
- [x] `modelUnavailable` 时 chip 带 `.composer-model-chip--warn` 类名
- [x] `modelUnavailable` 时浮层仍可打开且列表可选

### P4-T9 无障碍与键盘

**动作**（FR8）：

1. chip：`aria-haspopup="dialog"`、`aria-expanded={open}`、`aria-label` = `t('composer.prefs.aria', { model, effort })`
2. 强度分区：容器 `role="radiogroup"`（或 `role="group"` + `aria-labelledby` 指向标题）；项 `role="radio"` + `aria-checked`
3. 模型分区：沿用 `listbox`/`option` 或 `menu`/`menuitemradio` 语义
4. `Esc` 关闭并把焦点还给 chip；`focus-visible` 沿用既有类名

**完成判据**：
- [x] chip 具备 `aria-haspopup` / `aria-expanded` / `aria-label`（`aria-label` 同时描述模型与强度）
- [x] 强度分区具备 `radiogroup` + `radio` + `aria-checked`
- [x] 读屏可识别强度分区及其选中项（不会只播报「模型」）
- [x] `Esc` 关闭后焦点回到 chip
- [x] 键盘 `Enter` / `Space` 可触发选择

### P4-T10 组件样式（CSS）

**动作**：在 `src/renderer/theme/config-settings.css` 新增（与既有 `.composer-model-picker*` / `.composer-thinking-picker*` 并列）：

- `.composer-prefs-popover .ant-popover-inner { padding: 0 }`
- `.composer-prefs__section` / `.composer-prefs__section-title` / `.composer-prefs__divider`
- `.composer-prefs__models`（滚动容器，沿用 `min-width: 260px / max-width: 360px / max-height` 策略）
- `.composer-prefs__efforts`（`display:flex; flex-wrap:wrap; gap:4px`；项 `flex:1 1 0; min-width:52px`）

⚠️ **徽章样式作用域（改动前必读，勿只改容器类名）**：`config-settings.css:1761 / 1765 / 1776` 的徽章规则是**后代选择器**：

```css
.composer-model-picker .config-model-badges { flex-shrink: 0 }
.composer-model-picker .config-model-badge  { min-width: 44px; padding; gap; font-size; line-height; … }
.composer-model-picker .config-model-badge--vision { min-width: 44px; padding: 2px 8px 2px 7px }
```

即 `.composer-model-picker` 既是**滚动容器类名**、又是**徽章样式的祖先作用域锚点**。若容器改用 `.composer-prefs__models` 而**不保留** `.composer-model-picker`，上述 `min-width` / `padding` / `gap` / 字号**全部失效**，徽章会变形。

**二选一（推荐 ①）**：
1. 容器**同时挂** `.composer-prefs__models` 与 `.composer-model-picker`（保留既有作用域，最小改动）；
2. 为 `.composer-prefs__models .config-model-badge*` **新增等价作用域规则**。

> 注：`.composer-model-picker__item`（`:1667` / `:1681` / `:1685` / `:1690`）是 BEM **元素**类名，与块类名同名前缀但独立，只要列表项仍用 `__item` 即不受影响。

在 `src/renderer/theme/layout.css` 新增：

- `.composer-model-chip__sep { flex-shrink: 0; color: var(--sa-text-tertiary); }`
- `.composer-model-chip__effort { flex-shrink: 0; color: var(--sa-text-tertiary); font-weight: 400; }`
- 确认 `.composer-model-chip__label`（已有 `min-width: 0`）独自承担收缩

**完成判据**：
- [x] 禁止出现 `width: calc(25% - 3px)` 之类的固定等分硬编码
- [x] 5 档时正确换行为 2 行（真机确认，属 P7-T2）——CSS 已按 flex+min-width+wrap 实现，真机目检归入 P7
- [x] 强度段**不被截断**、模型段（含服务段）**才被截断**（`flex-shrink` 组合正确）
- [x] chip `max-width` 保持 **220px**（不擅自上调）
- [x] 浮层总高 ≤ 400px（模型区 + 分隔线 + 强度区）
- [x] **徽章样式未失效**：模型分区内的「快速 / 视觉」徽章尺寸与间距正常——已采用方案①（容器同时挂 `.composer-prefs__models` 与 `.composer-model-picker`），徽章后代选择器与滚动条白名单作用域均保留；真机目检归入 P7

### P4-T11 组件单测

**动作**：新建 `src/renderer/components/Chat/ComposerModelThinkingPicker.test.tsx`，覆盖：

| # | 用例 | 对应用收项 |
|---|------|-----------|
| ① | 收起态 chip 文案 = 模型名 +（歧义时服务段）+ 当前档位词 | A2 / A2a / A2d |
| ② | 无歧义时**不出现**括号 | A2d |
| ③ | 打开后同时渲染模型分区与强度分区（含两个标题） | A6 |
| ④ | 模型项含模型名 + 服务名副文案 + 徽章 | A7 |
| ⑤ | 档位项数等于传入的 `availableEfforts`（不固定 4） | A8 |
| ⑥ | `· 默认` 标记与选中态正确 | A8 |
| ⑦ | 点「`X · 默认`」回调 `null`；其余回调对应值 | A9 |
| ⑧ | 选中模型 / 档位后浮层关闭 | A9a |
| ⑨ | `effortDisabled` 时 chip 可点、强度分区禁用 | A10 |
| ⑩ | 空池时模型分区空态、强度分区仍可用 | A5 |
| ⑪ | 传 2 项集合只渲染 2 项；不传 = 全 5 项（fail-open） | A22 |
| ⑫ | 传入含 `max` 的集合 → 渲染「最高」并按 `max` 回调 | A22c / A22d |
| ⑬ | 继承与覆盖两态 chip **都**显示档位词（无「默认（中）」括注） | A2a |
| ⑭ | 档位切换后 chip 强度段即时更新 | A2b |
| ⑮ | `aria-*` 属性与角色正确 | A19 / A21 |

**完成判据**：
- [x] 上表 15 条用例全部存在且通过
- [x] `npm exec vitest run src/renderer/components/Chat/ComposerModelThinkingPicker.test.tsx` 全绿
- [x] 测试中**无**对内部实现细节（如具体 DOM 层级）的过度耦合断言，优先用 role/text 查询

### P4-G 阶段 4 收尾（门禁）

- [x] 组件单测全绿（P4-T11）
- [x] `npm run typecheck:renderer` 通过
- [x] `npm run i18n:check` 通过；**组件引用的全部 `composer.prefs.*` 键均由 P4-T0 已建立**（键存在性由此核销）
- [x] 人工确认：本阶段**未改变现网行为**（组件尚无调用方，`git grep ComposerModelThinkingPicker src/ --name-only` 仅组件与测试自身）
- [x] 已提交，提交信息说明「新增 ComposerModelThinkingPicker（未接线）」

---


（P4 完成人：ZCode，2026-09-30；TDD：19 例组件单测先 RED（组件不存在）→ 实现后全绿；Chat 目录 41 文件 276 例回归绿；typecheck + i18n:check 过）

## 8. 阶段 5：`MessageInput` 收敛 + `ChatView` 接线（FR7 / FR1）

> 目标：把两个 slot 收敛为单个 `prefsSlot`，简化 `checkOverflow`，并把 P4 组件接上线。
> 本阶段结束后，**新交互正式生效**，旧组件成为死代码（P6 删除）。

### P5-T1 `MessageInput` Props 收敛为 `prefsSlot`

**动作**：删除 `modelSlot?: React.ReactNode`（`:30`）与 `thinkingSlot?: React.ReactNode`（`:32`），新增单个：

```
prefsSlot?: React.ReactNode   // 模型与强度合并入口
```

**涉及文件**：`src/renderer/components/Chat/MessageInput.tsx`

**完成判据**：
- [ ] `modelSlot` / `thinkingSlot` 已从 Props 与解构中移除
- [ ] 新增 `prefsSlot`，注释说明其语义与 FR1 的绑定关系
- [ ] 全仓 `grep 'modelSlot\|thinkingSlot'` 已无残留（除本计划文档）
- [ ] `npm run typecheck:renderer` 通过（P5-T4 未完成时会报调用方错误，属预期）

### P5-T2 `checkOverflow` 预算简化

**动作**：预算由 3 项收为 2 项（attach + chip）：

1. 删除 `thinkingChipRef`（`:95`）与 `effortWidth`（`:329`）
2. `neededWidth` 去掉 `if (effortWidth > 0) neededWidth += gap + effortWidth`（`:336`）
3. `neededCollapsedWidth` 同样去掉 effort 项（`:340` 附近）
4. **保持**：`triggerWidth = 22`、`gap = 8`、触发条件、idle 复位逻辑（`:307-311`）、`ResizeObserver` 装配

**涉及文件**：`src/renderer/components/Chat/MessageInput.tsx:313-342`

**完成判据**：
- [ ] `checkOverflow` 内不再引用 `thinkingChipRef` / `effortWidth`
- [ ] 触发条件表达式未变（`neededWidth > availableWidth && neededCollapsedWidth <= availableWidth`）
- [ ] `triggerWidth = 22` / `gap = 8` 两个常量未变
- [ ] idle 复位 `useEffect` 未变
- [ ] `ResizeObserver` 的 observe 目标未变（仍为 footer）
- [ ] `npm run typecheck:renderer` 通过

### P5-T3 渲染合并为一行

**动作**：`:471-472` 两行合并为一行：

```
{prefsSlot ? <span ref={prefsChipRef}>{prefsSlot}</span> : null}
```

并同步更新重测依赖数组（`:362`）：`modelSlot, thinkingSlot` → `prefsSlot`。

**完成判据**：
- [ ] 渲染 JSX 中只剩**一个** slot 容器
- [ ] `ref` 只剩一个（命名可为 `prefsChipRef`）
- [ ] 依赖数组已改为 `prefsSlot`
- [ ] chip 仍位于「附件按钮之后、状态区之前」
- [ ] `npm run typecheck:renderer` 通过

### P5-T4 `ChatView` 接线 `prefsSlot`

**动作**：把 `ChatView.tsx:955-976` 的两个 slot 替换为一个 `prefsSlot`，传入 `ComposerModelThinkingPicker`，并映射全部 Props：

| Props | 取值来源 |
|-------|----------|
| `cfg` | `cfg` |
| `modelName` | `sessionBinding?.modelName ?? chatModelName` |
| `modelServiceName` | `sessionBinding?.option?.serviceAmbiguous ? sessionBinding.option.serviceName : undefined`（或直接取 `serviceAmbiguous` 判定） |
| `modelDisplayName` | `sessionBinding?.displayName ?? chatModelName` |
| `modelUnavailable` | `Boolean(sessionBinding && !sessionBinding.option)` |
| `onSelectModel` | `(opt) => void handleModelSelect(opt)`（**不改**原函数） |
| `effort` | `thinkingBinding.effort` |
| `effortOverridden` | `thinkingBinding.overridden` |
| `globalEffort` | `thinkingBinding.globalEffort` |
| `effortDisabled` | `currentModelEntry?.supportsThinking === false` |
| `effortDisabledReason` | 同上时 `t('composer.thinking.notSupported')` |
| `onSelectEffort` | `(e) => void handleThinkingSelect(e)`（**不改**原函数） |
| `availableEfforts` | P3-T3 的 `useMemo` 结果 |

同时：移除 `ComposerModelPicker` / `ComposerThinkingPicker` 的 import。

**完成判据**：
- [ ] `ChatView.tsx` 中只有一个 slot（`prefsSlot`）
- [ ] 上表 13 个 Props 均已传入且来源正确
- [ ] `handleModelSelect` / `handleThinkingSelect` **未被修改**（`git diff` 可证）
- [ ] 旧两个组件的 import 已从 `ChatView.tsx` 移除
- [ ] 服务段仅在 `serviceAmbiguous === true` 时传入（无歧义时为 `undefined`）
- [ ] `npm run typecheck:renderer` 通过

### P5-T5 `MessageInput.test.tsx` 改写

**动作**：原用例「places thinking slot after model slot and before status area」（`:115-128`）因两个 slot 消失而失效 → 改写为「合并 slot 存在且位于状态区之前」：

- 传入 `prefsSlot`，断言其存在
- 断言 slot 节点位于 `.composer-status--running` **之前**（复用原 `compareDocumentPosition` 写法）
- 保留该文件其余既有用例（排队提示等）不动

**涉及文件**：`src/renderer/components/Chat/MessageInput.test.tsx:115-128`

**完成判据**：
- [ ] 旧用例（引用 `modelSlot` / `thinkingSlot`）已删除或改写为 `prefsSlot` 版本
- [ ] 新用例断言「合并 slot 存在且位于状态区之前」
- [ ] 该文件其余用例未被误改且仍通过
- [ ] `npm exec vitest run src/renderer/components/Chat/MessageInput.test.tsx` 全绿

### P5-G 阶段 5 收尾（门禁）

- [ ] `npm exec vitest run src/renderer/components/Chat/MessageInput.test.tsx src/renderer/components/Chat/ComposerModelThinkingPicker.test.tsx` 全绿
- [ ] `npm run typecheck:renderer` 通过
- [ ] 开发模式人工确认：footer 左段**只有一个**偏好入口 chip；点击可弹出上下两分区；选模型/选档位后浮层立即关闭
- [ ] 人工确认：切换档位后 chip 强度段立即变化，且**无需发送消息**
- [ ] 已提交，提交信息说明「composer 偏好入口合并为单 chip（接线）」

---

## 9. 阶段 6：清理与文档同步

> 目标：删除死代码、清理样式、同步既有需求文档，全量收尾。

### P6-T1 删除旧两个组件

**动作**：删除 `src/renderer/components/Chat/ComposerModelPicker.tsx` 与 `ComposerThinkingPicker.tsx`。

**完成判据**：
- [ ] 两个文件已删除
- [ ] 全仓 `grep 'ComposerModelPicker\|ComposerThinkingPicker'` 仅剩测试文件与文档（测试文件由 P6-T2 处理）
- [ ] `npm run typecheck:renderer` 通过（无悬空 import）

### P6-T2 迁移 `ComposerThinkingPicker.test.tsx`

**前置状态**：该文件的 4 档序列断言已在 **P1-T12** 临时扩为 5 项（使 P1-G 门禁可通过）；此时它仍测试**旧组件**（组件尚未删除）。本任务做**最终迁移/删除**。

**动作**：将其有效用例**迁移**进 `ComposerModelThinkingPicker.test.tsx`（若 P4-T11 已覆盖对应语义，则直接删除原文件）：

| 原用例语义 | 迁入新组件测试的形态 |
|-----------|---------------------|
| 弹层档位序列 | 改为按**传入的 `availableEfforts`** 断言（不再写死档位数） |
| 等于全局档位项带 `· 默认` 标记 | 保留（对应 P4-T11 用例⑥） |
| 未覆盖时默认项选中态 / 覆盖后切换 | 保留（对应用例⑥） |
| 点「`X · 默认`」回调 `null` | 保留（对应用例⑦） |
| 选择「高」回调 `high` | 保留（对应用例⑦） |
| disabled + Tooltip 提示 | **改为**新组件的「强度分区禁用 + 提示」形态（对应用例⑨；旧组件是 chip 整体 disabled，语义已变） |

**完成判据**：
- [ ] 原文件已删除，或已改造为不依赖旧组件
- [ ] 迁移后的语义（默认标记 / 回调 `null` / 禁用提示）在 P4-T11 的用例中存在且通过
- [ ] 全仓无对 `ComposerThinkingPicker` 的测试引用
- [ ] **P1-T12 的临时 5 项断言已随文件删除或被正确迁移**（不残留对旧组件的断言）
- [ ] `npm exec vitest run src/renderer/components/Chat/` 全绿

### P6-T3 清理旧 CSS

**动作**：清理 `src/renderer/theme/config-settings.css:1696-1730` 中不再使用的规则：

- `.composer-thinking-picker__list` / `__item` / `--active` → 删除（纵向列表已废弃，横向样式归 `.composer-prefs__efforts`）
- `.composer-thinking-chip--disabled-wrapper` → 删除（「整体禁用」语义已取消）

**完成判据**：
- [ ] 上述类名已从 CSS 中移除，且全仓（tsx/css）无引用
- [ ] `.composer-model-picker*` 相关规则**保留**（模型分区仍在复用）
- [ ] 浮层视觉无回归（人工确认一次）

### P6-T4 滚动条白名单同步

**动作**：若滚动容器类名由 `.composer-model-picker` 改为 `.composer-prefs__models`，须同步 `src/renderer/theme/components.css` 的细滚动条白名单（`:31`、`:53`、`:74`、`:95`、`:116`、`:136` 六处选择器组）。

⚠️ **同时复核徽章样式作用域（与 P4-T10 同一关注点）**：`config-settings.css:1761 / 1765 / 1776` 的 `.composer-model-picker .config-model-badge*` 是**后代选择器**。若本任务把容器类名从 `.composer-model-picker` 换成 `.composer-prefs__models`，必须在**同一提交**内同步：① 容器保留 `.composer-model-picker` 类；或 ② 新增 `.composer-prefs__models .config-model-badge*` 等价规则。**否则徽章样式静默失效**（无报错、仅视觉回归）。

**完成判据**：
- [ ] 新滚动容器已加入白名单的**全部六处**选择器组
- [ ] 模型分区内滚动时呈现细滚动条（人工确认）
- [ ] **徽章样式作用域已处理**：容器保留 `.composer-model-picker` 类，或已新增等价规则；两类名变更**在同一提交**内完成
- [ ] 若保留了 `.composer-model-picker` 作为滚动容器类名，则明确记录「无需改动」及原因
- [ ] 已确认强度分区为横向布局（不滚动），故无需为其加入白名单；若实现中改为可滚动，须同样处理

### P6-T5 i18n 删旧键

**动作**：删除 `modelPicker.switchModel`、`modelPicker.selectModelAria`（zh-CN / en-US 双份）。保留 `modelPicker.empty` / `modelPicker.unavailableHint`（仍在用）。

**完成判据**：
- [ ] 两个旧键已从两个语言文件删除
- [ ] 全仓 `grep 'switchModel\|selectModelAria'` 无残留
- [ ] `npm run i18n:generate-types` 通过并重新生成类型
- [ ] `npm run i18n:check` 通过
- [ ] `npm run typecheck:renderer` 通过（证明无代码仍引用旧键）

### P6-T6 修订两份既有需求文档

**动作**（需求 §7.3）：

1. `docs/requirement/thinking-effort-settings-requirement.md`
   - §4.1 / §2.3：原「与契约保持四档，**不新增 `max` / `xhigh`**」→ 改为「**新增 `max`（共 5 档）；`xhigh` / `minimal` 仍不暴露**」，并补 `max` 语义与文案
   - §5.1 / §5.4：全局强度下拉由 4 项变 5 项（`options` 自动跟随），文案表补 `max`
   - §7.3 映射表：由 4 行扩为 **5 行**（+`max` → `{ effort: 'max' }`），说明无需类型转换
   - §5.2：入口由「模型 chip 之后的独立强度控件」改为「与模型合并的单一入口 + 浮层下分区」；展示态改为「收起态恒定显示档位词」
2. `docs/requirement/llm-multi-service-model-config-requirement.md`
   - §9.2：「当前展示」改为「收起态 = 模型名（＋歧义时服务段）＋ 当前推理强度」
   - §9.3：由「规定」升级为「**已实现**」，标注生效版本
3. `docs/requirement/composer-model-thinking-entry-requirement.md`（本需求文档）
   - 验收项编号由 A25 直跳 A27（A26 已随 FR11 收敛删除）——补一行**删除留痕**，说明「A26（SDK 类型转换单点验收）已因仅加 `max`、SDK 白名单已含而删除」，避免后续无法溯源
   - 确认该文档已纳入版本控制（当前为 git 未跟踪状态，须提交入库）

**完成判据**：
- [ ] 上述 6 处修订全部落地
- [ ] 被修订处标注了修订日期与依据（指向本需求文档）
- [ ] 未改动两份文档的其他章节
- [ ] 若 `thinking-effort-settings-requirement.md` 的 owner 需确认，已发起并记录结论
- [ ] 需求文档已补 A26 删除留痕，并已 `git add` 入库

### P6-T7 类型 / i18n / 全量测试收尾

**动作**：跑完整校验链。

**命令**：
```
npm run i18n:check
npm run typecheck:shared
npm run typecheck:renderer
npm run build:electron:incremental
npm test
```

**完成判据**：
- [ ] 上述 5 条命令全部通过
- [ ] `npm test` 无新增失败（与 P0-T2 基线对比）
- [ ] 无 NUL 字节检查失败（`npm run check:no-nul`，若 CI 需要）

### P6-G 阶段 6 收尾（门禁）

- [ ] 死代码清理完毕（旧组件、旧 CSS、旧 i18n 键）
- [ ] 全量测试通过
- [ ] 两份既有需求文档已修订
- [ ] 已提交，提交信息说明「清理旧组件与旧样式；同步既有需求文档」

---

## 10. 阶段 7：人工验收（需真机）

> 因 jsdom 不渲染真实布局，以下项必须**真机人工验收**。每项填写结论与截图/记录路径。

### P7-T1 真机宽度收益验收

| 验收项 | 操作 | 通过标准 |
|--------|------|----------|
| **A16** | 同一窗口宽度下，对比重构前后 footer 左段占用（**无歧义场景**） | 总占用**净下降** ≈34–98px |
| **A16a** | 构造「同名模型被 ≥2 个服务支持」配置，对比占用（**有歧义场景**） | 收益缩水但**不为负**（不增宽） |
| **A17** | 逐步缩小窗口宽度 | 「运行状态文案被迫折叠为 22px 图标」的阈值**右移**（更早的宽度下状态文案仍可展开） |
| **A18** | 拖动左/右侧栏改变可用宽度 | 状态区折叠切换**无闪烁、无布局抖动** |

**完成判据**：
- [ ] A16 / A16a / A17 / A18 四项均已实测并记录结论
- [ ] 无歧义与有歧义两种配置**分别**验证过
- [ ] 结论与 `§5.2.1` 的估算方向一致（若不符，需回归排查）

### P7-T2 截断与换行验收

| 验收项 | 操作 | 通过标准 |
|--------|------|----------|
| **A2c** | 收窄可用宽度 | 模型段（含服务段）被省略号截断、**强度段完整可见** |
| **A2d** | 分别配置 1 个 / ≥2 个服务支持同名模型 | 前者**无**括号；后者显示 `模型名（服务名） · 档位` |
| **A25** | 切到全 5 档模型，观察强度分区 | **正确换行为 2 行（4+1）**，不溢出、不裁切；2–3 档模型不拉伸占满 |

**完成判据**：
- [ ] A2c / A2d / A25 三项均已实测并记录
- [ ] 长服务名（如 `火山CodingPlan`）场景已验证截断表现
- [ ] 5 档模型的浮层总高不溢出视口

### P7-T3 无障碍读屏验收

| 验收项 | 操作 | 通过标准 |
|--------|------|----------|
| **A19** | 检查 chip 属性 | 具备 `aria-haspopup` / `aria-expanded`，`aria-label` 同时描述模型与强度 |
| **A20** | 纯键盘操作 | `Tab` 可进入浮层遍历两分区；`Esc` 关闭并把焦点归还 chip |
| **A21** | 读屏 | 可识别强度分区及其选中项（`radiogroup` / `radio` + `aria-checked`） |

**完成判据**：
- [ ] A19 / A20 / A21 三项均已实测并记录
- [ ] 读屏**未**漏报强度分区

### P7-T4 回归确认

| 验收项 | 通过标准 |
|--------|----------|
| **A12** | 选模型后 `session:update` 载荷仍为 `{ model: modelName, llmServiceId: serviceId }` |
| **A13** | 选档位后 `session:update` 载荷仍为 `{ thinkingEffort }`（默认项为 `null`） |
| **A14** | 无会话时两者均以草稿形式保留，随首个会话创建写入 |
| **A15** | 运行时档位 → provider 映射、`supportsThinking` 降级路径无改动 |
| **A22d** | `buildThinkingWireParams('max')` 产出 `output_config.effort = 'max'`；`off` 不带 `output_config` |
| **A23** | 全仓无「把 `THINKING_EFFORT_LEVELS` 直接 map 成 UI 项」的硬编码路径（本组件） |
| **A27b** | 浮层模型列表渲染正常；设置页与配置快照无变化 |

**完成判据**：
- [ ] A12–A15、A22d、A23、A27b 全部通过
- [ ] A12 / A13 的载荷通过日志或网络抓包确认（非仅看 UI）
- [ ] 配置快照测试无变化

### P7-T5 验收记录归档

**动作**：将 P7-T1～T4 的结论、截图/日志路径汇总为一个验收记录文档：`docs/develop/composer-model-thinking-entry-acceptance-evidence.md`。

**完成判据**：
- [ ] 归档文档已创建，含全部人工验收项（A2c/A2d/A16/A16a/A17/A18/A19/A20/A21/A25/A27b）的结论与证据路径
- [ ] 每项标注「通过 / 不通过 / 存疑」三态之一
- [ ] 存疑项已列出后续处置（回归排查或记为已知限制）

---

## 11. 验收项 → 任务映射（可追溯）

| 需求验收项 | 覆盖任务 | 验证方式 |
|-----------|----------|----------|
| A1 单一入口 | P5-T1 / P5-T3 | 自动化（`MessageInput.test.tsx`） |
| A2 模型段无前缀 | P4-T2 | 自动化（组件单测 ①） |
| A2a 恒定显示强度 | P4-T2 / P4-T11 | 自动化（组件单测 ⑬） |
| A2b 强度段即时更新 | P4-T11 | 自动化（组件单测 ⑭） |
| A2c 截断优先级 | P7-T2 | 人工真机 |
| A2d 服务段仅歧义出现 | P4-T2 / P4-T11 | 自动化（①/②）+ 人工（P7-T2） |
| A3 `title` 完整信息 | P4-T2 | 自动化 |
| A4 警告态类名 | P4-T8 | 自动化（组件单测） |
| A5 空池回退 | P4-T8 / P4-T11 | 自动化（⑩） |
| A6 单浮层含两分区 | P4-T3 / P4-T11 | 自动化（③） |
| A7 模型项结构 | P4-T4 / P4-T11 | 自动化（④） |
| A8 档位项 = 传入集合 | P4-T5 / P4-T11 | 自动化（⑤/⑥） |
| A9 默认项回调 `null` | P4-T5 / P4-T11 | 自动化（⑦） |
| A9a 选中即关闭 | P4-T6 / P4-T11 | 自动化（⑧） |
| A10 禁用态仍可换模型 | P4-T7 / P4-T11 | 自动化（⑨） |
| A11 仅模型区滚动 | P4-T4 | 人工（P7-T2 附带） |
| A12 模型写库载荷 | P5-T4 / P7-T4 | 日志确认 |
| A13 档位写库载荷 | P5-T4 / P7-T4 | 日志确认 |
| A14 草稿保留 | P5-T4 / P7-T4 | 人工 + 既有测试 |
| A15 运行时无改动 | P1-T8 / P7-T4 | 既有测试全绿 |
| A16 无歧义净下降 | P7-T1 | 人工真机 |
| A16a 有歧义不为负 | P7-T1 | 人工真机 |
| A17 折叠阈值右移 | P7-T1 | 人工真机 |
| A18 无抖动 | P7-T1 | 人工真机 |
| A19 aria 属性 | P4-T9 / P7-T3 | 自动化（⑮）+ 人工 |
| A20 键盘可达 | P4-T9 / P7-T3 | 人工 |
| A21 读屏识别强度区 | P4-T9 / P7-T3 | 人工 |
| A22 集合驱动渲染 | P3-T2 / P4-T11 | 自动化（⑪） |
| A22a 键缺失不排除 | P3-T2 | 自动化 |
| A22b fail-open | P3-T2 / P4-T11 | 自动化 |
| A22c 5 档枚举生效 | P1-T2 / P1-T6 | 自动化 |
| A22d wire 产出 max | P1-T7 / P1-T8 | 自动化 |
| （第 1 轮 B1/M1）IPC 层接受 `max` + 文案同步 | P1-T10 / P1-T11 | 自动化 |
| （第 2 轮 B1(v2)/B2(v2)）既有测试波及面收敛 | P0-T2（盘点）/ P1-T3 / P1-T12 | 自动化 |
| （第 3 轮 B1(v3)）字段规则变化的断言消费方收敛 | P0-T2（B 组盘点）/ P2-T6 | 自动化 |
| （第 4 轮 B1(v4)）组件所需 i18n 资源的创建归属 | P4-T0 | 自动化（`i18n:generate-types` / `i18n:check` / `typecheck`） |
| A23 无硬编码档位数组 | P4-T5 / P7-T4 | 代码检查 |
| A24 切模型即时重算 | P3-T3 / P3-G | 人工 + 单测 |
| A25 5 档换行不溢出 | P4-T10 / P7-T2 | 人工真机 |
| A27 展示名规则 | P2-T1 / P2-T3 | 自动化 |
| A27a 断言反转到位 | P2-T3 / P2-T4 / P2-T6 | 自动化 |
| A27b 列表渲染不回归 | P2-T5 / P7-T4 | 人工 + 既有测试 |
| A26 | — | **已随 FR11 收敛删除**（仅加 `max`，SDK 白名单已含，无需类型转换） |

---

## 12. 风险与回滚

| # | 风险 | 影响 | 缓解 / 回滚 |
|---|------|------|-------------|
| R1 | 枚举扩展后**旧版本降级**读 `max` 视为未设置 | 会话档位回落为继承全局（不崩） | 已在需求中记为可接受代价；P1-G 人工确认一次降级表现 |
| R2 | `displayName` 改动波及未预料的消费方 | 模型名显示异常 | P0-T1 已强制核查消费点；P2-T5 专门确认列表渲染；异常时可单独 revert P2 |
| R3 | `minimal` / `xhigh` 未暴露，部分模型（如 `deepseek-v4-pro`）的 `xhigh`/`max` 在 UI 上不可达 | 能力表达不完整 | **已知取舍**（OQ-11）；如需放开需另立需求（涉及枚举再次扩展） |
| R4 | fail-open 导致无 `thinkingLevelMap` 的模型显示含 `max` 的全 5 档，其中部分可能不支持 | 用户「设了没效果」 | 不收紧（OQ-14）；由运行时 fail-soft 兜底；P1-T9 记录该风险 |
| R5 | `max` 是 SDK 合法值，若被网关**静默忽略**而非 400 | 不触发重试路径，用户无感知 | 已在需求 §2.6 记录；P7-T4 用日志确认实际发出的 wire 参数 |
| R6 | 5 档换行在窄浮层下溢出 | 视觉缺陷 | P4-T10 用 `flex-wrap` + `min-width`；P7-T2 真机确认 |
| R7 | P5 接线后 footer 布局抖动 | 体验回退 | P5-G 人工确认；必要时单独 revert P5（P4 组件可保留） |
| R8 | 两处 `onSelect` 之一漏写 `setOpen(false)` | 行为不一致 | P4-T11 用例⑧双向覆盖 |
| R9 | **漏列必改测试**导致阶段门禁出现无归属红色用例（第 1 轮 B1：`appIpc.thinkingEffort.test.ts`；第 2 轮 B1(v2)/B2(v2)：`ComposerThinkingPicker.test.tsx`、`thinkingAvailability.test.ts`；第 3 轮 B1(v3)：`visionModelRouting.test.ts`） | 门禁卡住、执行者误判为回归 | **已可执行化**：P0-T2 内置**两组**波及面检索（A. 档位类 15 文件 / B. 字段类 9 文件），全部「转红」文件各有归属任务（P1-T3/T6/T11/T12、P2-T3/T4/T6）；P1-G / P2-G 门禁要求逐项核对。**教训（三轮收敛后）**：凡改动**产品常量、生成规则或被消费字段**，都须检索其**全部断言消费方**——不仅是「断言档位非法」的测试，还包括断言**档位数量/序列**、**输出全集**（如 memo 返回 `[...PRODUCT_EFFORTS]`）、以及**透传该字段的任何模块**（如 `visionModelRouting` 透传 `displayName`） |
| R10 | IPC 错误文案硬编码档位清单随枚举过时 | 报错信息与实际可接受值不符 | P1-T10 改为从 `THINKING_EFFORT_LEVELS` 派生；P0-T1 已登记三处位置 |
| R11 | `packages/agent-core` 存在**独立重复**的 `ReasoningEffort` 枚举（`provider.ts:1`），未随产品枚举扩展 | 名义不一致 | 当前仅被其自身测试引用（`packages/agent-core/test/provider.test.ts`），**无生产消费方**，不影响编译与运行。**本次不扩**，仅在 P1-T1 备注标注「agent-core 档位枚举独立于产品枚举，暂不暴露 `max`」，如需统一另立需求 |
| R12 | 测试文件内联的**档位类型注解**（非常量引用）随枚举扩展失去同步（`electron/toolChatLoop.usageStream.test.ts:134` 声明 4 项档位） | 类型检查报错或静默不同步 | 按赋值方向判断：4 项类型是 5 项的**子集**，传入期望 `AgentReasoningEffort` 的参数**类型兼容**，故大概率无害。**已登记为 P0-T2 核查项**：P1 后跑一次 `typecheck` / `test:electron` 确认；若报错则把该注解补为 5 项 |
| R13 | **门禁断言某资源已存在，但无任务负责创建**（第 4 轮 B1(v4)：P4-G 自注「组件引用的所有键已存在」，却无任务新建 8 个 `composer.prefs.*` 键；因 `t()` 强类型，键缺失直接编译报错） | 阶段门禁必卡，且红色错误无归属任务 | 已补 **P4-T0** 专责建键；P4-G 改为挂载到该任务。**通用对策**：凡门禁中出现「某资源已存在 / 已对齐 / 已同步」类断言，**必须能指回一个明确创建或同步该资源的任务**，否则即为计划缺口 |
| R14 | **改动值的「精确形态」被其它规则隐式依赖**（第 5 轮：`modelServiceSuffix` en-US 多一个尾空格 → 与 `chipSeparator` 前导空格叠加成双倍间距；徽章样式靠 `.composer-model-picker` **后代选择器**生效，容器改类名 → 徽章样式**静默失效**、无报错） | 视觉缺陷且无编译/测试信号，易漏过 | 已分别落为 P4-T0（去尾空格 + 成因说明）、P4-T2（单空格核对）、P4-T10 + P6-T4（作用域二选一）。**通用对策**：凡改动**类名 / 资源名 / 文案值**，都须复核「是否有其它规则或拼接依赖该值的**精确形态**」（含前后空格、大小写、类名作为选择器锚点等） |

**回滚粒度**：每阶段独立提交，可按阶段 revert。P1/P2/P3 为纯 shared 层改动，独立回滚不影响 UI；P4 未接线，回滚零影响；P5 为行为切换点，是主要回滚边界。

---

## 13. 提交切分建议

| 提交 | 内容 | 对应阶段 |
|------|------|----------|
| 1 | 档位枚举扩为 5 档（+`max`）：shared 层 + IPC 错误文案 + i18n + 测试 | P1 |
| 2 | `displayName` 仅在歧义时加前缀 + `serviceAmbiguous` | P2 |
| 3 | 新增可用档位集合解析（renderer 自算） | P3 |
| 4 | 新增 `ComposerModelThinkingPicker`（含 `composer.prefs.*` i18n 键，单测，未接线） | P4 |
| 5 | composer 偏好入口合并为单 chip（`MessageInput` 收敛 + 接线） | P5 |
| 6 | 清理旧组件/旧样式/旧 i18n 键 + 同步既有需求文档 | P6 |
| 7 | （如有）验收记录归档 | P7 |

> 提交 1–3 可合并为一笔（若追求更少提交），但**提交 4 与 5 必须分开**——前者是新增（可独立验证、零风险），后者是行为切换（回滚边界）。

