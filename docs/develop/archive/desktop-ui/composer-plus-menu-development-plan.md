# 输入框加号菜单与目录上下文授权 — 开发计划

> 文档日期：2026-10-03
> 需求依据：[composer-plus-menu-requirement.md](../requirement/composer-plus-menu-requirement.md)（版本 1.0）
> 文档性质：分阶段实施计划（任务拆分、完成判据、验收映射）
> 目标交付：加号菜单、既有图片入口迁移、会话级目录上下文授权与撤销、安全策略接入、用户主动压缩入口、i18n 与可回归验收。

## 0. 执行规则

- 每个 task 有独立完成判据；全部勾选并附证据才算完成。代码已写但安全边界或持久化判据未通过，任务仍未完成。
- 阶段 Gate 全部满足后才能进入下一阶段。Gate 记录执行命令、结果摘要及相关提交号。
- 任务中的测试是实施要求；测试/构建命令由执行阶段运行，本计划制定阶段不运行测试。
- 先核对下方列出的候选文件是否仍是当前职责归属；若实现已迁移，任务需更新到真实文件，不得因路径变化漏掉行为或消费方。
- 所有可见文案通过 `src/renderer/i18n/resources/{zh-CN,en-US}/` 维护，并按项目流程更新 i18n 类型/校验。
- 安全失败默认拒绝。目录选择只证明用户选定了一个范围，不自动批准该范围内的所有动作。

### 完成记录格式

每个任务末尾可记录：`完成者 / 日期 / 提交号 / 验证命令及结果`。遇到阻塞时记录阻塞原因、影响需求和解除条件，不把未完成项勾选。

## 1. 范围与需求映射

| 需求 | 本计划阶段 |
|---|---|
| G1、AC1：加号打开可访问菜单 | P3 |
| G2、AC2：图片原行为迁移且不回归 | P3 |
| G3、AC3-AC7：会话目录列表、额外路径访问、安全撤销、隔离和审计 | P1-P2、P3 |
| G4、AC8-AC10：主动压缩与状态结果 | P4，最终合并验收在 P5 |
| i18n、失败提示、完整交互验收 | P3、P5 |

## 2. 现状基线与关键约束

实施前确认并更新以下基线，避免计划与代码漂移：

| 关注点 | 已知入口/模块 | 计划约束 |
|---|---|---|
| 图片加号 | `src/renderer/components/Chat/MessageInput.tsx`；现有附件 state/service 与 `MessageInput.test.tsx` | 只改变入口触发方式；既有选择、暂存、数量上限、预览/移除和发送协议保持。 |
| 目录选择 | `electron/ipc/desktopIpc.ts` 的 `dialog:select-directory`；`electron/preload.ts` 暴露 `dialogSelectDirectory` | 复用原生选择器并校验 IPC 调用方/返回值；返回路径不等于授权凭据。 |
| 路径安全 | `electron/confirmation/` 的路径事实、策略判定、read permit 与执行边界 | 新增授权数据必须贯穿事实分类、策略、permit、执行复核及审计；不能只注入 prompt 或放宽通用 outside-workdir 规则。 |
| 会话状态 | `src/shared/domainTypes.ts`、会话存储/事件投影、Renderer session 状态 | 授权绑定 sessionId，持久化并随会话恢复；会话切换不能复用旧授权。 |
| 压缩 | `src/shared/adaptiveCompaction.ts`、`contextCompaction.ts`、压缩事件及 `turnProjectionService.ts` | 需沿现有提交/回放链补齐用户触发入口；不得并行改造压缩算法或跳过原子提交。 |

**设计决策门槛（P0）**：实现前由代码证据确定授权记录的 canonical owner、会话持久化载体、真实路径定义、远程/后台调用上下文如何区分，以及手动压缩可调用的 runtime 边界。若现有安全链不能表达“仅用户选定目录子树可读”，先扩展统一授权模型，不允许通过 Renderer 白名单、prompt 指令、全局自动批准或绕过 permit 来交付。

## 3. 阶段 P0 — 实施基线与契约冻结

### 执行记录（worktree `codex/composer-plus-menu-tdd`）

- 基线：原工作区 HEAD `77cdd469`；原工作区存在 `electron/llmSystemPrompt.ts` 修改及未跟踪计划/需求文件，均未带入或修改。实施文件在独立 worktree。
- P0-T1 符号清单：图片按钮、隐藏 input、`stageFiles`、`MAX_CHAT_IMAGE_ATTACHMENTS`、附件预览/移除/发送均由 `MessageInput.tsx` 持有；图片暂存由 `chatStageImage` IPC 完成，队列重试在 `ChatView`/queue service 消费已存在的 `ChatImageAttachment`。测试仅 `MessageInput.test.tsx` 依赖 `.composer-add-attachment` 和旧 aria label；样式位于 `styles.css`。菜单迁移复用 input 与 handler。
- P0-T2 契约：canonical grant 是 `{ grantId, sessionId, path, realPath, identity(dev,ino,mode), createdAt, source }`，只由主进程原生 picker 创建，存 `Session.metadata.sessionDirectoryGrants`。每次列举、模型 gate 和 executor 均重验 realpath/identity；desktop lane/read、list、grep 才可携带来源；zone 保持 `outside-workdir`，敏感/系统目录拒绝优先，写入/Shell 不消费 grant。撤销从 canonical metadata 删除；会话删除随 metadata 一并删除；替换/消失/权限失败 fail closed；远程/自动化 gate 不注入 grants。路径匹配按 realpath 组件边界，不使用 startsWith 作授权判断。
- P0-T3 现状：已有 `user_compact` adaptive reason 和 committed compaction event replay，触发只在 turn-boundary planner 内部；Renderer 无独立 API。新命令绑定 sessionId/requestId，独占同 session lock；执行/审批中通过活动 turn 与持久化 active turn 拒绝。返回 `committed/no-op/uncompressible/busy/failed/stale`，只写 compaction transaction，不创建 message/turn/tool call；提交前重读会话消息指纹，变化则 stale。
- Gate：P0 代码职责盘点和首轮数据契约已冻结；对应实现/证据见下方各阶段测试与 Gate 记录。

### P0-T1：盘点输入框附件完整链路

**范围：** `MessageInput.tsx`、父组件 props、图片选择/暂存 IPC、附件组件、发送队列/重试与相应测试/i18n。

**完成判据：**

- [ ] 记录加号按钮当前触发的 input ref、文件 accept、选择后处理函数及附件上限常量的真实定义位置。
- [ ] 记录图片附件从选择、暂存、显示/移除到发送与排队重试的状态流，并确认菜单迁移不需要复制一份逻辑。
- [ ] 列出所有直接依赖加号按钮 DOM/class/aria label 的测试、样式和自动化查询。
- [ ] 在计划执行记录中附文件/符号清单，后续 P3 以此清单逐项销项。

### P0-T2：冻结目录授权数据契约及调用边界

**范围：** `domainTypes`、会话创建/恢复/切换、调用上下文构造、文件工具 policy/extractor/permit/executor、审计事件，以及 desktop/remote/scheduled lane。

**完成判据：**

- [ ] 选定唯一 canonical 授权记录结构，至少有稳定 grantId、sessionId、规范化路径、校验后的 real path/identity、创建时间；Renderer 不可自行创建有效 grant。
- [ ] 明确目录授权是持久化还是会话期内存授权。须满足需求的重启恢复语义；启动恢复时重新验证目录存在性、identity 和敏感路径状态，失效授权不恢复为有效。
- [ ] 明确 grant 撤销、会话删除、路径替换/目录身份变化、应用重启、会话切换各自的状态转移与 fail-closed 行为。
- [ ] 明确 desktop session 调用如何取得 grants，且 remote/Feishu、scheduled/background、其他 session 的上下文无法拿到该集合。
- [ ] 明确 canonical/real path containment 算法、大小写/分隔符规则及符号链接处理；不得使用字符串 startsWith 作为子树判定。
- [ ] 明确 system-dir、敏感路径、用户配置拒绝规则优先于选定目录 grant；grant 只提供范围事实，不抹去风险/审批判断。
- [ ] 在计划记录中画出 `选目录 → 主进程 grant → tool path facts → policy → permit → executor revalidation → audit` 数据流，并列出每一跳负责模块。
- [ ] 明确授权目录内 read/list/grep 的范围语义，以及 write/shell 的既有确认语义；无明确契约不进入实现阶段。

### P0-T3：冻结用户主动压缩触发契约

**范围：** renderer → preload/API → main/runtime → compaction planner/transaction → projection。

**完成判据：**

- [ ] 找到并记录现有 `reason: 'user_compact'` 消费点及实际可调用入口；若没有 UI/API 入口，确定其最小新增命令及 owner。
- [ ] 冻结请求参数（sessionId、请求幂等 ID/必要版本边界）和结果联合类型，至少区分 `committed`、`no-op`、`uncompressible`、`busy`、`failed`、`stale`。
- [ ] 明确 busy 判定覆盖生成中、审批等待、工具执行中及已有压缩事务中状态。
- [ ] 明确成功提交如何更新 canonical history、renderer projection、usage/context projection 和 compaction marker；失败时不产生部分提交。
- [ ] 明确当前 session 变化或压缩期间 session 切换时如何防止结果写入错误会话。

### P0-G：契约冻结 Gate

- [ ] P0-T1 至 P0-T3 完成判据全通过。
- [ ] 所有新字段、IPC/API payload 和错误/结果码均有唯一 owner，无“UI 做完后再决定安全语义”的待定项。
- [ ] 已将跨层接口变更清单同步到后续阶段任务。

## 4. 阶段 P1 — 会话级目录授权核心与安全链

### P1-T1：定义目录 grant 类型、规范化和 containment 原语

**范围：** shared 类型/纯函数；建议落在现有 confirmation/path 模块边界内，不在 renderer 自建授权判断。

**完成判据：**

- [ ] grant 类型表达 grantId、sessionId、规范化目标、必要 identity/创建时间和来源 `user-selected-directory`，不携带不必要文件内容。
- [ ] 路径 containment 使用平台感知的 path-relative/realpath 规则，严格处理相等根目录、后代、兄弟目录、`root-prefix-sibling`、`..`、分隔符和大小写差异。
- [ ] 符号链接越界不会因 lexical path 在授权根下而通过；real path 超范围时拒绝。
- [ ] grant 的 sessionId 不匹配时恒为无效；grant 已撤销或 identity 已变化时恒为无效。
- [ ] 为上述每类边界新增单元测试，测试逐项断言允许/拒绝结果，且测试覆盖 Windows 与 POSIX 路径样例（按现有测试平台工具实现）。

### P1-T2：主进程创建/列举/撤销授权 API

**范围：** 新增或扩展 IPC、preload 和 shared API 类型；目录选择对话框仍由主进程持有。

**完成判据：**

- [ ] 新增创建 grant 操作：从原生 picker 结果在主进程校验目录存在、为 directory、取得 canonical/real path 和 identity，再写入绑定 session 的授权存储。
- [ ] Renderer 不能提交任意路径直接获得 grant；API 若接受候选路径，必须由可信主进程选择流程或可验证 picker 返回结果约束，不接受伪造 grantId/path 作为授权。
- [ ] 新增按当前 session 查询目录列表、按 grantId 撤销操作；未知、他 session 或已撤销 grant 的处理有明确幂等结果。
- [ ] dialog 取消返回 canceled 且不写存储；危险/敏感/无效目录返回稳定错误码且不留下半创建记录。
- [ ] 所有 IPC 输入有运行时校验（sessionId/grantId 类型、长度、调用方窗口状态）；API 返回不暴露内部 identity 细节给 UI。
- [ ] preload 与 renderer API 类型保持一致，API contract/type tests 覆盖成功、取消、错误和伪造/越权 session 请求。

### P1-T3：持久化、恢复和会话隔离

**范围：** canonical session storage/event model 与会话生命周期；具体落点由 P0-T2 冻结。

**完成判据：**

- [ ] 目录 grant 与会话记录原子关联并可在应用重启后恢复。
- [ ] 会话加载时只恢复该 session grants；切换 session A → B → A 时 B 无 A 的 grant，A 恢复其有效 grants。
- [ ] 删除会话/显式移除 grant 后，后续工具调用无法消费已移除授权；旧历史事件不能复活撤销记录。
- [ ] 目录 identity/realpath 变化、消失、权限拒绝或启动 revalidation 失败时，grant 标记为无效/移除并向 UI 提供可解释状态，不静默继续授权。
- [ ] 并发添加相同规范化目录结果稳定去重；竞态不产生两个有效 grant 或孤儿记录。
- [ ] 持久化迁移兼容旧 session 数据；旧会话无 grants 时默认空集合。
- [ ] 存储层测试覆盖重启恢复、撤销后重放、删除 session、身份变化和并发重复选择。

### P1-T4：将 grant 接入路径事实与策略决策

**范围：** `electron/confirmation` path probe/classification、`toolCallGate`、policy facts/rules 与审计模型。

**完成判据：**

- [ ] 当前 desktop session 的有效 grant 集合沿调用上下文传入 gate；缺少或错配 session context 时按无 grant 判定。
- [ ] 文件/目录目标在工作目录外但位于某一有效授权根内时，生成可区分的授权来源事实（例如 `user-selected-directory`），并保留原始 outside-workdir 风险 zone，不将其伪装为 workdir-normal。
- [ ] 只有 read/list/grep 等 P0-T2 列明的工具可消费该范围事实；未列入的工具不会因共享 path classifier 自动获得访问权。
- [ ] policy 对用户选定目录内读取按明确规则允许或走现有确认；写入/执行继续走既有确认与风险决策，不因 grant 自动批准。
- [ ] system-dir/sensitive-file/用户 deny 等规则优先于 grant；所有拒绝结果保持现有稳定 error/diagnostic 类别，或新增有类型、有文案映射的类别。
- [ ] 决策审计记录区分 workdir grant 与 user-selected-directory grant，并通过 grantId/脱敏标识追溯；日志不记录文件内容。
- [ ] policy unit tests 覆盖有效范围、无 grant、错误 session、grant 撤销、敏感路径优先、读写行为差异及不同 execution lane。

### P1-T5：read permit 与执行端二次校验

**范围：** `readExecutionPermit`、read executor permit validation、list/read/grep 执行器和 path identity 检查。

**完成判据：**

- [ ] gate 只有在有效 grant 命中时才构造**grant 来源的 permit**；permit 明确绑定 session/request/toolUse、目标 path/identity、scope 与授权 grantId。不得阻止或替代既有 workdir permit、桌面端目录外只读 permit及其他策略来源的 permit。
- [ ] executor 执行前复核 permit、session/request/toolUse 绑定、grant 当前有效、目标仍在授权子树内、identity/realpath 未变化。
- [ ] grant 在 gate 与执行之间被撤销时，不能再以该 grant 来源通过执行端复核；其他独立策略来源是否允许该路径，仍按现有策略重新判定。
- [ ] 目录子树与单文件权限范围匹配现有 permit scope；不能用目录授权读取目录外文件或让 `list_directory` 扩展到未选根目录。
- [ ] grant permit 集成测试证明 symlink 指向授权根外、目标不在授权子树、路径前缀相似等目标不能使用该 grant；最终调用结果按其他现存 policy 来源重新判定。根目录/目标 identity 被替换时，原 grant permit 失效；不得由旧 identity 继续授权。
- [ ] read/list/grep 集成测试证明已选目录内部目标成功进入现有执行器，且原有 permit 防篡改能力未退化。

### P1-T6：调用上下文与 Agent 可发现性

**范围：** 当前会话 prompt/runtime 工具上下文构造、desktop/remote lane 分流。

**完成判据：**

- [ ] 当前 desktop session 的有效目录列表以简洁、结构化方式进入 Agent 上下文，包含可读名称和可用绝对路径，说明这是用户选定的额外上下文范围。
- [ ] 提示明确目录选择不等同于立即扫描、不批准破坏性操作；读写仍使用工具及其安全规则。
- [ ] 移除/失效 grant 后，下一次模型调用上下文不再声明该目录；旧 prompt/cache 不能延长授权有效期。
- [ ] remote/Feishu/计划任务上下文不注入 desktop grants。
- [ ] 序列化/快照 fingerprint 对授权列表变化有正确响应，使新增/撤销能影响下一次模型请求及缓存隔离。
- [ ] prompt/context 构造测试覆盖空列表、多个 grant、撤销、会话切换和远程 lane。

### P1-G：目录授权后端 Gate

- [ ] P1-T1 至 P1-T6 全部完成，测试从纯函数、策略 gate 到 executor integration 覆盖授权链。
- [ ] 通过下列 grant 来源负例：父目录、兄弟目录、`/selected-prefix-other`、选定根内 symlink 越界、撤销后不能再使用该 grant、另一会话/远程调用；这些目标是否最终可访问由既有 policy 独立判定。
- [ ] system/sensitive dir 按既有拒绝规则验证：grant 不得覆盖拒绝，拒绝决策成立且不留有效 grant。
- [ ] 对撤销 grant 后的原路径，断言决策不再包含已撤销 grantId/`user-selected-directory` 来源，并由既有策略重新决策；不得把“无 grant”断言成“绝对拒绝”，除非既有策略本身拒绝。
- [ ] 通过下列正例：当前 desktop session 选择的普通外部目录，其根目录及合法后代 read/list/grep 按冻结策略工作。
- [ ] 所有审计和用户可见失败码有对应说明；任何 fail-open 缺口阻止进入 P2。

## 5. 阶段 P2 — 目录授权 UI 和输入上下文呈现

### P2-T1：会话目录授权 Renderer service/store

**完成判据：**

- [ ] session 切换时从主进程/canonical session 重新读取 grants；不通过残留的全局 store 列表猜测所属 session。
- [ ] 添加成功、取消、拒绝、移除、应用恢复分别映射明确状态；调用失败不会乐观地保留为已授权。
- [ ] 添加/移除操作具备 pending 状态并防止重复 IPC；状态更新按返回的 canonical grant 列表 reconcile。
- [ ] 主进程推送授权失效/撤销事件（若 P0-T2 确定需要）后，renderer 在不刷新页面情况下更新条目与提示。
- [ ] store/service 测试验证 session A/B 切换、异步响应乱序及错误回滚。

### P2-T2：选择目录和目录条目组件

**完成判据：**

- [ ] 目录选择 action 调用主进程原生 picker/grant API；canceled 无 toast、无状态变化。
- [ ] 已授权目录条目显示 basename；完整路径可通过 tooltip/可访问详情查看，长路径在窄窗口不会撑破输入框。
- [ ] 多个目录可同时呈现并有稳定排序；重复路径不出现重复 chip。
- [ ] 每项有可访问的移除按钮，aria label 含目录名称；移除中防重复点击，成功后列表即时与主进程状态一致。
- [ ] 授权失效条目使用明确失效状态，不以有效样式展示，也不会继续发送到 runtime。
- [ ] 与图片附件条目视觉区分，布局在输入区多行、高附件数和窄宽度下可用。

### P2-T3：授权失败、撤销和状态文案

**完成判据：**

- [ ] 目录不存在/类型错误、系统/敏感目录拒绝、身份改变、IPC 失败、移除失败各自有用户可理解的提示或状态。
- [ ] 提示不宣称已授权，且不泄漏内部堆栈、策略规则机密或不必要文件内容。
- [ ] 授权范围说明可在 UI 中发现：当前会话、所选目录及子树、非全局工作目录、写入仍受既有确认控制。
- [ ] 错误映射使用稳定 error code 到 i18n 文案，不依赖主进程英文错误字符串做 UI 分支。

### P2-G：目录上下文 UI Gate

- [ ] P2-T1 至 P2-T3 全部通过。
- [ ] 手动验证“选择外部目录 → 显示条目 → 发起调用并确认授权来源 → 移除 → 后续调用不再使用该 grant、按既有策略重新决策”的闭环证据已记录。
- [ ] 重启并恢复原会话后，条目与后端有效 grant 状态相同；另一会话及远程入口没有该条目/授权。

## 6. 阶段 P3 — 加号菜单与图片入口迁移

### P3-T1：加号菜单状态与可访问交互

**范围：** `MessageInput.tsx`、必要子组件、composer 样式和 `MessageInput.test.tsx`。

**完成判据：**

- [ ] 点击加号打开锚定按钮的菜单；菜单项顺序为“选择图片、选择目录、压缩上下文”。P3 阶段压缩能力尚未交付时，第三项明确显示为禁用/未就绪状态，不得显示为可执行或用占位行为冒充压缩。
- [ ] 菜单可由键盘聚焦/方向键或 Tab 导航（遵循组件库模式）、Enter/Space 激活，Escape 和外部点击关闭。
- [ ] 菜单项具备 role/name/aria 状态，焦点可见，禁用原因可由辅助技术读取。
- [ ] 点击任意菜单项后菜单按交互预期关闭；异步目录选择失败时菜单关闭且错误通过可见 toast/status 呈现。
- [ ] Composer 不可用状态按具体操作粒度控制，session 无效不会阻塞图片选择等不需 session 的安全操作（若现有图片约束要求 session 则保持其既有约束）。
- [ ] 单元测试覆盖打开/关闭、Escape、外部点击、键盘激活、菜单项调用和禁用状态。

### P3-T2：既有图片入口迁移

**完成判据：**

- [ ] “选择图片”菜单项触发现有隐藏 input/现有选择 handler；不复制附件暂存实现。
- [ ] 删除加号按钮直接打开文件选择器行为，保留加号 aria label 为菜单触发器语义，并为图片项新增独立 i18n label。
- [ ] 图片 accept 类型、单次多选规则、最大附件数量、已有附件 chip、移除、取消选择和错误路径与迁移前一致。
- [ ] 图片项在附件达到上限时不可触发 picker，并能读到既有上限提示。
- [ ] 定向测试验证选择图片仍将附件送入原附件 state/发送 payload，附件重试/队列路径无变化。

### P3-T3：选择目录菜单接线

**完成判据：**

- [ ] 选择目录菜单项调用 P2 已交付的主进程授权 API，而不是只调用 `dialogSelectDirectory` 并把 path 存在 Renderer。
- [ ] 无会话时该项禁用并呈现原因；目录选择期间按钮/菜单不会重复创建 grant。
- [ ] 取消、重复选择、拒绝、成功和 IPC 失败均与 P2 状态规则一致。
- [ ] 选择成功后目录条目出现在 composer 附近，并绑定当前 session。
- [ ] 组件测试覆盖 action 调用参数的 sessionId、取消 no-op、成功展示与失败反馈。

### P3-T4：中英文 i18n、样式和输入布局

**完成判据：**

- [ ] zh-CN/en-US 均新增菜单标题/菜单项、目录条目与移除 aria label、压缩不可用原因、状态/错误提示所需键。
- [ ] 所有新增可见文案均通过翻译资源读取，无硬编码用户可见文字。
- [ ] 图片提示键迁移后无重复语义/孤儿引用，i18n 类型生成物与资源同步。
- [ ] composer 在窄宽度、目录 chip + 图片附件同时存在、多行输入及运行状态下无溢出/遮挡；加号 focus-visible 样式可见。
- [ ] i18n check、相关组件测试和 renderer typecheck 通过（执行时记录命令及摘要）。

### P3-T5：使用 Impeccable 审查并优化新增界面

**工具/方法：** 使用 [$impeccable](/Users/space/.agents/skills/impeccable/SKILL.md) Skill；界面属于桌面应用操作型（Operate）场景，审查重点是清晰、可扫读、与现有 composer 视觉体系一致，并支持键盘/窄布局。

**范围：** 加号菜单、目录上下文条目及其移除/失效状态、压缩中/结果反馈、与图片附件并存时的输入框布局。保留既有功能、产品文案语义和应用视觉身份，不借此重做不相关界面。

**完成判据：**

- [ ] 在实现审查前按 Impeccable Skill 流程加载项目视觉上下文及对应 Operate 参考，并检查现有 composer 组件、主题 token、CSS/样式作为视觉基线；记录所检查文件和主要规范。
- [ ] 对新增/改动界面完成一次有范围的视觉与交互审查，检查菜单层级/锚点/间距、图标与文案对齐、hover/focus/disabled 状态、颜色对比、目录 chip 与图片附件的区分、失效/处理中/错误反馈以及中文/英文文本长度。
- [ ] 在项目支持的窗口宽度/布局下检查菜单与输入区，覆盖窄窗口、长目录名/路径、目录和图片附件同时存在、输入框多行、会话运行状态；没有遮挡、裁切、横向溢出或菜单脱离锚点的问题。
- [ ] 按审查发现修正新增界面样式，使间距、字体、圆角、颜色、边框、阴影和交互反馈沿用项目既有 token/组件约定；不新增无必要的局部设计变量或影响范围外的视觉改动。
- [ ] 完成一轮修正后复查同一界面状态集合；所有发现的问题已关闭，或在任务记录中逐项写明不修理由和影响（阻断性可访问性/溢出问题不得以此方式豁免）。
- [ ] 记录审查使用的 Skill 流程、检查场景/截图或可复现步骤、发现项及对应修复文件；如果没有截图能力，记录逐项人工检查结果。

> P3-T5 对压缩菜单的审查限于禁用/未就绪呈现；可执行态、进行中态和结果反馈在 P4 实现后由 P4-T3/P5 复查，最终视觉验收不能仅凭 P3 的禁用态完成。

### P3-G：输入菜单与图片迁移 Gate

- [ ] P3-T1 至 P3-T5 全部完成。
- [ ] 菜单骨架及图片、目录两项在本阶段范围内的行为有测试或手动证据覆盖；压缩项保持明确禁用/未就绪，不能将压缩功能标记为已验收。
- [ ] 图片旧流程回归清单逐项通过。
- [ ] 不存在第二套图片选择/附件暂存逻辑。
- [ ] Impeccable 审查及优化证据已记录；无未处理的视觉规范、可访问性或响应式布局问题。

## 7. 阶段 P4 — 用户主动压缩上下文

### P4-T1：实现手动压缩 command/service

**范围：** P0-T3 冻结的 runtime owner、调用端 API 和现有压缩事务。

**完成判据：**

- [ ] 从当前 session 最新 canonical context 创建一次 `user_compact` 决策，并复用现有 summarize/plan/commit 机制。
- [ ] 手动压缩只提交 context transaction，不新建 user message、invocation、turn 或工具调用。
- [ ] 命令绑定 sessionId 与当前 context/window/boundary fingerprint；执行期间上下文已变化时返回 stale/no-op，不覆盖新内容。
- [ ] 结果严格映射为 committed/no-op/uncompressible/busy/failed/stale 等冻结状态；异常不被误报为成功。
- [ ] 重复请求具备幂等或并发拒绝机制，同一会话最多一个用户压缩事务在途。
- [ ] runtime/service 测试覆盖提交成功、无变化、不可压缩、busy、异常、重复请求及 stale snapshot。

### P4-T2：压缩状态投影与原子提交

**完成判据：**

- [ ] 成功压缩沿现有 `compaction_start/summary/end` 或等价事务记录持久化，只有 committed 记录可影响 replay。
- [ ] renderer 收到成功结果后更新 compaction marker、message projection、context projection/usage；重复事件不重复添加 marker。
- [ ] 失败/中断/崩溃恢复时，不出现半应用摘要；有效历史保持压缩前状态或由 replay 恢复到最后一次完整提交。
- [ ] session 切换期间结果不会投影到新 session；投影事件通过 sessionId/事务 id 校验。
- [ ] 事件 replay/transaction 测试覆盖重复事件、缺失 end、失败 end、重启恢复和连续两次手动压缩。

### P4-T3：composer 手动压缩状态体验

**完成判据：**

- [ ] 菜单压缩项在无 session、运行/审批/工具执行/压缩中及无可压缩上下文时具有准确禁用状态和原因。
- [ ] 点击后立即进入 pending 状态，禁止重复触发；成功/no-op/uncompressible/stale/busy/failed 均显示准确反馈。
- [ ] 成功状态与现有压缩标记一致；不能仅凭 IPC 返回 ok 显示成功，必须要求 committed 结果。
- [ ] 失败保留旧 projection，不移除已有用户消息或改变对话输入框草稿。
- [ ] 提示支持键盘/屏幕阅读器 status 通知，异步完成不要求菜单保持打开。
- [ ] MessageInput/ChatView service tests 覆盖状态门禁、重复点击、各结果提示及 session 切换。
- [ ] 将 P3 菜单中的压缩项从未就绪态接通到 P4-T1 的真实 command；真实提交完成前不解除禁用态。
- [ ] 使用 Impeccable 对压缩项可执行态、处理中态、各结果反馈及键盘/窄布局完成定向视觉复查；修正及验证证据记入 P5-T3。

### P4-G：手动压缩 Gate

- [ ] P4-T1 至 P4-T3 全部完成。
- [ ] 证据证明手动压缩不生成 message/turn/tool call，且成功后 canonical replay 和当前 UI projection 一致。
- [ ] failure/no-op 不产生误导性压缩标记；busy 状态不能并行覆盖上下文。

## 8. 阶段 P5 — 跨链路回归、验收和交付

### P5-T1：目录授权端到端验收矩阵

**完成判据：**

- [ ] 正例：当前 desktop session 选择工作目录外普通目录后，Agent 能识别其路径并通过既有 read/list/grep permit 读取授权范围内目标。
- [ ] 移除后：下一次调用不能取得该 grant 来源的 permit，UI 不再显示有效条目；决策按既有策略重新评估目标路径。
- [ ] session 隔离：A 授权、切到 B 无 A grant；回到 A 恢复有效状态；A/B 事件/存储无交叉。
- [ ] remote/background 隔离：远程、计划任务或后台入口不能消费 desktop session 的目录 grant。
- [ ] 授权来源矩阵：父路径、兄弟路径、前缀相似路径及指向授权根外的 symlink 均不能命中所选目录 grant；随后分别断言最终 policy 决策和审计来源，保留既有目录外只读策略可能作出的独立许可。
- [ ] 必须拒绝矩阵：system/sensitive dir 按既有拒绝规则拒绝，grant 不得覆盖；授权根/目标 identity 变化时旧 grant 失效且不能沿用旧 permit。上述情况均不得留下错误的有效 grant。
- [ ] 写入/执行矩阵：选目录不会绕过写入确认/危险操作规则；用户拒绝后执行器没有副作用。
- [ ] 审计证据可按 session/grant 关联授权来源及决策结果，且不含文件正文。

### P5-T2：加号菜单与图片完整回归

**完成判据：**

- [ ] 手动验证菜单三项的名称、顺序、键盘交互、焦点和关闭行为。
- [ ] 验证 P3 阶段压缩项未就绪状态已由 P4 实际功能替换；点击后确实触发一次 `user_compact` 并呈现准确结果。
- [ ] 图片单张/多张选择、取消、超限、移除、发送、排队/重试符合原行为。
- [ ] 目录多选、重复选择、移除、长路径、窄窗口、session 切换与恢复符合需求。
- [ ] 撤销后按授权来源核验：后续调用不再消费该 grant；若默认桌面目录外只读策略仍允许目标，调用可按该独立策略继续，且审计准确标注来源，不得误报为 grant 已生效或“撤销后绝对禁止访问”。
- [ ] 运行中只有压缩/目录等不允许的操作按策略禁用，其他允许操作状态合理。
- [ ] zh-CN/en-US 下菜单与 toast 无缺键、截断或路径布局破坏。

### P5-T3：全量验证、文档与变更审查

**完成判据：**

- [ ] 相关单测、集成测试、renderer/shared/electron typecheck 和 i18n 检查通过；命令及摘要记录在任务完成记录中。
- [ ] `npm test` 全量通过；失败项保留首个错误、失败用例和必要上下文，不通过无说明地勾选。
- [ ] 审查新增持久化字段/迁移、IPC 校验、策略 precedence、permit 执行端复核、审计脱敏和 session/lane 隔离。
- [ ] 更新需求文档状态/变更记录（若实现期间需求有变），并链接本开发计划；未实现的需求行为列出明确差异。
- [ ] `git diff` 确认无生成文件、凭据、无关格式化和未归属变更。

### P5-G：交付 Gate

- [ ] P5-T1 至 P5-T3 完成。
- [ ] AC1–AC10 每项均有可定位测试或手动验收证据；验收映射表无空项。
- [ ] 安全负例、原图片流程及压缩原子性三类门禁均通过。
- [ ] 交付摘要列出变更范围、验证命令/结果、已知限制和相关提交。

## 9. 建议测试/代码波及面清单

以下为候选清单，P0 阶段按真实实现校正，所有消费点需在任务记录中明确处理：

| 层 | 候选区域 |
|---|---|
| Composer UI | `src/renderer/components/Chat/MessageInput.tsx`、`MessageInput.test.tsx`、composer 样式、`ChatView.tsx`/父级 props |
| i18n | `src/renderer/i18n/resources/zh-CN/`、`en-US/` 及 i18n 类型/校验 |
| API/IPC | `electron/ipc/desktopIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`、对应 IPC tests |
| 会话持久化 | `src/shared/domainTypes.ts`、会话 store/schema/migration、session load/switch/delete 和 canonical replay |
| 安全授权 | `electron/confirmation/extractors/`、`toolCallGate.ts`、policy rules/engine、`readExecutionPermit.ts`、read permit executor、read/list/grep integration |
| Runtime prompt | 调用上下文构造、desktop/remote lane 和 context fingerprint/cache key |
| 压缩 | `src/shared/adaptiveCompaction.ts`、压缩 transaction/events、runtime boundary、`turnProjectionService.ts`、`chatSlice.ts` 与相关 tests |

**波及面核查完成判据：** 对每个新增/修改的 public type、IPC channel、policy fact、error code、i18n key、session 字段、event type 和 CSS selector 执行全仓引用检索；每个命中点被列为修改、兼容或确认无需修改之一，并附理由。

## 11. 本次执行记录（2026-10-03）

### Worktree 与交付范围

- Worktree：`/Users/space/Documents/Develop/SpaceAssistant/.worktrees/composer-plus-menu-tdd`；分支：`codex/composer-plus-menu-tdd`；基线：`77cdd469`。原工作区保留原状；仅将本计划和需求副本带入 worktree。
- 已实现：加号菜单与既有图片暂存流程接线；会话目录 grant 的主进程持久化、revalidation、撤销、desktop 调用上下文、路径事实/policy 来源、read permit 与 executor 复核；用户手动压缩 API、互斥、stale fingerprint、事务/replay marker 与 renderer 结果反馈；中英文文案和类型。
- 关键新增/修改模块：`src/shared/sessionDirectoryGrant.ts`、`electron/sessionDirectoryGrants.ts`、`electron/confirmation/sessionDirectoryGrantMatcher.ts`、`electron/sessionCompactionLock.ts`、`electron/sessionContextCompaction.ts`、`electron/ipc/sessionIpc.ts`、`electron/ipc/agentProtocolIpc.ts`、`electron/runtime/invocationAssembler.ts`、`electron/confirmation/{toolCallGate,readExecutionPermit,readPermitExecutor}.ts`、`src/renderer/components/Chat/{MessageInput,ChatView}.tsx`、`src/shared/{api,turnBoundaryCompaction}.ts`。

### 自动验证

- 10 个受影响测试文件：`npx vitest run electron/confirmation/sessionDirectoryGrantMatcher.test.ts electron/confirmation/toolCallGate.test.ts electron/confirmation/readPermitExecutor.test.ts electron/sessionDirectoryGrants.test.ts electron/sessionCompactionLock.test.ts electron/sessionContextCompaction.test.ts electron/runtime/invocationAssembler.test.ts src/shared/sessionDirectoryGrant.test.ts src/shared/turnBoundaryCompaction.test.ts src/renderer/components/Chat/MessageInput.test.tsx`：**218 tests passed**。
- `npx tsc -p tsconfig.electron.json --noEmit`：通过。
- `npm run typecheck:renderer`：通过。
- `npm run typecheck:shared`：通过。
- `npm run i18n:check`：通过（1181 个中文硬编码命中均在测试，source 为 0）。
- `npm run build:renderer`：通过；Vite 报告既有 ineffective dynamic import 与大 chunk 警告。
- Impeccable detector：`node /Users/space/.agents/skills/impeccable/scripts/detect.mjs --json src/renderer/components/Chat/MessageInput.tsx src/renderer/components/Chat/ChatView.tsx src/renderer/styles.css` 返回 `[]`；`git diff --check` 通过。
- `npm test` 全量在本 worktree 有 4 个失败测试文件、82 failed / 7641 passed / 106 skipped。原工作区基线运行也有 4 个失败文件、82 个失败；并已单独复现 `electron/claudeStreamHandlers.hostedIntegration.test.ts` 中 hosted 快照用例在基线同样失败（断言 false，实际 true）。因此这是已确认的基线问题，未将其归因于本功能。
- `npm run build:electron` 未通过：`check:pi-ai-runtime-closure` 报仓库现有 pi-ai manifest 缺少 `api/anthropic-messages.js`、`utils/transcript.js`（实际列表为空）。Electron TypeScript 独立检查通过。

### 仍需真实应用验收的 Gate

- 当前宿主 Mac 被锁定，桌面自动化返回“Mac is locked”，因此无法启动/操作 Electron 窗口或记录真实截图。P2-G 的重启恢复闭环、P3-T5/P4-T3 的真实窗口窄宽度/中英文布局、P5-T1/T2 的完整桌面与图片交互矩阵仍未取得手工证据，相关复选框和 P5-G 保持未勾选。
- 真实 SQLite 会话 + 已运行 renderer 的 IPC 集成闭环（原生目录 picker、实际 read/list/grep 工具执行、连续两次手动压缩的完整 replay/UI 一致性）仍需在解锁的桌面运行环境执行；当前已由 service、policy、permit、executor、renderer 单测覆盖各层，但不将分层测试冒充端到端证据。
- 需求没有改动；原需求文档状态保持不变。构建输出位于忽略目录 `dist/`，未加入交付变更。

### 评审阻断项复核与修复（2026-10-03）

评审证据见 [`composer-plus-menu-tdd-review-2026-10-03.md`](../review/composer-plus-menu-tdd-review-2026-10-03.md)。三项均经回归测试复现后修复：

- 通用 `session:create` / `session:update` 不再接受 Renderer 写入 `sessionDirectoryGrants`；更新普通 metadata 时保留主进程 canonical grant。测试在 `electron/appIpc.sessionUpdate.test.ts` 覆盖伪造 create/update。
- 手动压缩 checkpoint 为用户和助手内容各保留前后片段，避免只留拼接前缀而截掉较晚决定；若 checkpoint 实际 token 估算未低于被遮蔽消息则返回 `no-op`，且不写事件。`electron/sessionContextCompaction.test.ts` 覆盖 1200 字符之后的关键项和无节省不提交。
- read permit 执行阶段通过 invocation runtime callback 同步查询当前 session canonical grants，并核对 grantId、session、realPath 和 identity；缺失/已撤销时以 `read-directory-grant-revoked` 失败关闭。`electron/confirmation/readPermitExecutor.test.ts` 覆盖 permit 签发后授权撤销；`electron/runtime/invocationAssembler.test.ts` 覆盖数据库中授权移除后的 live revalidation。

修复后验证：相关 11 个测试文件 **232 tests passed**；invocation assembler session grant 动态复核单测通过；Electron、Renderer、Shared 类型检查及 i18n 检查通过。桌面锁屏造成的真实 Electron 手工验收限制仍按上文记录，不因本次代码评审修复而改变。

### 复审阻断项修复（2026-10-03）

复审证据见 [`composer-plus-menu-tdd-rereview-2026-10-03.md`](../review/composer-plus-menu-tdd-rereview-2026-10-03.md)。针对“手动压缩遮蔽历史中段关键内容仍返回 committed”，移除机械截取摘要，改为将所有被遮蔽消息交给当前会话配置模型生成结构化语义摘要，覆盖 task/decisions/pending；摘要不可解析、字段无效、模型调用失败时返回 `failed` 且不提交事务。先用最小 checkpoint 估算节省量，确定无节省可能时不调用模型；实际摘要未节省 token 时返回 `no-op`。新增回归用例把关键决定放在被遮蔽消息的中段，并验证完整输入到达摘要器且关键决定进入提交候选。

验证：`npx vitest run electron/sessionContextSummary.test.ts electron/sessionContextCompaction.test.ts electron/appIpc.sessionUpdate.test.ts electron/confirmation/readPermitExecutor.test.ts electron/runtime/invocationAssembler.test.ts electron/confirmation/toolCallGate.test.ts electron/confirmation/sessionDirectoryGrantMatcher.test.ts electron/sessionDirectoryGrants.test.ts electron/sessionCompactionLock.test.ts src/shared/sessionDirectoryGrant.test.ts src/shared/turnBoundaryCompaction.test.ts src/renderer/components/Chat/MessageInput.test.tsx`：**12 files passed / 235 tests passed**；`npx tsc -p tsconfig.electron.json --noEmit` 通过；`git diff --check` 通过。

## 10. 主要风险与控制

| 风险 | 后果 | 控制/阻断条件 |
|---|---|---|
| UI 路径被误当授权凭证 | Renderer 可伪造路径绕过主进程安全校验 | grant 只能由主进程创建；executor 复核 permit；P1 Gate 未过不得交付目录能力。 |
| 字符串前缀路径判断 | 可从 `/selected` 越界到 `/selected-secret` | 统一 canonical containment helper；兄弟/前缀负例必须有测试。 |
| grant 来源与既有 outside-workdir 只读授权混淆 | 把“撤销 grant”误解为“路径绝对不可访问”，或误删既有桌面只读能力 | grant 来源单独建模/审计；撤销只移除该来源，后续按现有 policy 重新决策；测试断言来源与决策，不把无 grant 等同于 deny。 |
| grant 范围污染通用 path zone | 选目录意外绕过敏感规则或写入确认 | 保留 outside-workdir 原事实，新增 grant source fact；敏感 deny 和操作风险规则优先。 |
| session/lane 串权 | 其他会话、远程或后台任务得到本地目录访问权 | grant 绑定 session + desktop lane；调用 context 构造和安全 gate 双重检查。 |
| 目录或符号链接在授权后变化 | 授权被转移到新目标 | 保存并复核 realpath/identity；变化立即 fail closed。 |
| 手动压缩绕开事务 | 崩溃/失败破坏历史或 UI 与 canonical 状态不一致 | 复用现有事务和 replay；仅 committed 事件更新投影。 |
| 旧加号测试依赖 DOM 细节 | 菜单迁移造成大量脆弱测试/样式回归 | P0-T1 先列消费者，P3 按清单迁移语义断言。 |
