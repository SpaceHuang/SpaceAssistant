# 工作目录 AGENTS.md 支持开发计划

- 日期：2026-10-15
- 关联需求：[工作目录 AGENTS.md 指令支持需求](../requirement/agents-md-workdir-instructions-requirement.md)
- 需求状态：已通过评审，B01–B03 已关闭（依据用户确认）
- 计划状态：待实施；已按 2026-10-15 开发计划评审修订
- 版本范围：仅加载当前调用工作目录根部的 `AGENTS.md`；不支持子目录指令；不增加 agent-sdk 产品专用接口；不实现跨进程重启后的 invocation 可执行恢复。
- 任务状态：`[ ] 未开始`、`[~] 进行中`、`[x] 完成`、`[-] 不适用/经证据确认无需改动`、`[!] 受阻`。完成任务时补上验证命令 / 结果和提交 SHA；若无需改动，记录核查证据后标 `[-]`。
- 执行约定：按阶段顺序推进；同阶段可并行的任务须满足依赖并避免同时改同一文件。每阶段完成并验收后单独提交。定向测试按仓库 `AGENTS.md` 纪律合并运行；全量测试仅阶段收尾及最终验收运行。评审依据：[开发计划评审报告](../review/agents-md-workdir-instructions-development-plan-review.md)。

## 1. 目标与完成定义

交付后，每个逻辑 provider 请求都依据其发出时解析的会话工作目录根部 `AGENTS.md` 装配独立快照。同一逻辑请求的 provider 底层重试与其产生的待审批操作保留来源快照；文件变化从同一 invocation 后续逻辑请求生效。目录切换、grant 校验、审批、History、UI 请求状态与实际 provider 请求保持一致。

完成需同时满足：

1. 桌面、飞书、微信、自动化等现有 Agent Runtime 入口使用同一宿主加载与装配策略；缺文件、失败、超限和关闭开关行为一致。
2. `switch_work_dir` 有顺序屏障；旧目录响应 / 审批不能跨目录派发；新目录下一逻辑请求使用新目录规则。
3. 请求级快照可关联到 History 中对应模型请求；重启后只读展示历史快照，未完成 invocation 保持 `interrupted`。
4. UI 可分辨 invocation 设置开关的生效点与文件内容的请求级生效点，并查看每个逻辑请求所用版本。
5. `npm run check:agent-sdk` 通过，SDK 依赖闭包无文件系统 / Electron / `src/shared` 反向依赖；相关定向、类型、构建、全量验收按阶段通过。

## 2. 本轮评审修订映射

| 评审结论 | 计划修订 | 关闭依据 |
| --- | --- | --- |
| B01 仍阻断：响应级检查不足以保证工具最终派发时绑定未变 | 阶段 0.2 盘点队列 / lock / prepare / claim 路径；阶段 5.1 要求每个普通与只读工具在最终派发边界对比来源 request binding，并保证校验目录与 executor 目录相同；阶段 5.5 加入暂停队列 / resource lock 后切换 A→B 的测试 | executor 未进入、未派发工具回传未执行、已执行工具不重放、R2 加载 B 指令；既有机制足够时以代码路径及回归证据关闭，不另造调度器 |
| B02 已撤销：不要求恶意本地程序路径替换对抗 | 阶段 2.2–2.3、2.6 限定为普通文件 / 基础路径边界、有限读取、正常并发编辑和原子替换兼容；移除恶意竞态替换、父目录防替换、复杂句柄校验及 FIFO 对抗作为任务前置条件 | 正常稳定版本完整读取；不稳定时有界重试、明确降级且不回退旧正文；越界链接 / 非普通文件拒绝 |

## 3. 全局依赖图

```text
阶段 0 契约盘点与请求边界原型
  ├─ 阶段 1 领域契约 / 错误与设置持久化
  ├─ 阶段 2 宿主 AGENTS.md 读取器 ─┐
  └─ 阶段 3 History 请求级快照契约 ├─ 阶段 4 逐请求提示装配与入口接线
                                      ├─ 阶段 5 目录切换 / 同批屏障 / grant
                                      ├─ 阶段 6 UI 与状态历史
                                      └─ 阶段 7 跨入口边界集成
                                             └─ 阶段 8 最终验收与发布说明
```

阶段 1、2、3 在阶段 0 完成后可分支推进；阶段 4 必须等 1、2、3 完成。阶段 5 与阶段 6 依赖阶段 4 的稳定事件 / 状态合同，可在接口冻结后并行但必须先合并阶段 4。阶段 7 汇总所有入口和边界，阶段 8 最终验收。

## 4. 分阶段任务清单

### 阶段 0：冻结运行时边界与数据落点

**阶段完成条件：** 形成经代码核对的调用路径图、请求标识与 History 落点决策；明确每个 provider 请求的创建、底层重试、工具返回、审批恢复及下一请求的边界。阶段提交只记录设计基线，不改变产品行为。

- [x] **0.1 入口与请求路径盘点** — 桌面 / IM / automation 共用 `runToolChatSession → hostedTurnHandoff → runHostedAgentTurn`；provider attempt retry 复用同一 logical requestId，tool result 后 modelTurn 新增。证据见 runtime-baseline；commit `f3791a04`。
  - 依赖：无
  - 核查：`electron/claudeStreamHandlers.ts`、`electron/toolChatLoop.ts`、`electron/runtime/invocationAssembler.ts`、Hosted handoff 分支及 IM / 自动化入口。
  - 完成判据：文档化桌面、Feishu、WeChat、automation 如何到达同一逻辑请求装配；列明现有请求重试和再次请求的分界，不把底层 provider retry 误判为新逻辑请求。
- [x] **0.2 工作目录动态解析与切换屏障盘点** — 解析与 initial/recheck 动态取目录，PermitBinding 仅比较工具自身 initial/recheck；普通批次并发且无 switch 屏障，来源 request binding 未在 executor 前比较。证据见 runtime-baseline；commit `f3791a04`。
  - 依赖：无
  - 核查：`electron/workDirManager.ts`、`electron/workDirSnapshot.ts`、`electron/tools/workDirExecutors.ts`、工具批处理 / dispatch 与 approval resume 路径。
  - 完成判据：记录 `resolveWorkDir` 实际刷新时点、binding / grant 身份比较方式、同批调用当前调度顺序，以及成功 / 失败切换时所有 sibling tool 的现状；特别画出 provider response 校验、队列 / resource lock 等待、SDK `prepareTool(..., recheck)`、最终 claim 和 executor 进入的顺序。明确每个普通 / 只读工具首次准备前绑定变化与准备后变化的现有行为。
  - 结论要求：核实当前 initial/recheck 是否会与来源 provider request 的 binding 身份比较；仅证明工具自身 initial 与 recheck 相同，不足以关闭此任务。
- [x] **0.3 History 快照存储与投影盘点** — 复用 `model-request-started` requestId/modelTurn/attempt 与 canonical payload/spill，不建第二历史流。证据见 runtime-baseline；commit `f3791a04`。
  - 依赖：无
  - 核查：`packages/agent-sdk/src/history.ts`、`packages/agent-sdk/src/turn.ts`、`electron/database/agentHistoryStorage*`、`electron/runtime` history 投影及 spill 存储。
  - 完成判据：找出既有通用事件关联 `invocationId`、logical request / model request id、请求尝试和工具调用的字段；决定快照正文应进入现有 canonical History payload 还是已存在的宿主 sidecar。不得新建第二套运行历史。
- [x] **0.4 逐请求刷新原型与边界 RED** — 现有 prepareModelRequest 只能观察/投影请求，不能替换冻结请求；R1 / retry-A / R2-B RED 落在阶段 4 捕获回归。缺口与最小通用 hook 决策见 runtime-baseline；commit `f3791a04`。
  - 依赖：0.1、0.3
  - 完成判据：用伪 provider 或最小宿主验证 R1 请求、工具返回后 R2 可由宿主重新装配 system/context，同时 R1 retry 不重新读取；记录现有通用端口能否承载。如现有端口不足，先列出最小可序列化中立契约并评审后再进入实现，不直接扩展产品专用 SDK API。
- [x] **0.5 基线记录与阶段提交** — 仅纳入本计划、需求、评审和 runtime baseline；原工作区其余 5 项未提交改动留在主工作区。定向命令 `npm exec vitest run <受影响文件>`；SDK 门禁 `npm run check:agent-sdk`。commit `f3791a04`。
  - 依赖：0.1–0.4
  - 验收：记录工作区既有改动不纳入本任务；记录可重复的定向测试命令、SDK 边界门禁命令；提交阶段 0 设计基线。

### 阶段 1：共享类型、配置开关和持久化

**阶段完成条件：** 新增的 AGENTS 开关与状态具有唯一共享类型和稳定存储语义，旧 `projectMemoryEnabled` 行为不变。

- [x] **1.1 新增独立 AGENTS 开关类型与默认值** — `agentsMdEnabled`，session metadata 缺省 true；project memory 独立。commit `88a19499`（`feat: persist per-session AGENTS.md setting`）。
  - 依赖：0.5
  - 文件候选：`src/shared/domainTypes.ts`、现有 session/config domain 类型及其默认值实现。
  - 完成判据：`agentsMdEnabled`（最终命名在本任务内核定）默认开启；旧项目记忆字段仍只控制 `SPACEASSISTANT.md`；类型不重复定义在 renderer / electron。
- [x] **1.2 确定会话级持久化位置与迁移策略** — 复用 Session.metadata JSON，无 schema migration；旧 metadata 无字段时默认 true。
  - 依赖：1.1
  - 文件候选：会话 metadata / profile 存储实现、`electron/database` operations 与 session serializers。
  - 完成判据：开关按会话持久化；旧会话缺字段时回退为开启；切换活动 workDir 不串用开关；既有数据库行无需破坏性迁移，或迁移具备向前兼容测试。
- [x] **1.3 接入创建 / 读取 / 更新路径** — 新会话写 true，可由受信 session update 切换；renderer 通用 metadata patch 不可改此字段；桌面与远端 turn config 同源读取。
  - 依赖：1.2
  - 完成判据：新会话默认开启；会话重载、远程会话与桌面会话均得到同一有效值；配置更新只影响其所属会话。
- [x] **1.4 定向验证开关兼容性** — `npm exec vitest run electron/sessionStorage/sessionStorage.test.ts electron/turnExecutionConfig.test.ts electron/turnExecutionConfig.thinkingEffort.test.ts electron/appIpc.file.test.ts electron/appIpc.sessionUpdate.test.ts`：5 files / 152 tests passed；`npm run typecheck:shared` passed。阶段提交 `88a19499`。
  - 依赖：1.3
  - 测试：会话 storage / config resolver / turn configuration 相关定向测试。
  - 完成判据：旧 `projectMemoryEnabled` 测试行为保持；新增字段缺失、true、false、跨重启和双会话隔离用例通过。

### 阶段 2：宿主侧 AGENTS.md 安全读取器

**阶段完成条件：** 纯宿主服务按显式 workDir 加载文件，具备有界读取、失败分类、预算和目录隔离；不触碰 SDK。

- [x] **2.1 定义请求级状态与读取结果模型** — `AgentsMdLoadResult`：状态、相对来源名、正文、字节数、SHA-256、加载时间、token 数与 workDir；无文件句柄或授权对象。
  - 依赖：0.5、1.1
  - 文件候选：`src/shared/domainTypes.ts`（仅纯数据类型）、建议新增 `electron/projectInstructions/`。
  - 完成判据：描述 path/source、content、摘要、字节数、加载状态、截断/超限状态、加载时间、目录绑定标识所需的最小可序列化字段；类型不含 watcher、fs handle、函数或敏感 grant 句柄。
- [x] **2.2 实现根文件路径解析与授权边界检查** — 仅根 `AGENTS.md`，realpath 检查根内符号链接，拒绝越界链接与目录。
  - 依赖：2.1
  - 完成判据：只解析 `<effectiveWorkDir>/AGENTS.md`；不使用 `process.cwd()`；仅允许普通文件和落在 workDir 内的符号链接目标；父目录 / 子目录 / 用户目录不搜索；越界和非普通文件返回结构化状态。
- [x] **2.3 实现有界字节读取和 UTF-8 处理** — 32 KiB 上限、fatal UTF-8、BOM/CRLF 规范化；文件版本不稳定最多重读一次，随后 `unstable` 且正文为空。
  - 依赖：2.2
  - 完成判据：检查文件大小 / 普通文件类型并限制实际读取字节，避免无界读取；支持 UTF-8 BOM、CRLF、中文；非法 UTF-8 明确失败；普通并发修改或原子替换导致读取版本不稳定时最多有界重试一次，仍不稳定则返回明确降级状态且不复用旧正文。
  - 安全边界：实施基础路径边界和普通文件检查；不把恶意本地程序竞态替换视为本期威胁模型，不实现父目录防替换、句柄身份强校验或 FIFO 对抗机制。
- [x] **2.4 实现内容空白判定与预算策略** — 空白不注入；token 上限为 `min(8,000, floor(contextWindow × 5%))`，超限整份跳过。
  - 依赖：2.3
  - 完成判据：按需求的 32 KiB 字节限制和 token 预算（`min(8,000, 5% context window)`）；超限整份不注入，不按字符数代替字节数；空白与缺失不产生错误正文。
- [-] **2.5 实现跨 workDir 隔离缓存策略（如确有缓存）** — loader 不设跨请求缓存，每次逻辑请求重新读盘，因此无需缓存 key，也不会复用其他 workDir 或旧正文；同一 modelTurn 的 retry 快照固定由阶段 4 observer 管理。
  - 依赖：2.2–2.4
  - 完成判据：缓存 key 包含规范化目录、绑定版本和文件版本；新逻辑请求会检测变化；任何错误、缺失、禁用都不回退其他目录或旧版本正文。若直接每请求读取更简单，记录证据并标 `[-]`。缓存命中不得改变每个逻辑请求的状态历史。
- [x] **2.6 为读取器补齐边界测试** — 覆盖缺失、空白、禁用、无效目录、权限失败、UTF-8、字节/token 上限、普通目录、内外符号链接、双目录隔离、原子替换、并发编辑重试与不稳定降级。
  - 依赖：2.2–2.5
  - 测试：新 `electron/projectInstructions/*test.ts`。
  - 完成判据：临时目录测试覆盖存在 / 缺失 / 空白 / 编码 / 上限 / 超限 / 权限 / 普通目录 / 内外符号链接 / 正常并发编辑 / 编辑器式原子替换 / 两目录并发；验证读取有界、内容稳定时取完整版本、不稳定时有界重试后明确降级且不复用旧正文。无测试依赖真实用户目录。
  - 范围边界：不测试刻意卡在路径检查与打开之间的恶意替换，不新增跨平台父目录防替换、复杂句柄身份验证、FIFO 替换对抗要求。正常编辑器原子保存与并发更新属于必须兼容场景。
- [x] **2.7 运行读取器定向测试并提交阶段** — 合并阶段 1、2 与当前请求装配回归验证完成；`npm run typecheck:shared`、`npm run check:agent-sdk` 通过。electron incremental build 被 pi-ai closure gate 阻断（缺少预期 `api/anthropic-messages.js`、`utils/transcript.js`，扫描实际为空）。
  - 依赖：2.6
  - 完成判据：一次合并运行阶段 1、2 受影响测试；记录结果与提交 SHA。

### 阶段 3：逐请求快照与 History 投影合同

**阶段完成条件：** 每个 logical provider request 有稳定关联的快照记录；底层 retry / approval tool 关联旧请求；下一请求新读；重启后仅只读还原。

- [ ] **3.1 定义 logical request 标识映射**
  - 依赖：0.3
  - 完成判据：明确区分 invocation、logical model request、provider retry attempt、tool call、approval。快照按 logical request 关联；同一 logical request retry attempt 共享该标识。
- [ ] **3.2 确定 canonical History 事件挂载方式**
  - 依赖：3.1
  - 完成判据：复用既有通用 context / request event payload 的扩展位保存可序列化 snapshot metadata 与必要正文；记录载荷大小上限与正文 spill 方案。不可只存摘要后承诺完整历史查看；不新增专用数据库表 / 第二 event stream，除非阶段 0 证明现有结构无法承载并单独评审。
- [ ] **3.3 将 request snapshot 与模型请求事实绑定**
  - 依赖：3.2
  - 完成判据：history 重建能把请求的目录、digest、加载结果与该次 provider request 一一对应；多次请求在同一 invocation 内不会覆盖前一条快照。
- [ ] **3.4 将工具 / 审批来源请求关联到 History**
  - 依赖：3.3
  - 完成判据：tool-call-started / approval 等既有事实可追溯其来源 logical request；审批通过后执行旧操作时读取来源快照 metadata，不把它重新标成新请求。
- [ ] **3.5 实现重启后只读历史快照投影**
  - 依赖：3.3、3.4
  - 完成判据：已持久化正文按原 digest 展示；正文缺失 / spill 丢失显示不可还原；绝不以磁盘当前文件补旧历史；未完成 invocation 仍为 `interrupted`，没有执行恢复逻辑。
- [ ] **3.6 补齐 History / spill / interrupted 回归测试**
  - 依赖：3.3–3.5
  - 完成判据：同 invocation 两个请求有不同 snapshot 可分别还原；缺旧正文时状态明确；审批与工具关联请求来源；重启不重新派发工具；历史正文不进入日志。
- [ ] **3.7 运行定向测试并提交阶段**
  - 依赖：3.6
  - 完成判据：一次合并运行 SDK history 与 electron history storage 相关测试；若触及 SDK 代码，阶段内运行 `npm run check:agent-sdk`；记录是否仅扩展中立可序列化事件合同和提交 SHA。

### 阶段 4：请求边界提示装配与入口接线

**阶段完成条件：** 每个逻辑请求由宿主读取并装配恰好一份项目指令区块；provider 底层 retry 复用请求已冻结内容；各入口没有旁路拼接。

- [ ] **4.1 定义独立 prompt section 与冲突优先级说明**
  - 依赖：1.1、2.1
  - 文件候选：`electron/llmSystemPrompt.ts`、`src/shared/promptAssembly.ts`。
  - 完成判据：新增独立 AGENTS section，不复用 `<project_memory>` 标签；注明项目来源 / root scope；安全规则和用户指令优先级清楚；UI locale 仍是默认提示而非覆盖项目 / 用户语言。
- [ ] **4.2 把首次请求读取放在有效 workDir 解析后**
  - 依赖：2.6、3.3、0.4
  - 文件候选：`electron/runtime/invocationAssembler.ts` 及实际请求准备入口。
  - 完成判据：首个 logical request 从该 session effective workDir 加载；排队开始时重新解析；请求快照在 dispatch 前被冻结并绑定对应 request id。
- [ ] **4.3 把后续逻辑请求重新加载接入统一宿主边界**
  - 依赖：4.2、3.3
  - 文件候选：`electron/toolChatLoop.ts`、request loop / context preparation。
  - 完成判据：tool result 后的新 logical request 再读磁盘；R1 的 provider retry 使用 R1 原装配；同 invocation R2 可用文件新版本；刷新通过现有通用 request/context / History 边界，禁止直接改写循环内 messages 绕过契约。
- [ ] **4.4 保持 hosted handoff 使用同一快照合同**
  - 依赖：4.2、4.3
  - 完成判据：`onHostedTurnHandoff`、provider 托管路径与直连请求对同一 request ID 使用相同 prompt / snapshot metadata；没有因 handoff 再次读取造成同一逻辑请求内容漂移。
- [ ] **4.5 合并两个项目文件及 Skills 的最终装配**
  - 依赖：4.1–4.4
  - 完成判据：`AGENTS.md` 与 `SPACEASSISTANT.md` 可并存；旧项目记忆开关语义不变；AGENTS 独立开关关闭时不读取正文；skills 与工具目录只有一套 buildFinalSystemPrompt 路径。
- [ ] **4.6 计入上下文预算与 token usage**
  - 依赖：4.5
  - 完成判据：系统提示预算 / context meter 以真实最终请求为准；超限显式失败，不仅 UI 估算；每逻辑请求成本不重复累计历史快照。
- [ ] **4.7 编写真实装配捕获测试**
  - 依赖：4.2–4.6
  - 完成判据：伪 provider 捕获完整 provider 请求，覆盖缺文件、并存、优先级文字、首请求、R1 retry、R2 文件更新、开关关闭、超限失败、各入口材料相同。
- [ ] **4.8 验收阶段 4 并提交**
  - 依赖：4.7
  - 完成判据：合并运行 toolChatLoop / prompt assembly / invocation assembler 定向测试；涉及共享类型时跑 `npm run typecheck:shared`，涉及 renderer 类型时按阶段 6 执行；提交 SHA 写回本计划。

### 阶段 5：目录绑定变化、switch_work_dir 屏障与审批校验

**阶段完成条件：** 没有旧目录的 provider response 或待审批工具能在新目录 / 新 grant 下执行；Agent 主动切换保留既有语义并重新装配后续请求。

- [ ] **5.1 将来源 binding 校验落到每个工具的最终派发边界**
  - 依赖：0.2、4.3
  - 完成判据：provider response 收到时可先做批次级早期检查，但每个普通工具、只读工具均须携带来源 logical request 的 workDir / binding identity，在经过工具队列、前一工具等待或 resource lock 后、最终 claim / recheck 或进入 executor 前再次与当前会话绑定比较。
  - 目录一致性：绑定校验所用的已解析 workDir 必须就是随后传给工具执行上下文的目录；不得校验 A 后再通过动态 `resolveWorkDir()` 解析并执行 B。发生绑定变化的未派发工具不进入 executor，返回明确未执行结果；已执行工具不回滚或重放。
  - 既有机制复用：阶段 0 先检查 existing initial / recheck / claim 是否已经提供该保证；若充分，引用代码路径和回归证据即可，不另造调度器或重复检查层。
- [ ] **5.2 实现 switch_work_dir 同批顺序屏障**
  - 依赖：5.1
  - 完成判据：一个 provider response 含 switch 与 sibling tools 时，只有 switch 先完成；sibling 不并发越过；成功后 siblings 标为未执行并回传模型，下一请求在新目录 rules 下重新决定；失败时保留旧绑定并报告未执行 siblings。
- [ ] **5.3 审批恢复前重新校验目录与 grant**
  - 依赖：5.1、3.4
  - 完成判据：目录 / binding / grant 未变时，审批通过后按来源请求操作和快照执行；任一授权边界变化时取消待派发操作，不转用新目录 grant；明确提示模型重新发起新操作。审批校验需与普通工具最终派发校验共用清晰的来源身份语义，不以“重新审批通过”替代来源请求 binding 校验。
- [ ] **5.4 验证 Agent 主动切换后的 R2 装配**
  - 依赖：5.2、4.3
  - 完成判据：A→B 成功后同一 invocation R2 从 B 读取 B/AGENTS.md；R1 的 A snapshot 仍保留在历史中；B 文件不覆盖 A 请求记录。
- [ ] **5.5 测试边界竞态和不变量**
  - 依赖：5.1–5.4
  - 完成判据：测试 provider 在途时外部切换、同批工具切换、switch 失败、审批等待期间切换、切换后旧 grant 撤销；断言执行目录、可写授权、返回模型的 tool outcome 与快照版本一致。
  - 必测派发窗口：响应检查完成后暂停工具队列或 resource lock；外部将 A 切到 B，再恢复；断言尚未派发的普通工具及无审批只读工具均未进入 executor，回传未执行结果，下一逻辑请求加载 B 指令。
  - 必测同批前序窗口：同批前一个普通工具执行期间将 A 切到 B，后续未派发工具不得使用动态解析出的 B 执行 A 请求产生的操作；已执行工具不重放。至少一项并发 / 操作序列回归覆盖 dispatch 不会绕过最终边界。
- [ ] **5.6 跑定向安全测试并提交**
  - 依赖：5.5
  - 完成判据：合并运行 `electron/tools/workDirExecutors.test.ts`、相关 `toolChatLoop` / approval / boundary tests；记录测试命令和 SHA。

### 阶段 6：设置开关与请求级状态 UI / IPC

**阶段完成条件：** 桌面用户能修改会话级开关并查看 invocation 内每个请求的快照历史和待审批操作关联；IM 的文本降级状态符合要求。

- [ ] **6.1 扩展共享 API 与 preload 合同**
  - 依赖：1.3、3.3
  - 文件候选：`src/shared/api.ts`、`electron/preload.ts`、对应 IPC 模块。
  - 完成判据：提供按 session / invocation 查询状态与快照索引的最小 IPC；返回纯可序列化类型，经过 session ownership 检查，不暴露其他会话路径或正文。
- [ ] **6.2 实现设置切换 IPC 和持久化往返**
  - 依赖：6.1、1.4
  - 完成判据：开启 / 关闭只写当前会话配置；读取、切换 workDir、重启后值一致；旧 `projectMemoryEnabled` 不被修改。
- [ ] **6.3 实现逐请求状态投影**
  - 依赖：3.5、6.1
  - 完成判据：列表按逻辑 request 顺序显示路径范围、摘要 / 版本、加载状态、加载时间及来源 tool / approval；丢失正文能表达“不可还原”，不显示成当前磁盘内容。
- [ ] **6.4 更新会话项目上下文 UI**
  - 依赖：6.2、6.3
  - 完成判据：开关默认开启且文案明确独立于项目记忆开关；区分“开关下次 invocation 生效”和“文件新版本下次 provider 请求生效”；能展开查看选定请求的只读规则快照。
- [ ] **6.5 补齐加载 / 失败 / 新版本提示与 i18n**
  - 依赖：6.4
  - 完成判据：未发现、空文件、禁用、加载、失败、超限、新版本待下次请求等状态在 zh-CN / en-US key 对齐，无新增硬编码文案。
- [ ] **6.6 远程 IM 状态退化呈现**
  - 依赖：4.4、6.3
  - 完成判据：Feishu / WeChat 的可见状态在文件未加载或读取失败时告知本请求未采用指令；无需发送整份正文或新增消息正文日志。
- [ ] **6.7 UI / IPC 定向验证**
  - 依赖：6.2–6.6
  - 完成判据：多会话隔离、切换状态、缺失正文、禁用、下一请求刷新提示测试通过；运行 i18n check 与 renderer typecheck。
- [ ] **6.8 阶段提交**
  - 依赖：6.7
  - 完成判据：阶段 UI / IPC 代码和测试独立提交，记录 SHA。

### 阶段 7：各入口一致性与最终行为矩阵

**阶段完成条件：** 所有运行入口调用共同宿主策略，不能有未加载 / 重复加载 / 缓存串目录的旁路。

- [ ] **7.1 逐入口清点与测试**
  - 依赖：4.8、5.6、6.8
  - 完成判据：逐项核验 desktop、Feishu、WeChat、automation、hosted handoff；每条入口 provider 请求都能关联同一请求快照合同。
- [ ] **7.2 验证会话 workDir 与活动目录竞争**
  - 依赖：7.1
  - 完成判据：双 session / 双工作目录并行，入队期间 active profile 改变，调用启动时仍按 session effectiveWorkDir 装配；无全局单例缓存串用。
- [ ] **7.3 验证快照历史、压缩与重启只读行为**
  - 依赖：3.5、7.1
  - 完成判据：同 invocation R1/R2 不同版本，context compaction 后当前规则不累加；重启可查看已持久化请求快照但未完成 invocation 仍 interrupted。
- [ ] **7.4 验证信任 / 日志隐私**
  - 依赖：7.1
  - 完成判据：恶意指令文本不能放宽工具权限或审批；日志无正文、secret、原始敏感路径；读取 AGENTS 不新增 grants。
- [ ] **7.5 发布说明和行为边界**
  - 依赖：7.1–7.4
  - 完成判据：明确根文件支持、不支持子目录；请求级刷新语义；开关生效时点；失败降级；历史可查看不代表重启后续跑。

### 阶段 8：最终验收与关闭

**阶段完成条件：** 自动门禁、全量验证、SDK 边界、打包闭包与文档均通过；所有任务状态已结清。

- [ ] **8.1 对照需求逐条关闭 FR / A 编号**
  - 依赖：阶段 1–7
  - 完成判据：建立需求 FR-01–06、A01–A19 到实现 / 测试文件的追踪矩阵；每项有 PASS / 不适用依据，不留未解释空项。
- [ ] **8.2 执行 agent-sdk 边界与依赖门禁**
  - 依赖：8.1
  - 命令：`npm run check:agent-sdk`
  - 完成判据：入口、依赖和 package closure 全通过；若为满足能力而试图引入文件系统依赖，退回宿主边界修正。
- [ ] **8.3 执行最终类型 / i18n / 全量测试**
  - 依赖：8.1、8.2
  - 命令：按实际触及范围运行 `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`，提交前 `npm test`。
  - 完成判据：全量测试通过；已有无关失败记录基线、归因与处置，不把未运行标成通过。
- [ ] **8.4 完整构建和打包闭包**
  - 依赖：8.3
  - 命令：最终验收 `npm run build`；若阶段只改 electron，阶段中间最多一次 `npm run build:electron:incremental`。
  - 完成判据：renderer、electron、tray 全构建成功；SDK package closure 检查通过。
- [ ] **8.5 更新本计划执行状态与验收记录**
  - 依赖：8.2–8.4
  - 完成判据：所有任务改为 `[x]` / `[-]`，记录命令、摘要结果、阶段 commit；记录真实 IM / 三平台真机项是否完成或明确不在本轮发布范围。

## 5. 阶段依赖及提交边界

| 阶段 | 主要交付 | 必须先完成 | 建议提交边界 |
| --- | --- | --- | --- |
| 0 | 路径、请求边界与 History 设计基线 | 无 | `docs(develop): define AGENTS request-boundary implementation baseline` |
| 1 | 会话开关与共享类型 / 存储 | 0 | `feat: persist per-session AGENTS.md setting` |
| 2 | 宿主根文件读取器与正常并发编辑兼容测试 | 0、1.1 | `feat: load workdir AGENTS.md safely` |
| 3 | 请求级快照 History 与只读重建 | 0 | `feat: persist request-scoped project instruction snapshots` |
| 4 | prompt/request assembly 与通用入口接线 | 1、2、3 | `feat: inject AGENTS.md per logical model request` |
| 5 | switch barrier、每工具最终派发 binding 校验与 grant revalidation | 4 | `fix: preserve workdir boundaries for instruction snapshots` |
| 6 | 状态 IPC、开关 UI、逐请求历史 | 1、3、4 | `feat: expose AGENTS.md request status` |
| 7 | 跨入口 / 边界 / 发布说明验收 | 4、5、6 | `test: verify AGENTS.md behavior across agent lanes` |
| 8 | 门禁、全量测试和最终构建 | 7 | `chore: complete AGENTS.md support acceptance` |

> 若阶段 0 证明 SDK 通用 History / 上下文接口无法承载逐请求刷新或快照关联，不得直接扩大 SDK 范围。先将缺口、最小中立契约、向后兼容策略及测试影响写成设计补充，经评审后再调整阶段 3 / 4。

## 6. 验收命令速查

- SDK 边界：`npm run check:agent-sdk`
- 共享类型：`npm run typecheck:shared`
- 渲染类型：`npm run typecheck:renderer`
- 国际化：`npm run i18n:check`
- 定向测试：`npm exec vitest run <本阶段受影响测试文件...>`
- electron 中间构建：`npm run build:electron:incremental`
- 阶段收尾 / 提交前全量测试：`npm test`
- 最终完整构建：`npm run build`

定向测试按阶段合并执行；不得每改一个任务运行全量测试。任何新增测试须绑定需求场景或跨模块不变量，不能只重复 loader 的单元返回值。文件读取测试针对正常并发编辑和基础路径边界，不扩展为恶意本地程序路径替换对抗测试。
