# Agent Runtime 通用触发器执行计划

> 日期：2026-11-01。状态：实施中；P1（T00～T09）已完成，P2（T10～T15 已完成，T16 进行中，T17 已开工但待 T16 收口，T18 待执行）。
> 规格唯一来源：[首版简化技术方案](../develop/tools-mcp/in-flight/agent-runtime-trigger-technical-design.md)，采用含 §4.1 自省工具箱入口及 §7.2 非追溯撤权边界的本轮版本。
> 写作依据：[执行计划指南](../rules/execution-plan-writing-guide.md)。需求、不变量、合同、迁移语义及验收定义均以方案为准；本文只维护任务、依赖和实施证据。

## 0. 交付边界【人必读】

**一句话：** 分三阶段实现一次登记、事件唤醒和有期限的同步监督，先证明不会丢历史、越权启动或误消费消息，再接入真实执行入口。

**只有三分钟：** 看本节、阶段表和最后的验收映射。当前完成范围以任务状态和对应证据文件为准；P1 已完成，P2/P3 尚未完成。

**已有决定继续有效：** 五类事件、一次性登记、繁忙会话排队、两层单次时限、不做累计暂停预算、五项能力放入既有自省工具箱。此次不增加界面、配置开关或独立顶层工具。

**实际接线前的时长确认：** 用户已确认 callbackTimeoutMs=5000ms、maxPauseMs=60000ms，具体生效点唯一登记在 §2 的 T15 前置证据栏。用户已明确来源撤权不追溯合法执行历史，删除原历史隔离与快照合成任务；首次合法接纳以来源授权核验、初始请求历史与凭据的同事务提交为准，提交后即使尚未派发也不追溯，不以旧 A-03/R-01 复审作为实现前置。

**无需重新决定：** 代码入口核查、故障用例、提交拆分和本地证据由实施者负责。计划已在独立 worktree 中按 TDD 执行；任务状态和证据随阶段更新。

本机可完成模拟模型、模拟两渠道入站、SQLite 临时库重开、测试子进程、假时钟、并发和故障注入、构建及静态门禁。真实飞书/微信、平台补投、Electron 休眠和其他操作系统表现按方案保留未实测边界；遵照既有交付范围，不展开真实渠道验收清单，也不把这些外部资源设为源码开发前置。

## 1. 编排与执行规则【人机共读】

### 1.1 阶段边界

沿用方案 §8 的 P1/P2/P3，不另设产品阶段。任务依赖只在 §2 定义；下表仅描述阶段范围。

| 阶段 | 输入与允许范围 | 可独立交付的输出/出口 | 失败回退与兼容代码 |
|---|---|---|---|
| P1 最小合同与 SDK（T00～T09，T05/T06 已移除） | 方案已确认范围；SDK、shared、数据库、公共存储、触发域协议及相应 fixtures；不注册可用触发能力、不启用扫描 | 中性生命周期、暂停、普通历史兼容回归、迁移、稳定 IM 游标、消费者分类合同、状态解析通过本阶段 fixtures；T09 留下 U-01 和边界证据 | 撤回本阶段提交；测试升级库恢复升级前副本。旧调用不传新字段路径保留，不引入临时双 writer；不删旧 IM 消费者 |
| P2 五源与队列接线（T10～T18） | P1 交付；触发模块、五源、公共队列、共同启动资格、授权及原子历史接纳、宿主装配、自省能力及入口引导 | 五源与投递恢复、同步在线接纳、旧 IM 隔离、权限及随机不变量集成通过；T18 阶段提交 | 先取消/结束在线等待，再停止触发接纳与扫描；撤回接线提交，保留登记和回执；测试库必要时整库恢复。不保留旧版独立 runtime_trigger 顶层别名 |
| P3 完整验收（T19～T22） | P2 交付；定向补缺、负载、回退、全量验证和文档证据；不扩产品范围 | AC-01～14 全覆盖，旧数据对拍、关闭/恢复演练、构建及评审证据齐全；T22 源码交付提交 | 采用已演练的停止 writer/整库副本恢复方式；不删表冒充回退。不改造既有历史保存/回放合同 |

P1 的验收是基础合同的 fixtures，不能提前宣称五源端到端 AC 完成。P2 的阶段集成不替代 P3 的负载、全 AC 与回退验收。每阶段收尾提交，仅暂存本计划对应文件；用户已有改动不得混入。

### 1.2 基线与证据规则

实施启动先执行 T00。依赖就绪判据：仓库锁文件与依赖匹配、Node/npm 版本符合 package.json、Vitest 可启动，临时目录可写；SQLite 运行时按仓库已有测试环境准备。不满足时先修环境；确需安装依赖时使用仓库锁文件流程，不无理由刷新锁文件。

基线失败分流：环境错误先处理；既有代码失败记录命令、用例、基线 SHA、影响范围，与新增功能失败分开。不能删测或把未知失败记为通过；若阻碍相关任务，先明确隔离证据或修订计划。

证据目录拟为 `docs/plan/evidence/agent-runtime-trigger/`，由执行时创建。每个任务记录 `<任务ID>.md`：实际 SHA、改动文件、用例名、命令、退出码、日志/摘要、覆盖 AC 的范围、剩余限制。阶段门禁记录阶段 SHA 与提交号。日志不得包含正文、凭据或受保护载荷。当前不创建空证据冒充执行。

测试以合并定向命令为主。对缺失行为先记录真实 RED（用例名、命令及目标行为缺失原因），再运行同一组命令获得 GREEN；已具备行为则记录基线 GREEN，不人为制造 RED。任务表中的测试文件标“拟新增”的，须在该任务内创建后才能执行；不能因 Vitest 找不到文件而当成有效 RED。基线核查、纯文档和阶段检查不要求虚构 RED。

### 1.3 共用验证命令

以下代号只缩写命令，不新增验收标准。所有命令从仓库根目录执行；T00 核对 package.json 后，脚本若变化应记录替代命令及原因。

| 代号 | 可执行命令 / 使用时点 |
|---|---|
| V-SDK | `npm run check:agent-sdk` 与 `npm run typecheck:agent-sdk` |
| V-STORE | `npm run check:session-storage-boundary`、`npm run check:session-storage-cleanup-boundary`、`npm run check:message-fact-ownership` |
| V-SHARED | `npm run typecheck:shared` |
| V-SEC | `npm run check:system-invariant-registry`，并运行任务规定的安全边界测试；没有新增 registry 项不等于可以省略 |
| V-PHASE | 合并运行本阶段受影响定向测试后，阶段收尾 `npm test`；P1/P2 的 `npm run build:electron:incremental` 每阶段至多一次 |
| V-FINAL | `npm test`、`npm run build`、V-SDK/V-STORE/V-SHARED/V-SEC、`git diff --check`；阶段全量与最终全量同一状态可复用，不无意义重跑 |

纯提示词能力说明不默认新增 UI 翻译 key；若实际改动涉及 UI 文案，遵循 i18n 指南并补相应命令。无渲染改动不额外重复 renderer 类型检查；最终 build 仍按方案执行。

## 2. 唯一依赖表【机｜人工可跳过】

依赖是“该任务启动前，所列任务已完成并有证据”。无其他隐式任务依赖。下表同时登记任务依赖与人工前置证据，二者不能混称本机可生成证据；只有实际装配任务受时长确认约束。本地测试使用显式 fixture limits 和假时钟，不写入生产缺省值。所有测试/构建在本机执行，不要求真实 IM。

| 任务 | 前置任务 | 额外前置证据 |
|---|---|---|
| T00 | 无 | 无 |
| T01 | T00 | 无 |
| T02 | T01 | 无 |
| T03 | T01 | 无 |
| T04 | T03 | 无 |
| T07 | T03、T04 | 无 |
| T08 | T01、T03 | 无 |
| T09 | T02、T04、T07、T08 | 无 |
| T10 | T09 | 无 |
| T11 | T10 | 无 |
| T12 | T10 | 无 |
| T13 | T10 | 无 |
| T14 | T10 | 无 |
| T15 | T11、T12、T13、T14 | C-LIMITS：已由用户在本会话确认 callbackTimeoutMs=5000ms、maxPauseMs=60000ms；首次生产 runtime limits 装配仍须有代码与测试证据 |
| T16 | T15 | 无 |
| T17 | T16 | 无 |
| T18 | T17 | 无 |
| T19 | T18 | 无 |
| T20 | T19 | 无 |
| T21 | T20 | 无 |
| T22 | T21 | 无 |

不另画 DAG，避免第二份依赖真源。任务表按拓扑顺序列出不代表要并行执行；实施者可在满足此表后编排。

## 3. P1：最小合同与 SDK【机｜人工可跳过】

状态仅在本节及后续任务条目维护；全部初始未开始。每项默认负责人为后续实施 Agent，合同决定由项目负责人确认，评审由指定评审者留结论。

- [x] **T00 核对基线、未决合同与入口覆盖**
  - 范围：只读 `package.json`、方案及其评审引用、`electron/toolChatLoop.ts`、`electron/runtime/`、`electron/remote/`、两渠道入口、`packages/agent-sdk/src/turn.ts`；写本任务证据，不改其他工作区文件。
  - 产物：实际 HEAD/dirty 清单；环境就绪及基线门禁结果；普通、重试、handoff/continuation、恢复的调用点清单；核对两项时限及本轮非追溯边界。
  - 完成判据：V-SDK、V-STORE 基线可解释；每个入口定位到实际调用方；把两项有限时长的已确认依据写入证据或明确未取得，不擅自填默认值。本项可在未取得结论时完成“盘点”，时长确认仅在 §2 指定的实际装配任务生效；旧 A-03/R-01 的历史隔离要求不再作为开发门禁。
  - 验证：`git rev-parse HEAD`、`git status --short`、`npm exec vitest -- --version`、V-SDK/V-STORE；`rg -n 'beforeModelRequest|postStep|postTurn|readHostedTranscript' packages/agent-sdk/src electron`。对应 AC-07/09/12/13 的入口覆盖，尚不关闭 AC。证据：T00.md。

- [x] **T01 固定实现合同与 fixture 入口**
  - 范围：`src/shared/domainTypes.ts`、`src/shared/errorCodes.ts`、`src/shared/assistantFactAggregator.ts`、`packages/agent-sdk/src/` 相关公开类型/导出、`electron/sessionStorage/public/`、`electron/capabilities/types.ts`、触发域协议类型（拟新增）；必要规格修订只能先回方案评审。
  - 产物：SDK/宿主/公共存储签名和 JSON schema v1；五项能力完整 params/returns、分页及错误 DTO；10 个域错误和两个 SDK 失败映射；方案 §7.1.1 admission JSON/宿主原子提交与失败收尾合同 fixture 文件清单（P2 接真实事务）。保持方案 §3～7 定义，不在计划重定字段。
  - 完成判据：不新增历史 retention/manifest/投影或合成接口；两项时限只固定“显式有限值”的类型及校验合同，最终取值不作为本任务完成条件。SDK tests 使用明确标注的 fixture limits/假时钟，不引入生产默认值。完整工具 schema 中若遇方案未规定且会影响用户行为的选择，先修订方案确认，不由实现静默选值；SDK 无触发器依赖，shared 不反向 import SDK。
  - 验证：V-SDK、V-SHARED；拟新增 `electron/triggers/protocol.test.ts` 的输入/错误 schema fixtures。对应 AC-01/10/11/12/14 的合同部分。证据：T01.md。

- [x] **T02 实现中性生命周期与有期限暂停**
  - 范围：`packages/agent-sdk/src/turn.ts`、生命周期类型/导出、`packages/agent-sdk/test/turn.test.ts`、必要既有 lifecycle 测试。
  - 产物：postStep/postTurn、短回调与 PauseRequest 两层计时、独立取消信号、单结算与 timer/listener 清理；执行预算暂停/恢复接线。
  - 完成判据：按方案 §5 fixtures 覆盖全工具组结算后回调、无工具最终步、postTurn 已提交终态不变、callback/wait 永不返回、throw/reject、取消/到期/完成竞争与迟到 rejection；pause 不耗执行剩余预算且恢复不重置，无累计预算。未配 hooks 的旧调用保持一致。
  - 验证：`npm exec vitest run packages/agent-sdk/test/turn.test.ts packages/agent-sdk/test/lifecycle.test.ts`、V-SDK。对应 AC-03/07/10/14 的 SDK 部分。证据：T02.md。

- [x] **T03 实现登记及 IM 接纳身份的事务迁移**
  - 范围：`electron/database/schema.ts`、`electron/database/migrations.ts`、`electron/triggers/` store（拟新增）、`electron/database/imInbox.ts` 的 append 输入/实现、`electron/feishu/remoteCommandRouter.ts`、`electron/wechat/weChatCommandRouter.ts` 及所有实际 append 调用方、现有数据库迁移测试及拟新增 `electron/triggers/migration.test.ts`。
  - 产物：方案定义的一张登记表、IM context 四列、独立序号与覆盖键族/触发器；有效 sync 唯一约束；JSON 版本读写与既有事务封装。严格 IM 写入签名及全部生产调用方同步升级到本任务，不留到 T11。
  - 完成判据：使用启动时最新 schema 版本而非预占 118；旧 NULL 身份不猜测；旧行分配可重入；事务中断不半升级；序号删除后不复用、修改被拒；按准确流记录删除覆盖损失；未来版本按原逻辑拒绝。P1 同一交付中将 accountId/conversationId/senderId 改为新接纳必填，由宿主可靠事实传入，accepted_seq 由事务分配；所有生产调用方同步修改，缺字段拒绝且整体回滚。迁移旧行身份仍可 NULL，只供明确缺覆盖处理，不以 SQL 全列 NOT NULL 强迫伪造旧身份；不存在阶段性接受缺身份新事实的兼容路径。
  - 验证：`npm exec vitest run electron/triggers/migration.test.ts`，合并 T00 定位的既有 migration 和两渠道接纳测试，记录全部 append 调用方编译/模拟接纳覆盖；V-STORE。对应 AC-05/09/11/13 的持久合同。证据：T03.md。

- [x] **T04 扩展公共队列端口并隔离消费者资格**
  - 范围：`electron/sessionStorage/public/` 及对应实现、`electron/database/operations.ts`、`electron/database/imInbox.ts`、拟新增 `electron/triggers/queueContract.test.ts`、现有 sessionStorage 测试。
  - 产物：scope enqueue、只读 receipt、取消未派发输入命令；可信 platform-im/runtime-trigger/ordinary-desktop/invalid 分类及所有消费入口事务核验。
  - 完成判据：fixture 可构造可信标记但不启用触发功能；伪造前缀无效；inbox list/claim/ack/release/renew/澄清搬迁/批量接纳均不能消费标记；desktop 也不抢占；原合法平台消息路径不回归；requestId 指纹冲突和取消回执不可重领有证据。
  - 验证：`npm exec vitest run electron/triggers/queueContract.test.ts electron/sessionStorage/sessionStorage.test.ts`、V-STORE。对应 AC-08/12/13 的存储部分。证据：T04.md。

- [x] **T07 实现独立 IM 事实分页与覆盖证明**
  - 范围：`electron/database/imInbox.ts`、SessionStorage 公共事实查询接口/实现、拟新增 `electron/triggers/imFacts.test.ts`。
  - 产物：不依赖 queued/claimed 的准确流分页、接纳水位/coverage 事务基线及授权正文引用读口。
  - 完成判据：先 ack 可回读、超过 100 条续页、排序/搬迁不改原接纳身份、删尾后水位不回退、页间删除使准确流 SOURCE_GAP、其他流不误伤；旧身份不完整明确拒绝，不默认所有账户。
  - 验证：`npm exec vitest run electron/triggers/imFacts.test.ts electron/triggers/migration.test.ts`、V-STORE/V-SEC。对应 AC-05/09/11/12 的事实读口。证据：T07.md。

- [x] **T08 实现一次性登记状态与解析服务**
  - 范围：`electron/triggers/` protocol/store/service（拟新增）、共享 DTO；不注册工具描述符、不启动扫描。
  - 产物：五项操作的内部服务，clientKey 幂等、revision CAS、容量/期限、权限过滤、单目标有效 sync 唯一性及失败可查。
  - 完成判据：协议 fixtures 覆盖同 key 同/异定义、cancel 与 match 竞争、终态不复活、owner 伪造、权限分页、同步自等待拒绝而异步同会话允许、第二有效 sync 冲突、容量和过期；随机状态序列只覆盖当前实现，不依赖 P2 队列。
  - 验证：`npm exec vitest run electron/triggers/protocol.test.ts`、V-SHARED/V-SEC。对应 AC-01/10/11/14 的登记部分。证据：T08.md。

- [x] **T09 核验 P1 出口并提交阶段成果**
  - 范围：本阶段改动文件、证据 T02/T04/T07/T08；U-01 调用点与 fixtures 对账，阶段记录 `P1.md`。
  - 完成判据：上述任务及其依赖的证据齐备；特别引用 T03 的严格 IM append/全部生产调用方同阶段升级、旧 router 回归与编译证据（不得借用 T11），T02 的全组/计时证据、既有历史普通保存/回放兼容回归、T07 的游标覆盖、T08 的协议、T00 的全部宿主调用点清单。History settled reducer 所需公共事实覆盖由 fixtures 证明，不足就在本阶段补对应公共读口，不能延到 P2 再猜。尚未接线的在线 sync 以 SDK wait 接纳 fixture 验证，不宣称运行时命中已完成。
  - 验证：V-SDK/V-STORE/V-SHARED/V-SEC、V-PHASE；记录未配置 hooks 的 SDK/既有 history 对拍及一个阶段提交 SHA。对应 AC-01/03/05/07/09/10/12/13/14 的 P1 子集，不关闭端到端 AC。证据：P1.md。

## 4. P2：五源与队列接线【机｜人工可跳过】

- [x] **T10 接通公共 History 的 settled 计数和准确 Turn 对账**
  - 范围：`electron/triggers/` sources、公共 History 适配、宿主 Turn 终态订阅；拟新增 `electron/triggers/sources.test.ts`。
  - 产物：复用 P1 证明可读的事实，重建 step baseline/增量缓存和准确 Turn 结果；不复制进度表。
  - 完成判据：模型接受响应及整组工具才算一步；并行工具、重试、拒绝工具、未确定提交、压缩/重启、登记时未结算步骤均依方案处理；重复扫描不增；Turn 登记与终态前后顺序及 SDK/宿主终态不同步均可对账，缺覆盖明确失败。
  - 验证：`npm exec vitest run electron/triggers/sources.test.ts`；对应 AC-02/03/09/11。证据：T10.md。

- [x] **T11 接入两渠道 IM 触发匹配与补扫**
  - 范围：触发域 IM adapter、两渠道模拟接纳到匹配的集成测试及 imFacts 测试；生产 append 签名、全部调用方及严格校验已在 T03 完成，本任务不再承担其切换。
  - 产物：使用 T03 已接入的准确账户/聊天/发送者身份和原序号，以及 T07 分页事实读口，补扫并按字面条件匹配；不改变 P1 已生效的写入合同。
  - 完成判据：两渠道模拟输入均验证准确 scope、senderIds/bodyContains、正文及回复引用；先登记/先接纳双顺序、已 ack/多页/重开库可补扫；上下文缺字段整体回滚；原入站 guard 与 wake 不绕过、不改平台 ack 所有权。
  - 验证：`npm exec vitest run electron/triggers/imFacts.test.ts electron/triggers/sources.test.ts`，合并 T00 查明的两渠道接纳测试；V-STORE/V-SEC。对应 AC-05/09/11/12，关闭 U-02 引用 T03 全部 append 调用方证据，并补本任务匹配/正文集成证据。证据：T11.md。

- [x] **T12 接入受管 shell/script 进程退出事实**
  - 范围：`electron/tools/runShellExecutor.ts`、`electron/tools/builtinExecutors.ts` run_script、`electron/shell/` 既有 supervisor 与触发域 process adapter；拟新增 `electron/triggers/processSource.test.ts`。
  - 产物：opaque managedProcessId、runtime generation 和内存退出事实通知；targets 可枚举当前有权且运行中的身份。
  - 完成判据：shell 与 script 两入口都有正常/异常退出、spawn 失败、信号、重复 close；拒绝任意 PID；旧代/重启无法证明结果则 SOURCE_GAP，不推断成功；输出引用遵循既有权限和截断，不新增持久进程表。
  - 验证：`npm exec vitest run electron/triggers/processSource.test.ts electron/tools/runShellExecutor.test.ts`，合并实际 run_script 边界测试。对应 AC-04/09/11/12。证据：T12.md。

- [x] **T13 接入绝对时间与异步事件匹配**
  - 范围：触发域 sources/service、既有重试算法只读复用；sources 测试。
  - 产物：1 秒定时扫描及 async CAS 命中；过期/离线定时合同的假时钟实现。
  - 完成判据：准确时区、at 与 expiresAt 边界、登记已到时、离线跨期限按方案补一次；扫描重复/乱序最多一次；同步项只计算候选，不能由扫描写 matched/投递或宣称已暂停。
  - 验证：`npm exec vitest run electron/triggers/sources.test.ts electron/triggers/protocol.test.ts`；对应 AC-06/07/09/10/14 的匹配部分。证据：T13.md。

- [x] **T14 绑定在线 postStep 的同步命中与暂停接纳**
  - 范围：触发域 runtime lifecycle adapter、SDK 中性 hook 宿主适配、拟新增 `electron/triggers/syncCheckpoint.test.ts`。
  - 产物：准确 stepKey/Turn/execution generation 的在线 CAS；wait 被 SDK 调用后才认可暂停接纳并允许后续投递；等待函数/abort 记账。
  - 完成判据：扫描先/后 postStep、matched 后回调超时、未调用 wait、checkpoint 越过、旧代恢复均按方案收敛；订阅后重新读真实 receiver 终态以覆盖先完成窗口。此任务用可信 receiver 事实 fixture 验证，不依赖尚未实现的实际投递；真实链路在 T16 验证。
  - 验证：`npm exec vitest run electron/triggers/syncCheckpoint.test.ts packages/agent-sdk/test/turn.test.ts`；对应 AC-07/09/10/14。证据：T14.md。

- [x] **T15 接通幂等队列投递与共同启动授权屏障**
  - 范围：触发域 delivery、`electron/turnRuntime.ts`、宿主 History 装配及 `electron/runtime/sqliteAgentHistory.ts` 原子 append 入口、宿主 provider/tool dispatch 适配、`electron/sessionStorage/`、原 wake dispatcher 的资格接入；拟新增 `electron/triggers/delivery.test.ts`、`electron/triggers/authorization.test.ts`。
  - 产物：核验 §2 C-LIMITS 并首次装配实际 runtime limits（此前 T02/T14 仅使用显式 fixture 输入）；固定 requestId 的中性标记、既有 enqueue/receipt、receiver 真实 Turn 关联；桌面/IM/trigger 共用资格；授权绑定、policy 更新决策与首次 context/admission 同事务 final-check；取消未派发队列及已准备 Turn。
  - 完成判据：忙碌只排队不耗 retry，renderer 未连接仍可启动准确 receiver；队列不存 raw。撤权覆盖入队后/资格后/异步装配后/原子接纳事务前的交错，事务内核验当前批准材料并同 connection 提交 context 与 result_json.admission；首次接纳前失败 model/tool dispatch=0、receipt 不可重领；已合法接纳的历史不因来源撤权取消或重新验源，显式用户取消仍有效；提交后但 provider 前撤权不拒绝已有历史；新来源读取各自检查当前权限。未接纳时原子拒绝失败 catch 携带的 raw transcript，不生成新投影，宿主原终态接口收尾且保留旧 transcript；缺/错凭据拒绝恢复，不据 model-request-started/physical 猜接纳。取消来源撤权在 provider 适配器内拒绝的路径，既有其他派发前拒绝进入 not-dispatched，不伪报 physical=true。final-check 不重新判断业务风险，证据标注 facts/policy/final-check 阶段及现有 rule/trace。
  - 验证：`npm exec vitest run electron/triggers/delivery.test.ts electron/triggers/authorization.test.ts electron/triggers/queueContract.test.ts`、V-STORE/V-SEC。对应 AC-08/11/12/13；B-02/A-02 回归。证据：T15.md。

- [x] **T16 装配全部宿主入口和恢复补扫**
  - 范围：T00 定位的桌面/remote/handoff/continuation/恢复装配、应用启动/关闭、触发域 recovery；拟新增 `electron/triggers/recovery.test.ts`。
  - 产物：五源与实际 receiver Turn 终态全链路；启动补扫/失败重试/取消/删除/关闭收敛；真实来源输入按原 SDK 一致性校验，在宿主原子接纳事务中保存；恢复核对 trigger/request/receiver/turn/invocation/contextEventId/digest 与 admission 一致，在线 lifecycle hooks 统一装配。
  - 完成判据：按方案 §5～7 在命中、入队前后、receipt 后、领取/prepare/dispatch 前后、终态前后注入故障重开库；固定 requestId 无第二条消息，删除/编辑不能补新消息；已消费 IM 可恢复，同步无在线 waiter 不伪装恢复；真实 sync wait 先于投递，receiver 先完成不漏通知；跨会话环期限收敛。整库导入不从消息生成登记。补 S-01 故障：raw 内存准备后撤权、context INSERT 后 admission 前退出回滚、双提交后 provider 前退出/撤权、调用 provider 后退出、凭据孤立/摘要不符、SDK catch 再提 raw；分别断言无未接纳正文落入普通历史/检索/下一轮、已接纳可恢复不追溯、无盲目重派发，接纳失败 provider=0且不伪报 physical 派发。
  - 验证：`npm exec vitest run electron/triggers/recovery.test.ts electron/triggers/delivery.test.ts electron/triggers/syncCheckpoint.test.ts`、V-SDK/V-STORE/V-SEC。对应 AC-02/03/05/07/08/09/10/12/13/14。证据：T16.md。

- [x] **T17 注册自省能力并补齐入口引导**
  - 范围：`electron/capabilities/handlers/` 触发器描述符（拟新增）、`registerBuiltinCapabilities.ts`、CapabilityContext 构造、`src/shared/skillPrompt.ts`、既有 capability/toolkit/match 测试及拟新增 `electron/capabilities/handlers/runtimeTrigger.test.ts`。
  - 产物：方案 §4.1 五个 action.runtime_trigger 能力的 params/returns/关键词/下一步说明，以及桌面和远程共同提示；继续复用 toolkit_find/toolkit_call。
  - 完成判据：自然用途查询覆盖五类事件且给出可调用 ID/参数；targets→register→事件唤醒示例可用；get/list/cancel revision 引导准确；owner 只能由宿主注入；变更操作经原 policy/trace，不套 read 免审；网关 schema 不变，不注册旧 runtime_trigger 顶层工具。
  - 验证：`npm exec vitest run electron/capabilities/handlers/runtimeTrigger.test.ts electron/capabilities/match.test.ts electron/capabilities/toolkitTool.test.ts electron/capabilities/callCapability.test.ts`，合并 T00 定位的 skillPrompt 测试；V-SHARED/V-SEC。对应 AC-01/10/11/12。证据：T17.md。
  - 执行偏差记录：能力与入口实现曾早于 T16 收口；随后已完成真实 receiver 唤醒/恢复装配，并按 T16→T17 依赖顺序关闭。历史偏差见 §7 执行进度。

- [x] **T18 核验 P2 集成与随机不变量并提交**
  - 范围：触发域 recovery/protocol/delivery 测试、旧 IM 集成测试、本阶段证据；不增加产品能力。
  - 产物：register/event/cancel/restart/queue/complete 固定 seed 随机操作集、五源到 receiver 终态本地集成记录；`P2.md`。
  - 完成判据：每步断言方案 INV-01～06；重放失败 seed 可复现；B-01/B-02、A-01/A-02/A-04 反例分别引用 T11/T15/T14/T04/T07/T16 证据；旧 A-03/R-01 不再适用，S-01 通过 T15/T16 的接纳/故障证据核验，非追溯历史边界由普通历史回归证明，不以评审结论代替测试；旧两渠道 wake/inbox 行为无回归。提交完整集成，不提前声称负载指标达成。
  - 验证：`npm exec vitest run electron/triggers electron/capabilities/handlers/runtimeTrigger.test.ts`，合并旧两渠道回归；V-SDK/V-STORE/V-SHARED/V-SEC、V-PHASE；阶段提交 SHA。对应 AC-01～13 及 AC-14 的随机不变量部分。证据：P2.md。

## 5. P3：完整验收与交付【机｜人工可跳过】

- [～] **T19 补齐全 AC、负载与旧数据对拍**
  - 范围：触发域测试、历史/队列/迁移 fixtures；拟新增 `electron/triggers/capacity.test.ts`，必要的局部缺陷修复归对应实现模块，不扩边界。
  - 产物：AC-01～14 用例索引；4096 等待项/每 owner 128、期限/重试限额、本地时延、历史重建/每步增量成本报告；投递/重复/恢复指标报告。
  - 完成判据：按方案分母/排除口径测量，不把 SOURCE_GAP 计为恢复成功；本地时间指标说明机器、负载、样本与计时起止。原 schema fixture→升级、普通历史、队列与导出/恢复对拍；已合法接纳来源后撤权，下一轮/同轮重试/重启恢复/压缩沿用旧历史，而新来源访问被拒绝；U-03 有数据，U-04 仍明确未实测。失败先修对应模块，不能删 AC 或放宽指标。
  - 验证：`npm exec vitest run electron/triggers/capacity.test.ts electron/triggers/recovery.test.ts electron/triggers/migration.test.ts`；其余 AC 使用已记录同 SHA 定向命令，变化后仅重跑受影响集。对应全部 AC 的缺口核对，重点 AC-13/14。证据：T19.md 及 ac-mapping.md。

- [ ] **T20 演练关闭与整库回退恢复**
  - 范围：临时数据库/测试进程、触发域关闭/恢复代码及测试、已有备份/恢复入口；不操作用户生产数据库。
  - 产物：停止新接纳与扫描、结束在线等待、停止 writer、整库副本恢复的顺序记录及可重现 fixture。
  - 完成判据：等待没有无限遗留、迟到完成不复活；升级失败回滚和旧代码打不开升级库时恢复副本可验证；明确副本后的全部变化会丢失，绝不以删表/降版本号冒充回退。对运行中真实环境的不可逆恢复仍按已有批准规则，不由测试授权推导。
  - 验证：`npm exec vitest run electron/triggers/migration.test.ts electron/triggers/recovery.test.ts electron/triggers/syncCheckpoint.test.ts`，测试中加入演练用例；对应 AC-09/10/13/14 及方案 §8 回退。证据：T20.md。

- [ ] **T21 完成最终验证与质量评审**
  - 范围：实现涉及的文件、测试、边界及构建；阶段证据，不含无关工作区改动。
  - 产物：V-FINAL 记录，最终 SHA 上 AC/INV 双向映射及安全边界评审。评审代码前按仓库适用的 code-review-and-quality skill 执行，届时先读取其要求；本次写计划不视为代码评审。
  - 完成判据：引用 T19 全 AC/指标与 T20 关闭回退证据；所有必跑门禁通过，无阻断缺陷；未验证外部边界单列，不写成通过。构建失败或评审发现问题时修复后重跑相关定向集，最终必要门禁以修复后状态为准。
  - 验证：V-FINAL。对应 AC-01～14 最终证据汇总，不依赖 T22。证据：T21.md。

- [ ] **T22 交付源码、证据和阶段提交**
  - 范围：本计划状态/证据、`docs/develop/tools-mcp/README.md` 与既有主题现状文档的准确实现链接；实现文件仅纳入已验证提交。
  - 产物：`P3.md`、阶段提交 SHA、AC 映射、未验证边界与偏差记录；计划状态按证据逐项核销。
  - 完成判据：T21 最终验证对应当前代码；文档不再把已实现与待实现混写，规格变更仍回方案留评审依据；提交不混入其他工作。此项是源码交付，不自动打包发布或对真实数据库启用迁移；未来正式发布引用 T20/T21 证据并沿现有发布授权流程。
  - 验证：`git diff --check`、逐一检查文档相对链接、`git status --short`、`git show --stat <实际阶段提交SHA>`；对应 AC-01～14 证据可追溯性。证据：P3.md。

## 6. 验收映射与门禁来源【机｜人工可跳过】

此表只定位实施证据，不复制或修改 AC 内容。列出的任务证明局部行为；只有 T21 汇总当前实现证据后才能声明完整通过。

| 方案 AC | 主要产出任务 |
|---|---|
| AC-01 | T01、T08、T17 |
| AC-02 | T10、T16 |
| AC-03 | T02、T09、T10、T16 |
| AC-04 | T12 |
| AC-05 | T03、T07、T11、T16 |
| AC-06 | T13、T19 |
| AC-07 | T02、T14、T16 |
| AC-08 | T04、T15、T16 |
| AC-09 | T07、T10～T16、T19、T20 |
| AC-10 | T02、T08、T14、T16、T20 |
| AC-11 | T07、T08、T10～T12、T15、T17 |
| AC-12 | T01、T04、T07、T11、T12、T15～T17、T19 |
| AC-13 | T03、T04、T15、T16、T19、T20 |
| AC-14 | T02、T08、T13、T14、T16、T18～T20 |

| 检查点 | 只引用已产出的证据 | 不得借用的后续证据 |
|---|---|---|
| T09 / P1 | T00～T04/T07/T08 的 baseline、合同、fixture、公共边界和 U-01 | 不要求 T16 真实宿主集成/T19 负载/T20 完整回退 |
| T18 / P2 | P1 记录、T10～T17 五源/派发/恢复/工具发现、T18 当次随机和阶段回归 | 不要求 T19～T21 最终验收 |
| T21 / 最终验证 | T18 集成、T19 全 AC/负载、T20 关闭回退及当次全量/构建/评审 | 不要求 T22 交付提交，以免验收自环 |
| T22 / 源码关闭 | T21 当前代码验证与阶段提交材料 | 不承诺真实渠道/其他系统发布结果 |

## 7. 偏差与交接记录【机｜人工可跳过】

执行中发现契约不闭合、公共读口覆盖不足或性能不成立时，记录“任务 ID、实际代码证据、影响 AC、拟回到方案修订的条款”。任务保持未完成；不能用新增并行存储、策略旁路或减弱断言临时绕过。只有任务依赖/粒度变化时修改 §2 与对应任务，阶段和验收变化先修改方案。

中断交接记录最后完成任务/提交、未提交文件、正在运行命令、失败 seed/测试和下一可启动任务。每次写状态后复读文件，以磁盘及 git 证据为准。

本次编制时自检（历史记录）：三个阶段与方案一致；21 项有效任务（保留原编号，移除 T05/T06）；当时所有状态未开始；唯一依赖表按拓扑排列且无环；任务均有目标模块、产物、完成判据、命令及本机环境约定；门禁证据不引用未来任务；回退演练在源码交付前。编制时未执行功能测试、迁移、构建及评审；后续执行结果见任务证据文件。

### 本轮评审修订记录

依据：[执行计划评审](../review/2026-11-01-agent-runtime-trigger-execution-plan-review.md)、[架构复审 v3](../review/2026-11-01-agent-runtime-trigger-architecture-review-v3.md)、[完整架构复核](../review/2026-11-01-agent-runtime-trigger-full-architecture-review.md)。仅修订编排，未改方案合同或代码，未将修订视为复审通过。

| 问题 | 修订与静态核验 | 状态 |
|---|---|---|
| E-01：时长确认成总门禁 | T01 仅固定有限值合同；确认凭据 C-LIMITS 唯一放在 §2 T15 前置栏。模拟“时长未定、T00/T01完成”：T02/T03 可启动，T03 完成后 T08 也可启动，后续基础 fixtures 可依 DAG 推进；到 T15 才等待人工凭据。fixture 值禁止进入生产缺省 | 编排已修订，待复审；非功能验证 |
| E-02：P1 新约束依赖 P2 调用方 | 严格 append 签名、所有生产调用方与事务校验前移 T03；P1 新接纳完整身份/序号，迁移旧行 NULL 明确缺覆盖；T09 只取 T03 及本阶段回归/编译证据。T11 仅匹配/补扫集成，不再承担生产写入切换 | 编排已修订，待复审；非实施通过 |

本轮移除 T05/T06 后为 21 项有效任务，唯一依赖表未增加环；额外人工证据显式列出，未伪装成本机测试产物。

### 2026-11-02 执行进度

- P1 已在两个独立阶段提交完成；P2 的 T10–T18 已完成并有证据；P3 正在补齐 T19 全 AC/容量和 T20 关停与整库恢复。
- 固定 seed `0x51a7` 在 terminal 状态复活检查失败，证明公共 SQLite trigger update 缺少状态转移条件；修复后相同 seed 通过。代码与测试细节见 T16.md、P2.md。
- T17 按依赖晚于 T16 收口；此前先行编辑能力与提示，现已补齐主进程 receiver/recovery 接线再关闭任务。
- 本轮 T16/T17 源码交付按本机 Electron/SQLite 测试验收；真实 IM 账号/远程授权服务、生产库及打包跨平台不在本地可单测范围，T19/T20/T21 将继续明确外部边界。

### 非追溯撤权修订

依据用户明确要求“撤权后不能再访问来源，不追溯过往执行历史”，本轮同步修订方案 §7.2。删除原 T05（SDK 安全快照合成）、T06（历史隔离及回放验源），编号保留空缺便于追踪，二者不是待办或完成项；依赖表及验收映射移除引用。剩余 21 项任务沿用原编号。既有合法来源内容按普通历史保存/重用，不修改 contextAdapter/SessionTranscriptCommitIntent 或引入旧隔离合成；S-01 仅扩展宿主 sqliteAgentHistory 首次提交与触发登记凭据的原子协作和未接纳 raw 拒绝入口。新来源读取和首次尚未接纳正文的授权检查保留在 T15/T16，非追溯边界的整体回归在 T19；不把触发器内部 event_json 缓存视为接收会话已有合法历史。

E-01 的时长生效点仍仅在 §2 T15；E-02 的严格 IM 写入及全部调用方同步升级仍在 T03。旧评审报告保持原文，其历史隔离结论适用于旧版合同，不代表本轮修订已复审通过。本轮仅改文档。

### S-01 联合评审修订

依据：[会话存储简化联合评审](../review/2026-11-01-agent-runtime-trigger-storage-simplification-review.md)。方案 §7.1.1 改为“当前授权核验＋首次 invocation-context-committed＋result_json.admission”同事务提交接纳，非物理派发。T15 负责 producer、同 connection 原子提交、所有写入入口的未接纳 raw 拒绝及失败事实；T16 负责恢复、下一轮和各崩溃窗口验证。T19 只补整体回归，不替代 T15/T16 的阶段证据。21 项依赖表及 C-LIMITS 生效点不变；本轮合同修订待复核，未实施。
