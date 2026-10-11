# 远程 IM 同步确认码统一为两位十进制编号：详细修改计划

> 状态：实现完成；相关测试通过，全量测试有既有失败项（见实施记录）
> 日期：2026-10-11
> 目标：将飞书/微信同步工具确认提示中的 4 位 Crockford Base32 确认码改为 `00`–`99` 两位十进制确认码，并与异步待办追认使用相同的用户可见编号格式。同步确认码在确认结算或超时时立即释放并允许复用。
> 实施原则：TDD；先写失败测试锁定协议、分配器和释放边界，再改生产代码，并在本计划中记录验收结果。

## 1. 背景与问题

当前远程 IM 有两种用户可见的确认编号格式：

1. 同步工具确认（`Y <确认码>`、`N <确认码>`、`Y <确认码> TRUST`、`记N <确认码>`）目前使用 4 位 Crockford Base32。
2. 异步待办追认使用“批准/拒绝 + 最多两位十进制编号”，并在同一个身份作用域内永久不复用，最多保留 100 个历史编号。

这导致用户面对同一条 IM 安全确认流程时需要区分两套编号形态。用户要求统一为两位数字。同步确认是短生命周期的活动项，不应套用异步待办的“永久不复用”生命周期：编号仅需在待确认期间唯一，拒绝、批准、取消、发送失败、超时等终态结算时释放，以便之后复用。

当前实现还在两处各自定义了 `ConfirmIdSpace`：

- `packages/agent-sdk/src/runtime/components.ts`
- `electron/remote/confirmId.ts`

Electron 的默认 runtime 使用 SDK 的确认码空间；宿主侧类仍被测试及部分 runtime 组合直接引用。两份实现必须保持同一协议，不能只改一处。

## 2. 目标与明确边界

### 2.1 目标

- 同步确认的人类可读码严格为两位 ASCII 十进制字符串，范围 `00`–`99`，保留前导零。
- 同一活动确认码空间中，所有尚未结算的同步确认码互不重复。
- 码在待确认终态结算或超时路径中释放；释放后可以再次分配。
- 所有 100 个码都处于活动状态时，新增确认 fail closed：不发送确认提示、不派发工具、不回退成无确认放行，并产生可诊断的容量失败结果。
- 飞书、微信共享相同格式、解析器和提示文案。
- 异步待办追认也维持两位十进制用户可见格式，但仍保留自己的永久唯一分配、存储、生命周期和授权边界。
- 即使同步确认码与异步待办编号字面相同，命令语法和解析入口也必须保持隔离，不能互相批准。

### 2.2 不在范围内

- 不改变谁可以回答确认、owner/私聊校验、权限 generation 校验、授权提交事务、确认 TTL、记忆档位、trust 规则或工具派发逻辑。
- 不将同步确认编号持久化为永久不复用编号，也不引入数据库迁移。
- 不允许裸 `Y/N`、裸“批准/拒绝”或缺码命令生效。
- 不把 `PendingRequestRegistry` 内部 UUID（`entry.id`）、requestId、toolUseId、turnId 或 sessionId 替换为两位数字；只有同步 IM pending 上供用户回复的短码字段使用两位数字。日志/审计中的同名 `confirmId` 字段须按各自 schema 语义核对，不能机械替换。
- 不合并同步确认与异步待办的命令、状态机、授权范围或 resolver。

## 3. 现状代码与责任边界

| 责任 | 当前位置 | 修改关注点 |
|---|---|---|
| Agent SDK 活动码池 | `packages/agent-sdk/src/runtime/components.ts` | 随机四字符 Base32、活动集合、带分配身份的租约释放/耗尽语义 |
| Electron 确认码兼容包装 | `electron/remote/confirmId.ts` | 宿主 runtime 转发及宿主类的租约协议一致性 |
| 生产 runtime 组合 | `electron/runtime/desktopAgentRuntime.ts`、`packages/agent-sdk/src/runtime/createAgentRuntime.ts` | 确认码池实例仍按 runtime 隔离 |
| IM pending 注册/释放 | `electron/confirmation/imChannel.ts` | pending 持有不可伪造的分配租约；所有终态经单一结算入口释放，迟到回调不得修改已结算请求 |
| IM 回复 parser/footer | `electron/remote/imConfirmReply.ts` | 4 位正则、语法提示、prompt footer、记忆档位命令 |
| 微信适配 | `electron/wechat/weChatImChannel.ts` | 复用共享 parser/footer；验证真实出站文案与入站解析 |
| 飞书适配 | `electron/feishu/feishuImChannel.ts` | 复用共享 parser/footer；验证真实出站文案与入站解析 |
| 飞书提示消息绑定 | `electron/feishu/feishuReply.ts`、`electron/feishu/feishuRemoteOutbound.ts` | 从发送 API 响应取回确认提示 message_id 并回传给 pending |
| 微信提示消息绑定 | `electron/wechat/weChatRemoteOutbound.ts`、`electron/wechat/weChatReplyService.ts`、`electron/wechat/weChatImChannel.ts` | 使用可返回消息 ID 的发送调用并将 ID 回传给 pending；不得以 void 成功代替绑定 |
| 异步追认编号 | `electron/remote/*` 中 async approval/todo/notification 模块；设计见 `docs/develop/remote-im-async-interaction-design.md` | 保留永久唯一、最多两位十进制、耗尽 fail closed 的既定语义；只核验格式与同步协议一致 |
| 操作日志 | `electron/confirmation/imChannel.ts` 及通道 logger | 区分 pending UUID 与用户可见数字码，避免字段名误读或将活动码写入日志 |

需要在实施前用 `rg` 再确认本表的所有调用点，特别是 `ConfirmIdSpace` 的 SDK 导出、测试夹具、runtime 注入和任何不是 `ImChannel` 的消费者。

## 4. 协议与状态契约

### 4.1 同步确认格式

确认码的唯一规范格式为 `NN`，其中 `N` 是 ASCII 数字 `0`–`9`，且必须恰好两位。示例：`00`、`07`、`42`、`99`。

接受的同步命令继续沿用现有语义，仅将 `<确认码>` 替换为 `NN`：

- `Y NN` / `yes NN` / `确认 NN`：仅批准本次。
- `N NN` / `no NN` / `取消 NN`：拒绝本次。
- `Y NN TRUST`：按既有资格规则批准并信任。
- `记K NN`：按既有档位规则批准并选择第 K 档。
- 裸 `Y/N`、裸“确认/取消”、裸“信任”、缺码、1 位或 3 位码：只返回现有 usage hint 或不识别，不消费任何 pending。

大小写容错仍只作用于命令文字；数字码本身不进行大小写或 Unicode 数字归一。全角数字、阿拉伯-印度数字及其它 Unicode 数字不属于协议码，除非另有明确产品决定。

### 4.2 分配、并发和复用

- 每个 `ConfirmIdSpace` 实例管理一个活动码集合；runtime 生命周期与当前实现一致。
- 分配器从 `00`–`99` 中选取未占用码；终态释放后该码立即回到可分配池（不保证下一次请求一定抽到同一个码）。策略可以是加密随机起点后完整扫描，或等价的无偏选择，但必须确保在任意活动项数量下不会因随机碰撞而提前报告耗尽。
- 成功分配后立即登记占用，先于 pending 对外可见/发送 prompt。
- 100 个码均占用时，返回明确的 exhausted 结果（或抛出稳定、可识别的 exhausted 错误，实施时选定单一约定）。不得返回重复码、溢出码或退回 4 位码。
- 终态释放必须幂等。批准、拒绝、超时、取消、prompt 发送失败、预检失败、提交无法继续、通道关闭等所有终态都必须释放。
- 仅发送调用 fulfilled 但仍在等待用户答复时不能释放。prompt 出站成功不代表确认结束。
- 每条 pending 同时保留现有内部 UUID/owner/request/session/tool 绑定，并持有本次分配产生的不可伪造 `ConfirmCodeLease`（至少包含 `code` 与唯一 allocation token）。两位数字只是同步 IM pending 的查找码，不承担身份认证。
- 两位码只用于先定位候选 pending；批准/拒绝必须再绑定到当前确认提示。飞书使用 `replyToMessageId === pending.promptMessageId`。微信 iLink 2.2.0 的 `RefMessage` 没有承诺提供引用消息 ID，故使用每条提示独立随机生成、不可见地附加到提示正文的引用标记，并要求入站 `ref_msg.message_item.text_item.text` 原样包含该标记。仅同一 owner、相同 channel、相同 generation 或仍在 TTL 内都不能替代该消息绑定。
- 飞书 prompt 发送成功必须返回平台确认提示的真实 message ID，并写入该 pending。微信发送成功以 `/sendmessage` 成功响应为准，不等待 `getupdates` 的 BOT 回显；每条提示附带独立引用标记，入站引用文本必须匹配该标记。若发送结果不确定或无法保存绑定，按 fail closed 处理：该 pending 不可由回复批准，终态释放其租约，并向用户/日志报告安全失败。发送调用已成功但没有 SDK 文档保证的 BOT 回显，不是发送失败，不应重发提示。
- pending 在 prompt send Promise 完成前处于 `sending` 状态；此时到达的任何确认都不消费 pending。回复必须带有当前平台对应的可信引用绑定（飞书消息 ID 或微信引用正文标记）；尚未写入 pending 前拒绝并提示稍后引用确认卡片重试。不得缓存无绑定的 `Y NN`/`N NN` 供稍后自动执行。
- 释放接口接受租约而非字符串码：`release(lease)` 仅当活动表中该 code 当前仍对应相同 allocation token 时才删除。禁止通过 `release(code)` 删除当前占用。旧租约重复释放或在同码已分配给新请求后释放，均为无操作。

### 4.3 异步待办隔离

- 异步待办的编号仍按 `channel + identityKey` 及既定持久化记录分配，永久不复用，最多 100 个历史编号；耗尽行为维持 fail closed。
- 异步命令仍为 `批准 NN` / `拒绝 NN`（按当前解析规范），同步命令仍为 `Y NN`、`N NN` 等。
- 两种编号可以出现相同的两位字符串；解析器必须按命令语法和入口选择命名空间，不能以数字码本身跨命名空间查找。
- 不以此次同步码实现为理由修改 async todo schema、notificationVersion、checkpoint、owner 绑定、恢复或撤销契约。

## 5. TDD 实施阶段

### 阶段 0：基线与调用点盘点

- [x] 记录当前分支、worktree、`git status --short`，明确既有未提交变更，避免覆盖其它工作。
- [x] 搜索 SDK 与 Electron 中所有 `ConfirmIdSpace`、`allocateConfirmId`、`releaseConfirmId`、`isConfirmIdInUse`、解析器和提示格式化调用点。
- [x] 阅读 `PendingRequestRegistry` 的 timeout/resolve 时序，画出注册、发送、结算、释放顺序；确认 callback 是否可能重复或重入。
- [x] 搜索异步追认分配器和 parser 的真实调用点，记录其持久化和耗尽行为，确保修改不触碰该状态机。
- [x] 运行分配器、parser、IM channel、Feishu/WeChat channel 与 runtime 的基线测试，记录基线通过/失败。

### 阶段 1：分配器 RED/GREEN

#### RED：Agent SDK 与 Electron 合约测试

- [x] 分配结果只匹配 `/^\d{2}$/`，覆盖边界 `00` 和 `99`。
- [x] 同一实例连续分配的所有活动码唯一；两个实例状态隔离。
- [x] `release(lease)` 后该码可再次分配；重复释放租约不破坏池状态。
- [x] 分配 A 得到码 `NN`，释放 A 后分配 B 再得到 `NN`；迟到的 `release(A.lease)` 不释放 B，`isInUse(NN)` 仍为 true，第三次分配不能拿到 `NN`。
- [x] 将 100 个码全部占用后，第 101 次分配给出稳定 exhausted 结果；不产生重复值。
- [x] 释放一个活动码后，之前 exhausted 的池可以重新分配。
- [x] 证明分配器不会因重试次数或碰撞随机性而在存在空闲码时错误报告 exhausted。
- [x] `clear()` 清除活动集合，后续可完整分配 100 個码。
- [x] 宿主侧 `ConfirmIdSpace` 与 SDK 实现满足同一表驱动合约，避免实现漂移。

#### GREEN：实现

- [x] 将 SDK 与 Electron 两份实现统一为两位十进制池；优先提取单一实现并通过现有类型接口复用，若依赖边界不允许提取，则至少通过同一共享测试合约约束两份实现。
- [x] 使用完整有限域分配算法，保证空闲码存在时必能找到；将耗尽映射为明确、可区分的失败。
- [x] 保留 runtime 级实例隔离；将 `allocate` 改为返回租约，`release` 只接受租约；所有 `release(code)` 调用点迁移，不能保留有删除当前占用能力的字符串兼容重载。
- [x] 移除 Crockford Base32 常量及四字符算法；更新注释和 SDK 文档。

### 阶段 2：Parser 与提示文案 RED/GREEN

#### RED：共享协议测试

- [x] 成功解析 `Y 00`、`yes 07`、`N 99`、`取消 42`、`Y 07 TRUST`、`记1 07`。
- [x] 1 位/3 位/4 位数字、字母数字混排、全角数字、缺码及额外冲突 token 不产生批准/拒绝结果。
- [x] 非确认普通文本仍返回 `not_confirm`，既有 usage hint 语义不回退。
- [x] footer 对 trustEligible true/false、有无 memory tiers 的所有变体只渲染两位占位符/实际码；档位序号和确认码不混淆。
- [x] usage hint 与 trust misclick 提示包含两位数字格式示例或占位符，不再描述字母数字码。
- [x] Feishu/WeChat 的 builder 实际产生两位码提示；两边通过同一 parser 接受格式。

#### GREEN：实现

- [x] 将 `CONFIRM_ID_RE` 从 4 位 Crockford 约束改成严格两位 ASCII 十进制。
- [x] 更新 `imConfirmReply.ts` 协议注释、帮助提示和 footer 示例。
- [x] 更新 Feishu/WeChat channel tests 和所有 `AB12` fixture 为 `00`–`99` 数值字符串。
- [x] 检查“记N”命令，保证 N 仍代表 memory tier 序号，后续 NN 才是确认码。

### 阶段 3：IM 生命周期释放和池耗尽 fail closed

#### RED：ImChannel 集成测试

- [x] 建立两个同时待确认项，码不同；按码答复一个，只释放对应活动码，另一个仍可等待。
- [x] 批准/拒绝后可重用已释放码。
- [x] timeout、cancel、cancelByRequestId、cancelByChannel、prompt send reject、prompt preflight failure、同步抛错、commit failure/unavailable 等路径都释放码。
- [x] sendPrompt fulfilled 但未收到答复时码保持占用；等待自然 timeout 后才释放。
- [x] 注入 100 个活动码，下一条 request 不发送 prompt、不派发工具，并以明确 unavailable/exhausted 失败结束；已存在的 100 项仍可正常回答和结算。
- [x] 在任意失败前不留下 registry pending、码占用、记忆选择或授权提交残留。
- [x] 旧回复隔离：A 持码 `NN` 且提示消息 ID 为 `msg-A`；A 结束/超时后 B 复用 `NN`、提示 ID 为 `msg-B`；引用 `msg-A` 的 `Y NN`、未引用任何消息的 `Y NN`、引用普通消息的 `Y NN` 和重复的旧拒绝都不能批准/拒绝 B；只有引用 `msg-B` 的正确 owner 回复可结算 B。对 approve、deny、TRUST、memory tier 分支及微信/飞书分别覆盖。
- [x] 发送绑定时序：提示发送 Promise 未返回期间的回复不能结算；提示 API 返回 ID 后，用户引用该 ID 的新回复可正常结算。发送结果缺少 ID 或结果不确定时 fail closed，不接受任何无绑定回复。
- [x] 旧发送回调租约竞态：A 结束并释放，B 立即复用同一码；此后 A 的 send reject / not-attempted / timeout 回调不能释放 B 租约、删除 B pending/记忆状态、写入影响 B 的 `promptSendFailures` 或改变 B 结果；C 仍不能取得 B 的码，B 可独立正常结算。
- [x] 执行竞态测试：timeout 与 inbound 同轮竞争、重复 resolve、取消后迟到回复，不得释放另一 pending 的码或误批准；所有 callback 先校验 entry 的 settlement ownership，非首次终态结算不得产生副作用。

#### GREEN：实现

- [x] 在 `ImChannel.request()` 中捕获 exhausted 结果并转换为安全失败；不要让同步 throw 越过 confirmation adapter，也不要将它解释成 approve。
- [x] 明确 pending 注册失败与码分配成功之间的回滚规则。
- [x] 收敛释放责任：每个 pending 仅由统一、原子的一次性 `settle(entryId, outcome)` 终态入口释放它持有的租约；注册前失败由仍持有本地租约的创建流程释放。删除 timeout、send Promise、resolve 等分支中的裸 `release(code)`。
- [x] pending 具备明确的 `settled`/settlement ownership 状态；只有首次成功从 pending 转为 terminal 的调用可以改写结果、记忆选择、`pendingMemory`、`promptSendFailures`、日志终态和码池。send Promise 的 reject/fulfilled/not-attempted 回调在发现 entry 已 terminal 后只能退出（可发不改变状态的诊断日志）。
- [x] timeout callback 与主动 resolve 双重触发时，只有一个调用取得 settlement ownership；第二个调用是无副作用 no-op，租约至多释放一次。
- [x] 成功提示发送流程将真实出站消息 ID 绑定到仍处于 sending 的同一 entry；若 entry 已先行 terminal，迟到的成功回调不得重建 pending 或覆盖结果。
- [x] 诊断事件明确区分内部 pending UUID 与人类确认码；生产日志不记录可直接回复使用的两位活动码。若现有事件字段兼容要求保留，新增/重命名字段需同步检查日志消费端。

### 阶段 4：异步协议隔离回归

- [x] 对 async todo 编号模块运行既有完整测试，证明两位分配、永久不复用、每 identity 的 100 个历史上限、通知重发新版本、旧版失效与耗尽 fail closed 不变。
- [x] 新增明确的交叉命名空间用例：同一字符串 `07` 可分别存在于一条同步确认和一个异步待办；`Y 07` 只会解析同步确认，`批准 07` 只会进入 async todo resolver。
- [x] 验证未授权用户、错误 channel/identity、过期确认码、过期 todo 编号都不能因两种码格式相同而交叉命中。
- [x] 更新 `docs/develop/remote-im-async-interaction-design.md` 的措辞：两位数字是共同的人类可读格式；“永久不复用/100 历史上限”仅适用于异步追认编号，而不是同步确认码。
- [x] 更新旧设计文档 `docs/develop/b344321-current-code-refactor-plan.md` 中同步确认 4 位 Crockford Base32 的过时条款，标注由本计划替代，避免文档继续给出相反契约。

### 阶段 5：回归、类型与集成验证

- [x] 聚焦运行：Agent SDK confirmId 合约、Electron runtime confirmId、IM parser、ImChannel、Feishu channel、WeChat channel、async approval/todo parser 与 integration tests。
- [x] 运行 `npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run build:electron:incremental` 或仓库当前等价的 Electron 类型检查。
- [x] 运行 `npm run i18n:check`（若文案修改涉及本地化）。
- [x] 按用户要求/目标计划运行全量 `npm test`；记录失败用例、首个错误及相关调用栈，不将基线失败归因于本次变更。
- [x] 运行 `git diff --check`；审阅最终 diff，确认没有修改消息身份、owner 授权、async todo persistence 或无关用户数据。
- [x] 自动化集成验收：WeChat 和 Feishu adapter 测试断言提示码为两位数字、发送后保存平台消息 ID 或协议支持的引用正文标记、只能由正确 owner/channel 引用该提示确认；ImChannel 并发测试覆盖 100 个活动项、池耗尽 fail closed、终态后复用及仅正确引用可批准。

实机收发验证需要已登录的微信/飞书账号；本次只运行自动化 adapter/集成测试，没有向真实 IM 账号发送测试消息。

## 6. 主要文件清单（预计）

### 生产代码

- `packages/agent-sdk/src/runtime/components.ts`
- `electron/remote/confirmId.ts`（可能改为导出/转发唯一实现）
- `electron/confirmation/imChannel.ts`
- `electron/remote/imConfirmReply.ts`
- `electron/wechat/weChatImChannel.ts`（若仅复用 parser/footer，可能只需调整测试）
- `electron/feishu/feishuImChannel.ts`（若仅复用 parser/footer，可能只需调整测试）
- async todo 编号 parser/store 中必要的交叉隔离检查点（仅在证实缺少语法隔离测试时新增；不改既有生命周期）

### 测试

- `packages/agent-sdk/test/agentCore.test.ts` 或新增 runtime component test
- Electron `confirmId` 测试（当前需先确认是否有单独测试文件；仓库搜索显示 runtime 与 channel 测试覆盖较多）
- `electron/remote/imConfirmReply.test.ts`
- `electron/confirmation/imChannel.test.ts`
- `electron/wechat/weChatImChannel.test.ts`
- `electron/feishu/feishuImChannel.test.ts`
- async approval/todo allocator、resolver 和 integration tests
- 如涉及公共类型/API，再更新对应 type tests

### 文档

- 新建/维护本计划的实施记录和验收证据。
- 更新 `docs/develop/remote-im-async-interaction-design.md`。
- 更新 `docs/develop/b344321-current-code-refactor-plan.md` 的旧同步码契约。
- 如存在确认协议用户手册/帮助文案，搜索并同步更新所有 `AB12`、Crockford、4 位同步码描述。

## 7. 风险与防护

| 风险 | 防护与验收 |
|---|---|
| 100 个码全部被活动 pending 占用 | 新请求 fail closed；不得覆盖或复用活动码；容量错误可诊断；任意终态及时释放 |
| 释放遗漏造成池耗尽 | 生命周期表驱动测试覆盖所有 pending 终态；统一终态 cleanup；重复释放安全 |
| 旧回复命中新 pending | 短码只选择候选；必须精确匹配该 pending 的可信 prompt message ID。测试覆盖同码复用后引用旧提示、无引用回复及正确引用新提示。owner/channel/generation/TTL 仍须全部校验，但不能替代消息绑定。 |
| 旧发送回调释放新请求的码 | 分配器采用 token 化租约，release 以租约身份比较当前 owner；pending 的异步回调另受一次性 settlement ownership 保护。A 的迟到回调即使持有已过期 lease，也无法改变复用该码的 B。 |
| 平台没有返回可绑定的出站消息 ID | Feishu 有 `data.message_id` 与 `replyToMessageId`；WeChat iLink 不承诺出站消息 ID 或 BOT 回显，但引用结构提供消息正文，因此同步确认用每条提示唯一的引用正文标记匹配。未能从引用正文读回标记时 fail closed。 |
| SDK/Electron 双实现漂移 | 单实现复用，或共享契约测试对两实现运行完全相同的边界矩阵 |
| 同步码与 async todo 同码导致串命名空间 | 命令 verb 与 resolver 隔离；交叉同码测试证明不会跨 resolver 消费 |
| 旧客户端/旧消息仍发送 AB12 | parser 对旧码返回非执行结果与清晰 usage hint；不兼容旧格式是协议升级，不允许把旧格式宽松映射到数字码 |
| 4 位 ID 曾进入日志或 History | 区分内部 ID 与用户可见码；不回写/迁移历史事件；日志不记录可用活动码 |
| 共享 allocator API 被非 IM 消费 | 全调用点盘点后确认行为；如有非 IM 对外协议依赖 4 位格式，单独迁移并增加兼容决策，不能静默更改 |

## 8. 完成标准

- 同步确认提示与 parser 均严格使用 `00`–`99`，不存在生产路径回退生成/接受 4 位 Crockford 码。
- 同一活动码空间中不存在并发重复；确认结束、超时和所有失败终态都会释放；释放码可复用，且旧租约不能释放复用给新 pending 的码。
- 微信、飞书的批准/拒绝都必须引用当前确认提示的稳定关联；飞书匹配消息 ID，微信匹配唯一引用正文标记。同码复用后引用旧提示、无引用或引用其它消息均不能影响新 pending。
- send/timeout 等迟到异步回调无法改变已结算 pending、释放其它请求的租约或污染新请求状态。
- 池耗尽时无提示派发、无工具执行、无自动批准，且 pending/码池状态没有泄漏。
- 异步待办保持永久不复用与 100 个历史编号上限；同步命令和异步命令即使遇到相同数字也不会交叉消费。
- Feishu 与 WeChat 共享协议并各有出站提示及入站回答证据。
- 类型检查、相关测试、i18n 检查和 diff 检查通过；任何不能运行的验收项在交付说明中明确标记。
- 文档不再将同步确认码描述为 4 位 Base32，也不再把 async todo 的永久唯一语义泛化成所有确认码规则。

## 9. 已定安全决策与平台绑定契约

评审报告 `docs/review/2026-10-11-remote-im-sync-confirmation-two-digit-code-plan-review.md` 指出的两项 P1 均作为实施阻断条件处理，以下设计是本计划的强制要求，不留给实现阶段另选：

1. **按当前提示绑定回复**。飞书提示成功发送后保存平台返回的 `messageId`，入站要求 `replyToMessageId === pending.promptMessageId`。微信 iLink SDK 2.2.0 的发送接口只提供成功响应，`sendRaw()` 返回 `void`；其 `RefMessage` 类型包含引用正文但不包含 `message_id`，`getupdates` 也只是入站消息轮询。因此微信不等待假设中的 BOT 回显，而在提示正文中追加每条独立的不可见随机标记，并要求入站引用正文包含该标记。引用缺失、引用其他提示或引用旧提示，一律不能确认。owner、channel、授权 epoch/generation、TTL 与内部 pending UUID 校验仍全部保留。实机确认客户端是否保留该引用正文标记需在本计划的验收记录中单独注明。
2. **同步提示发送适配器返回可信绑定**。`sendPrompt` 成功返回平台消息 ID 或平台支持的引用正文绑定 token（预检失败仍可返回既有 `PromptPreflightFailure`）。Feishu 从 API `data.message_id` 提取 ID；微信以 `/sendmessage` 成功响应确认发送，并使用提示正文里的唯一引用标记绑定后续回复。不得从 void 返回值、客户端生成的 `client_id` 或假定的 poller BOT 回显推断平台消息 ID。
3. **提示发送尚未返回 ID 的竞态**。pending 先注册以保持现有无丢入站窗口，但标记 `sending`。ID 到达并绑定前，不接受任何确认。若用户在此极短窗口内回复且事件先于发送 Promise 完成，返回“确认提示仍在发送，请稍后引用该提示重试”的安全提示，不缓存、不延迟执行此回复。绑定完成后，新的引用回复正常处理。这避免把早到事件在缺少确定目标时错误套用到新 pending。
4. **租约 token 化**。`allocate()` 返回 `{ code, allocationToken }` 的不透明租约；活动池维护 `code -> allocationToken`。唯一释放接口为 `release(lease)`，仅当 token 与该码的当前 token 相同才删除。旧 token、重复释放、伪造 token 都是 no-op；删除所有字符串码释放路径及其兼容重载。pending 保存 lease，不单独保存可用于释放的 code。
5. **一次性结算所有权**。在 `ImChannel` 中由 entry 的原子 terminal transition 确认调用者取得结算权；只有胜出的调用可移除 pending、释放 lease、写入确认/记忆结果或 prompt failure 状态。send Promise、timeout、cancel、inbound 等迟到/重入回调看到 entry 已 terminal 后不得更改任何业务状态。诊断日志不得触发状态写入。

代码依据已更新：锁定 SDK 的 `RefMessage` 类型提供 `message_item`，但没有 `message_id`；poller 只转发 `getupdates.msgs`，不保证包含出站 BOT 回显。飞书继续使用 `replyToMessageId`；微信同步确认使用随机引用正文标记，且只在用户引用内容包含当前 pending 标记时结算。

## 10. 实施记录

- TDD RED：先新增两位码租约和同步 parser 的边界测试。旧实现分别因返回 Crockford 码、无法接受 `00`–`99`、接受 4 位 ID、以及字符串释放无法阻止旧租约释放新占用而失败；修改生产实现后对应测试转绿。
- 分配器：SDK 提供唯一实现，Electron 兼容类继承 SDK；完整扫描 100 个码并返回对象身份租约。旧租约/伪造租约释放为 no-op，耗尽错误固定为 `CONFIRM_ID_SPACE_EXHAUSTED`。
- IM 生命周期：`PendingRequestRegistry` 增加一次性同步终态 hook；ImChannel 仅由终态入口释放 pending 持有的 lease。发送失败、timeout、cancel、重复 resolve 和迟到 send callback 均有测试。日志只包含内部 pending UUID，不记录短码。
- 平台绑定：Feishu reply API 返回 `data.message_id`；WeChat 使用唯一出站 `client_id` 与 SDK 原始 updates 中匹配的 BOT 回显关联服务端 `message_id`，不能读取 void `send()` 的返回值。缺少 ID 均 fail closed。入站仅接受引用 ID 精确匹配当前 prompt 的 owner 回复；prompt ID 返回前拒绝确认并提示稍后引用重试。
- 交叉命名空间：`Y 07` 只匹配同步 resolver，`批准 07` 只匹配异步待办 parser。异步待办的存储、永久不复用及历史容量实现未修改。
- 相关定向测试：最终复跑 14 个文件、302 项通过，覆盖 SDK/runtime、IM 生命周期、Feishu/WeChat adapters、入站 quote parser 与 async approval/todo 命名空间；Feishu 普通发送兼容与确认提示严格 message ID 的新增回归也包含在内。
- 类型与质量检查：Electron TypeScript、Agent SDK TypeScript、`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`、`npm run build:electron:incremental` 和 `git diff --check` 通过。
- 全量 `npm test` 已执行：`Test Files 6 failed | 971 passed | 1 skipped (978)`；`Tests 19 failed | 9072 passed | 111 skipped (9202)`。失败集中在 `src/shared/policy/policyEngine.test.ts`（1）、`electron/appIpc.securityRules.test.ts`（1）、`electron/claudeStreamHandlers.hostedIntegration.test.ts`（浏览器授权断言和资源竞争导致的超时/清理失败）、`electron/confirmation/deferredApprovalCachePolicy.test.ts`（2）及两个期待 schema 版本 80、实际为 82 的既有 migration 测试。重新单独运行完整 async approval/todo 组为 26 文件通过、2 文件 3 项失败（上述 cache policy 与 schema 版本问题）；本计划涉及的 14 文件仍全绿。以上失败未由本次确认码改动的文件引入，本次未修改这些独立问题。

### 2026-10-11 评审修复记录

- P1：锁定 SDK `@wechatbot/wechatbot@2.2.0` 的 `send()` / `sendRaw()` 返回 `Promise<void>`，已删除从发送 Promise 结果提取微信提示 ID 的假设。确认提示通过唯一 `client_id` 发送，从原始 `getupdates` 消息批次匹配收件人一致、`message_type=BOT` 的回显并绑定其服务端 `message_id`；回显无效或 60 秒内未到达则 fail closed，不伪造 ID。服务测试覆盖 SDK void 发送、正确回显关联和无回显失败。未进行真实账号收发验证。
- P2：同步确认 footer、usage/trust 帮助提示明确要求引用当前确认提示。命中活动码但没有引用或引用其他消息时回复纠正提示，待确认项保持活动。微信和飞书分别验证提示与纠正路径。
- 评审修复定向回归：11 个文件、119 项通过；Electron TypeScript 检查与 `git diff --check` 通过。更新了过期的 Feishu timeout 提示，不再建议超时后直接回复 Y。
- 第二轮复审 P1：微信确认提示发送适配器现将 `sendRaw()` fulfilled 与匹配 BOT 回显作为两个独立成功条件；只有两者都成功才返回平台 `messageId`。回显先到只缓存 ID，之后 `sendRaw()` rejected 会立即清理关联并拒绝发送 Promise；超时/失败后的迟到回显无效。
- P1 回归测试先 RED：复现旧行为在回显先到时过早返回 `{ messageId }`，即使随后 `sendRaw()` rejected 也无法撤销。GREEN 后新增 adapter 时序测试和 `WeChatImChannel` 集成测试，证明 sending 阶段不接受审批、失败结果清除 pending、迟到回显不能恢复审批。
- 第二轮复审修复验证：微信与 IM 定向测试 18 个文件、211 项通过；`npx tsc -p tsconfig.electron.json --noEmit` 与 `git diff --check` 通过。未进行真实账号收发验证。

### 2026-10-11 系统性设计整改记录

- 微信发送/回显逻辑从普通 `weChatReplyService` 移到连接级 `WeChatConfirmationPromptAdapter`。协议使用显式 send/binding 双事实与状态（sending、awaiting-send、awaiting-binding、ready、failed、binding-unavailable、timed-out、cancelled）；事件只经同一个 transition 更新事实，唯一 finish 清理入口负责删除关联、清 timer、移除 AbortSignal listener 并解析结果。连接关闭时终止未完成交付并解除 poller listener。
- 平台契约标注为锁定的 `@wechatbot/wechatbot@2.2.0` 私有 poller `messages` 事件读取 `getupdates.msgs` WireMessage，并按 `client_id + to_user_id + BOT` 关联 `message_id`。测试读取安装的真实 SDK package/version、poller/sender 源码与 wire 类型，且用真实 `MessageBuilder` 检查出站字段。**SDK 源码证明 SDK 内部传递能力，不证明生产微信服务器必定返回对应 echo；该 echo 的真实账号样本仍待实机验证。** 无 poller/无法订阅或绑定超时均 fail closed。
- `PromptSendResult` 是判别联合，区分未尝试、send rejected、send fulfilled 但 binding unavailable、send fulfilled 且 binding bound、等待期间仍不确定和取消。结构化 History/diagnostic 通过 `ConfirmOutcome` 与 Agent SDK contract 保留这些事实；binding 超时不会记录为 send rejected。
- `ImChannel` 将 `AbortSignal` 传给发送器，并在 timeout、cancel、授权/通道结算时从统一的 registry terminal hook abort 底层等待；发送 API 本身若不支持 AbortSignal，取消只释放关联/监听/定时器，不声称撤回已发请求。
- TDD 协议矩阵覆盖两种成功事件顺序及等价结果、echo-first send reject、reject 后迟到 echo、重复 echo、send-first binding timeout、send 仍 pending 的超时、cancel、connection close、错误 owner/client/type/message ID；另验证真实 `ImChannel` 的 sending/approval 边界与取消清理。
- 系统性整改当前验证：20 个定向测试文件、244 项通过；Electron、shared、renderer TypeScript 检查与 `git diff --check` 通过。未进行真实微信账号收发，因此平台真实 echo 可靠性仍不是已验证结论，复评的实机证据门槛尚待完成。

### 2026-10-11 第四轮复审 P2 修复记录

- 将 `ConfirmationPromptSendFailure` 改为显式 `state` 判别联合，合法分支固定为 `not-attempted`、`send-rejected`、`send-pending`、`binding-unavailable`，各自约束 `sendCall`、`delivery` 和 `errorCategory` 的组合；共享类型与 Agent SDK 对外契约同步更新。
- 新增 History 边界投影器：当前记录先验证状态及字段组合；旧版无 `state` 的记录只兼容已知合法组合。缺字段、未知状态或矛盾组合进入明确的“发送状态无法判定”回执，不再被压成“未发送”。
- 回执映射使用穷尽 `switch`，并由成功返回、普通失败返回及 Hosted 异常返回共同复用。最终 IM 集成矩阵覆盖未尝试、发送拒绝、发送仍 pending、发送成功但提示绑定不可用；每种情形都检查工具不派发及 History 保留原始状态。测试夹具同步修复为保留所有判别式发送结果，而不把未知结果伪装成成功发送。
- TDD RED：先增加新状态矩阵，原投影器返回空结果/旧事实不能表达新状态；GREEN 后重构 History 转换与文案生成，集成测试通过。
- 本轮验证：7 个定向测试文件、272 项通过；Electron、Agent SDK、shared、renderer 类型检查以及 `git diff --check` 通过。另复跑 MCP 快照装配、延迟工具检索、Hosted 注册表和 `tool_search` 定向测试 5 个文件、99 项通过。
- 全量 `npm test`：`Test Files 6 failed | 973 passed | 1 skipped (980)`，`Tests 19 failed | 9112 passed | 111 skipped (9242)`。失败仍集中在既有 `policyEngine` / `appIpc.securityRules` 断言、`claudeStreamHandlers.hostedIntegration` 浏览器竞争测试超时与清理失败、`deferredApprovalCachePolicy` 两项及两个期待 schema 80、实际 82 的迁移测试；本轮 P2 相关新增矩阵和 IM 集成测试均通过。
- 用户报告通过 `npm run dev` 绑定微信发送消息后收到了正常回复；核对该会话 History，模型实际只调用了 `browser`，被记录为 `POLICY_DENY`，随后以通用知识回复，并未使用 MCP。开发版在 `electron/main.ts` 中将 Electron `userData` 改为独立的 `-dev` 路径；该 dev 数据库没有 `config.mcpServers`，因此装配出的 MCP 快照为空，模型请求包含 14 个内置工具但没有 `tool_search` 或任何 MCP 工具。已安装版数据库则有一个启用的知乎 MCP、4 个启用且缓存的工具。由此定位为本次实机使用的开发版配置隔离，不是这条会话的 MCP 快照组装代码丢失：装配器按当前 dev DB 构建快照；相同代码的装配/延迟检索测试 99 项通过。未从已安装版数据库复制 Profile 或 Secret 到 dev 环境。
- 这次真实微信消息只验证了普通 IM 收发与回复，不包含 MCP 确认卡片，不能作为微信 BOT 回显 message ID 绑定的实机证据。要验证 MCP/确认回执，需要在 dev 配置中单独设置 MCP 并触发一个受确认保护的 MCP 调用；不把已安装版 Secret 搬入 dev DB。
- History 解析还验证了新 `state`、send/delivery 配对及 errorCategory 的组合；未知或矛盾记录稳定降级为状态未知。该额外回归先 RED 后 GREEN。

### 2026-10-11 微信协议根因修正

- 上述早期实现记录关于“通过 getupdates BOT 回显取得确认提示 message_id”的结论已被后续核对撤销。锁定 SDK 2.2.0 的 `MessagePoller` 只是把 `getupdates.msgs` 转成入站 `messages` 事件；`MessageSender.sendRaw()` 等待 `sendmessage` 成功后返回 `void`；SDK 的 `RefMessage` 类型包含 `message_item` 但没有 `message_id`。因此“发送成功但等待回显 60 秒失败”不是连接或发送错误，而是实现要求平台提供未承诺的关联事件。
- 修复不重发已成功的消息。适配器现在以 `sendRaw()` fulfilled 作为发送成功，并在提示正文追加每条独立的不可见随机引用标记；只有 owner 回复所引用的 `ref_msg.message_item.text_item.text` 含有当前标记时才结算。旧提示的标记不同，同码复用后迟到回复不能批准新请求。
- TDD：先增加“无 BOT 回显时仍按 send 成功完成”以及 SDK `RefMessage` 契约测试；再增加 `ref_msg.message_item.text_item.text` 入站解析和旧提示标记隔离测试；最后增加完整 adapter → parser → ImChannel 往返测试。
- 自动化验证通过，但真实微信客户端是否原样保留不可见标记仍需当前 dev 实机确认。若引用正文不含标记，通道会 fail closed，不会错误批准或重发提示。
- 本轮 worktree `npm run dev` 已启动，等待一条需确认的非破坏性命令被引用回复 `N NN`，以实机确认隐藏标记经过微信客户端引用后仍可读回。
