# IM 安全审核改进开发方案

日期：2026-10-11（按 `main` 最新代码复核：`708270a9`，2026-10-12）  
状态：实施方案草案；本文的新类型、字段和模块名是建议设计，不表示仓库已经实现。当前基线已具备 IM 意图/恢复基础设施和远程确认的桌面隔离呈现，但尚无统一 IM 策略域。  
对应需求：[少问人，统一设置](../requirement/2026-10-11-im-security-review-improvement-requirement.md)

## 1. 先说明结论

这次要同时改两件事：把微信、飞书背后的安全配置合成一份；让 IM 真正走到安全审核 Agent。只合并页面不会合并运行策略，只打开异步门禁也不会改变引擎的回答者。

策略和审批位置按本次可信输入入口确定：桌面输入使用桌面策略并在桌面审批；微信/飞书输入使用共同 IM 策略并在原渠道审批。同一会话从另一个入口发起的新指令按新的入口裁决，已有待办、确认和批准仍按 channel、identity、originSession 及精确动作隔离。IM 待确认不得经桌面确认卡或 `wechat:confirm-response` 这类兼容 IPC 代答；远程审核 Agent 失败时只允许继续原 IM 人工/待办路径，否则 fail closed。桌面代答 Agent 降级只限 desktop 来源动作。

标准档“自动链路免打扰”只承诺自动审核候选经 Agent 成功 approve 且最终安全检查通过后不询问用户。hard-deny、能力不可用、关键配置故障、递归限制、critical 和 Agent 明确 deny 均终局拒绝，不创建可批准待办；逐次人工底线直接进入原 IM 精确待办，Agent undetermined/timeout/暂时 unavailable 进入原 IM 精确待办，待办路径不可用则安全失败。严格档需人工时走原 IM 确认机制。

默认顺序是：先检查有没有资格做，再检查是否必须人工，然后由确定性规则和审核 Agent 判断普通动作。需要人时留下待办，不让整轮任务卡住。提高自动化比例不代表扩大本地文件访问面或开放远程 Shell。

## 2. 现有代码怎么影响结果

| 位置 | 已核对的现状 | 改造点 |
|---|---|---|
| `src/shared/policy/policyPackages.ts` | 档位按 desktop/wechat/feishu/automation 保存；IM_TRANSFORMS 为空；IM 自定义动作不含 auto-evaluator | 引入共同策略域，IM 共享档案和动作域 |
| `src/shared/policy/policyEngine.ts` | ask 默认按 lane 选择回答者；outbound 和 read 兜底可放行；自动动作未裁决才交 agent | 依据生效动作选回答者，外发检查覆盖所有捷径 |
| `src/shared/policy/defaultRules.ts` | MCP 只读豁免只给桌面；IM 写规则宽泛；认证脚本仍可能 ask | 按调用事实拆分普通动作，保留规则优先级 |
| `electron/runtime/invocationAssembler.ts` | 真实调用显式传 confirmation.answerer | 引擎、装配、出口使用同一裁决，不能在出口偷偷升级 |
| `electron/confirmation/channels.ts` | 存在回答者选择辅助函数，但不能据此证明所有真实调用会采用它 | 测试真实装配路径，并区分强制人工与自动降级 |
| `electron/confirmation/imAsyncApprovalPolicy.ts` | 全部 outbound 转人工；gate=locked 时 deny；证据不完整不可 agent-approved | 明确锁定规则语义；增加受控任务回复例外前同步契约 |
| `electron/remote/imDeferredApprovalProducer.ts` | 仅 answerer=agent 才进入异步生产路径 | 复用生产与恢复设施，允许强制人工动作直接进入待办 |
| `electron/ipc/securityIpc.ts` 及安全策略运行时 | 策略读取、写入、撤销需要共同收口 | 新域接口、事务迁移、版本和授权代次 |
| `src/renderer/components/Config/ToolsSecuritySettingsTab.tsx` | 展示三种用户 lane；飞书写确认仍读写 FeishuConfig | 展示桌面与 IM，移除渠道私有安全写入 |
| `src/shared/imTypes.ts`、wechatTypes/feishuTypes、两侧 prompts | 通用安全字段在渠道配置中重复，旧确认枚举有残留 | 共同配置、一次性迁移、实际生效文案 |

### 2.1 最新代码复核补充（`main` `708270a9`）

下表是相对于本方案原始基线的已实现变化；这些能力应作为后续实现的依赖复用，不应再安排重复建设。

| 最新实现 | 已有行为及边界 | 对本方案的影响 |
|---|---|---|
| `src/shared/turnDisplayProtocol.ts`、`src/shared/assistantFactAggregator.ts`、`src/shared/domainTypes.ts` | 投影/聚合携带 `remoteConfirmation: wechat\|feishu`，往返转换保留渠道 | 保留此字段作为 UI 路由提示；未来统一策略域需另有可信 policyDomain，不能将展示来源当授权事实 |
| `src/renderer/services/pendingConfirmStore.ts`、`resolveMessageToolsInteractive.ts`、`ToolCallCard.tsx` | 桌面 pending 与交互确认排除远程待确认项，卡片显示对应渠道等待状态 | “远程待确认出现在桌面确认卡”的回归已具备基础；补跨入口新指令和真实审批归属验收，不能重复实现已有过滤 |
| `electron/confirmation/imChannel.ts`、`electron/wechat/weChatConfirmationPromptAdapter.ts` | IM 确认记录含渠道/身份/会话与消息关联信息；微信适配器有平台引用绑定尝试 | 继续复用 channel 确认机制；真实客户端引用标记往返仍未验收，保持为独立验收缺口，不将 adapter 单测计作通过 |
| `electron/remote/remoteTrack*`、`remoteTrackFeatureGates.ts`、`imRemoteAgent.ts` | 有 Track 持久化、owner/channel/epoch 校验、范围化模型输入、恢复和影子门禁 | Track 解决任务归属及恢复；策略域统一、security-approval 裁决和 outbound 最终判定仍属于本方案工作 |
| `src/shared/policy/policyPackages.ts`、`policyEngine.ts` | 当前 policy package 仍以 `desktop/wechat/feishu/automation` lane 为键；`askAnswererFor` 仍只让 automation ask 走 agent；IM 未因新增 Track 自动进入审核 Agent | 统一 domain、迁移、IM 自动审核接线仍是目标；不要把 lane 或 Track 开关视为策略统一或审批启用 |
| `electron/wechat/weChatIpc.ts`、`electron/confirmation/imChannel.ts` | `wechat:confirm-response` 仍调用 `resolveFromDesktop`，该路径能完成远程确认；`ImChannel` 文档及测试仍称支持桌面代答 | 淘汰远程动作的桌面代答；主进程 handler 必须拒绝且不能消费，或删除 handler/preload API；不能仅隐藏 renderer 按钮 |
| `electron/runtime/invocationAssembler.ts` | `materialsLane` 优先取 `materials.lane`，然后从 `remoteContext.source` 推导，缺省 desktop；未见对显式 lane/source 冲突的统一拒绝 | 添加可信入口声明与冻结 turn context；remoteContext/lane 不一致、未知入口或恢复上下文不匹配均 fail closed |
| `electron/confirmation/fallbackToUser.ts`、`invocationAssembler.ts` | Agent→user fallback 当前由 `shouldFallbackToUser` 限定 `lane === desktop`；另有 IM 同步确认与异步待办路径 | 保留 desktop-only 约束并增加回归；IM unavailable/timeout/undetermined 不得实例化 DesktopChannel，走原渠道待办或明确安全失败 |
| `electron/wechat/weChatConfirmationPromptAdapter.ts`（`708270a9`） | 此提交对 sendmessage 的 int64 `message_id` 做无损精度处理；协议常量仍标记真实客户端引用往返未验证 | 记录为已修复 ID 精度、未完成真实引用验收；启用需真实引用证据或另一个经真实验收的精确渠道批准协议 |

基线核对后，P0 需先盘点并验证已有远程确认/Track 契约，再设计新策略域与裁决接线。凡是“渠道来源字段/桌面隐藏远程批准/Track owner 隔离”已有能力，以测试确认与缺口补齐为准，不再按全新模块重建。

本方案废止任何“远程确认保留桌面代答”的旧表述。桌面确认只能消费 desktop-origin pending；IM 同步确认只由对应 `ImChannel` 的可信渠道入站解析器消费；IM 异步待办只由已认证且 channel/identity/epoch/originSession 匹配的渠道审批入口恢复。对远程 pending 的桌面 IPC 拒绝不得改变状态、批准记录或待办。若审核 Agent 需要回退到人工，继续在原渠道创建精确 IM 待办；该路径不能建立时拒绝/保持未执行。

分析报告附录 A 的 A/B 类只是候选项，不是整体放行清单。C 类里的 locked ask 与 locked confirm-every-time 不能因“锁定”被转换成 deny；locked deny 也不能因“人工批准”而放行。旧异步规格把 locked 都视为禁区的表述，实施前需要一并澄清。

## 3. 策略域和渠道分开

### 3.1 新数据形状

建议定义 `SecurityPolicyDomain = desktop | im | automation`。`ExecutionLane` 继续保留 wechat、feishu 等执行来源，用于传输和审计。主进程必须基于本次受理入口及不可变 turn context 映射 lane → domain，不能从会话创建来源、出站目标、模型参数或 UI 展示字段推断；模型和前端不能自行选择较宽松的域。跨入口新指令按当前入口创建新的裁决上下文，已有待办仍绑定原渠道/身份/会话，不迁移批准。

统一配置建议包含：schemaVersion（数据结构版本）、revision（配置修改次数）、policyBehaviorVersion（固定规则、条件与最终动作语义的版本）、IM 档位、规则覆盖、能力许可、路径约束、敏感目录、待办 TTL/限额。复用当前策略存储和配置基础设施，不给两个渠道各建一张安全表。

区别如下：

| 数据 | 归属 |
|---|---|
| 安全档位、动作规则、能力许可、全局边界 | IM 策略域 |
| 凭据、连接、渠道启用、owner 绑定 | 渠道适配器 |
| 审批模板、风险判定标准 | 全链路共同安全审核 |
| 待办编号、身份代次、消息关联、附件句柄 | channel + identity + originSession + owner + Track + 精确动作；异步待办另绑 todo/notificationVersion/authorizationEpoch |
| 审计 | 同时记录 policyDomain=im 和实际 lane/channel |

策略共享不共享用户身份。不能在飞书批准微信动作，不能因为两个绑定账号看起来相同就移交待办。桌面确认只对 desktop-origin 动作有效；不存在桌面代答 IM 的例外。IM 的 approve、deny、timeout、unavailable 和 Agent 降级均留在原渠道或转为该渠道的精确待办。

入口来源在受理边界由主进程创建不可变来源上下文，关联 accepted turn ID、当前用户消息 ID、入口类型、source channel/identity、originSession 与执行配置。桌面 submit IPC 固定为 desktop；微信/飞书路由从已验证消息构造对应来源；共享 `session.metadata.source` 仅供展示/兼容，不得作为当前指令策略依据。assembler 必须校验 materials lane、remoteContext、acceptedTurn execution config 和 durable origin context 一致；矛盾、缺失或未知来源 fail closed。唤醒/恢复从待办或 Track 冻结来源重建上下文，不能采用触发唤醒的当前渠道改写原动作来源。

### 3.2 规则按能力，不按渠道复制

规则使用“文件新建”“公开检索”“浏览器导航”“协作资源低影响写入”“主动发送”等能力分类。飞书 CLI 参数解释放在适配/事实提取层，产出的风险事实进入共同策略。

支持能力与许可能力分开：适配器说“我支持导航”，统一策略说“当前允许导航”，两者都满足才可审核和执行。能力不存在时返回 capability-unavailable，不能建“批准就能执行”的待办。

新增渠道接入契约包括：可信身份、单聊来源、能力清单、工具事实提取、受控回复、待办通知及入站关联、附件边界。未完成安全契约的渠道不得启用自动审核；不能因它映射到 im 就天然获得全部能力。

### 3.3 IPC 和设置

提供以 domain 为对象的读取、档位修改和规则覆盖接口。主进程检查动作域、不可变规则、配置 revision，再提交变更。旧传 lane 的接口只能兼容映射到 im，不能继续写渠道配置；不认识的 lane/domain 拒绝。

同一事务保存配置、提高 revision/授权 epoch、作废相关授权和待办、登记变更审计。派发端读取当前版本并做 fencing，避免用户刚关闭权限仍有动作发出。页面并发保存携带预期 revision，冲突时重新读取并说明，不能后保存覆盖前保存。

设置页只展示“桌面”“IM 远程”；规则由 shared 解析出实际动作，前端不自己计算档位效果。规则显示直接执行、自动审核、人工批准、禁止；显示适用能力，不再出现微信和飞书重复档位。门禁未通过时明确显示暂未启用的原因和当前路径。

## 4. 配置迁移怎么做

1. 收集两侧档位、规则覆盖、安全字段、禁用规则、信任缓存及 deprecated 字段的消费位置，先补导入和迁移夹具。
2. 读取旧快照，用随升级包冻结的旧语义解析器分别展开成完整生效策略；解析器标明源行为版本，并绑定升级前规则、范围条目、条件门控、产出阶段 effectiveActionFor 映射、不可变规则和旧能力许可。不能只展开 resolvePolicyRules，也不能用新 standard 映射解释旧快照。旧版本不明或不支持时阻止该迁移策略执行，不能回退新 standard。不能把 strict/standard/loose 当成可简单排序的数字。
3. 对相同能力逐项取更严格结果：禁止优先；必须人工优先于自动；能力许可取交集；敏感目录取并集；允许路径范围取交集；TTL、容量取较小有限值。无法比较的路径表达式、带条件规则和旧信任项收敛为人工或禁止，并展示原因。
4. 本方案选择“固定行为版本”持久保留：所有存量迁移配置写入冻结的 legacy 行为版本，包括看起来仍为 standard 的结果。运行时按该版本解析规则、条件和最终动作；界面显示“已保留旧策略”。合并结果不等于该版本内置档时存为该版本 custom。旧条件不能用现有 action-only 覆盖完整表达时，保存受控的版本化条件规则；不能表达的分支收紧为人工或禁止并记录差异，禁止剥离门控后放行。后续升级不能原地改写冻结版本。
5. 只有一侧存在明确旧配置时迁移其结果；两侧都无明确配置且确认为全新安装时采用新默认；已有安装无法证明用户意图时保留旧行为。自动启用仍须过门禁。旧默认与用户显式设置要有可追溯判据；无法区分时不自动放宽。
6. 事务写共同配置、版本、迁移标记和撤销代次；旧授权缓存不跨渠道升级。旧 pending 按变更影响作废，向当前合法 owner 说明需重新发起。
7. 任一步失败回滚事务，保持旧读路径；禁止一侧新配置、一侧旧配置。成功后运行只读共同源，旧字段仅留迁移快照，不再参与兜底判断。

门禁与行为版本是两件事：门禁开启只允许当前配置原本有资格的自动路径，不修改档位、覆盖或 policyBehaviorVersion。存量用户切换新 standard 必须走独立配置操作，先展示旧人工变自动等差异，取得明确选择，再事务写入新行为版本与档位、更新 revision/epoch、作废相关待办及缓存并登记审计。迁移或门禁操作不得代替这个选择。

重启按持久 behaviorVersion 加载对应定义；版本缺失、定义损坏或不匹配返回 config-error，禁止回退最新套餐。审计、待办和批准绑定行为版本，前端显示也从同版本解析。

回退保留原快照和迁移版本。恢复旧程序前先关闭自动入口并完成持久撤销，确认旧 pending 无法派发，再恢复配置；恢复快照不恢复旧批准和已失效授权。不可只把 enabled 改成 false 就宣称回退完成。

## 5. 让自动审核进入真实调用链

### 5.1 不直接改 askAnswererFor 为 IM 永远 agent

ask 仍表示人工；auto-evaluator 表示确定性快通道加审核 Agent。强制人工和用户 custom 选择的 ask 都必须保留。自动审核资格由规则和完整调用事实给出，不由“来自 IM”单独给出。

新行为版本的 IM standard 通过显式规则清单（legacy 版本不应用这些新映射）把非 locked 候选动作转换为 auto-evaluator。先覆盖检索、认证 clean 脚本、未建模但可补证脚本、新文件、导航和普通 write/execute 兜底审核。后者只是有资格补证，不是 approve 默认值。未知影响或不完整证据只能待办。

同时扩展 IM availableActions、校验与规则覆盖；去掉 effectiveActionFor 里只对 desktop 消费逐规则覆盖的限制。保持“产出动作时转换”的现有顺序，避免把 ask 提前挪到第 4 步，破坏禁止和豁免规则优先级。strict/loose 用明确范围清单，custom 不被自动映射覆盖。

### 5.2 执行顺序

1. 验证入站身份、绑定、单聊与渠道状态；能力不支持等与内容无关的拒绝可提前终止。
2. 固定真实调用 envelope，完成可信事实提取、路径规范化、脚本认证核验、CLI 影响分类、数据流与委托证据分析；检查每类事实完整度。参数齐全不等于风险事实完整。
3. 主进程生成不可变事实快照，加载当前配置的行为版本；先运行 hard-deny/critical，再运行 human-required，最后解析普通动作。提取失败、认证缺失、无法解析必须命中对应人工或禁止出口，不能被通用自动兜底覆盖。
4. 只有仍属 auto-eligible 的快照才能进入确定性快通道或 Agent；ask 直接精确人工待办。缓存也只对同快照、同版本且有资格的动作有效。
5. 补证产生新事实时，验证来源并生成新快照，从第 3 步完整重跑硬禁止、强制人工和普通规则，并重新检查外发约束；不沿用先前自动资格或批准。
6. 所有 allow、缓存和 Agent approve 都经过统一最终检查，批准绑定当前 envelope、factsHash、策略行为版本/revision、身份及 epoch。
7. 派发和恢复前重新核对环境并提取必要事实；任何变化撤销旧批准并重新裁决。hard-deny 拒绝，human-required 转精确待办，仍可自动时也必须为新快照重新取得合格裁决。只有完整匹配的快照才可经 fencing 派发。

### 5.3 补证与重新裁决契约

事实快照建议包含 invocation/envelopeHash、factsHash、事实提取器版本、证据受控引用、完整度、环境版本和单调递增的 factsRevision。批准及缓存项必须绑定这些信息；不可只绑定工具名或查询相似度。

Agent 不得编辑快照，只能提出补证请求或返回证据线索。主进程验证后追加证据，已有风险信号不能因模型解释而删除。可信提取器需要纠正旧事实时保留原记录和纠正依据，生成新版本并强制重裁决。Agent 要改脚本、参数、正文、附件或目标，视为新动作，旧批准和待办不可移用。

例如补证发现动态执行：立即废弃自动裁决候选，重新命中 human-required 并保存当前精确动作待办；发现越界写则 hard-deny，不能建可批准待办。即使缓存已命中或 Agent 已 approve，只要事实改变也按同样流程处理。

补证和重裁决设置有限轮次/时间预算，沿用审核资源限制；预算耗尽仍不得执行，授权是唯一障碍时待办，否则明确拒绝。补证不得以执行被审动作的方式验证安全。上述优先级同样适用于快通道、缓存、人工追认、重启恢复和真实派发。

引擎返回明确 answerer，装配层原样传递，出口仅按门禁做受控降级。门禁关闭时不创建自动批准和新异步动作；保留原渠道同步人工确认或明确不可用结果。桌面来源的 Agent fallback 可继续进入桌面卡；IM 来源的 Agent fallback 必须转到原 IM channel 的 deferred todo，若原渠道无法承接则明确不可用且不执行，绝不进入 DesktopChannel。测试必须覆盖真实入口受理 → accepted turn/materials → assembler → channel/IPC → deferred resume/dispatcher，而不仅测试 selectConfirmationAnswerer 辅助函数。

## 6. 调用事实要补哪些

### 6.1 MCP 检索

readOnlyHint、工具名带 search、参数没有 path 都不能证明不会泄露数据。建议维护受控的服务器身份和工具能力描述，绑定工具 schema/版本；描述变化使既有认证失效。

事实提取至少给出：操作是否有副作用、参数是否含本地资料、目的地/查询对象、数据来自公开信息还是本地敏感内容、所用账号/权限、是否完整解析。可信来源是运行时和经验证的能力描述；服务端注解只作待核实信号。

公开站内搜索且委托明确可自动审核。把本地文件内容放进查询词属于外发，即使工具只读也不能走只读豁免。陌生服务器或 schema 变化不可直接放行，能安全补证则交审核，仍不能确定则人工。

### 6.2 脚本

保留敏感路径、系统目录、动态执行、可疑未知路径、未验证语言、远程未认证脚本等人工底线。time.time 等未覆盖调用允许补证，但 Agent 的文字解释不能代替脚本认证和可验证事实。

把“存在危险行为”和“分析能力不足”分别记录。必要的脚本内容、参数、运行环境与路径分析结果进入受控审核上下文；最终批准绑定内容哈希及认证版本。补证工具仍受递归守卫，不能以审核名义执行被审脚本。

### 6.3 新文件与协作资源

新文件自动审核要求：规范化后的真实目标在 workDir 内、非敏感、目标不存在、无符号链接逃逸、内容已绑定。派发前再次检查不存在；竞态出现既有文件则停止，不能从 create 偷换为 overwrite。

飞书 CLI 先解释 argv 为资源动作，再交共同规则。高影响、未知语义、发消息、分享权限保持人工或禁止。普通低影响更新只有完整目标和修改内容可验证才自动审核，不采用“所有 lark-write 自动”的方案。

### 6.4 浏览器

导航和 act 分开。导航先核对能力许可、URL 及敏感查询；act 根据目标页面和行为识别提交、支付、删除、授权等影响。能力默认禁用时仍禁止；本轮不为提高指标修改许可默认值。

## 7. 异步人工路径

### 7.1 锁定规则的出口

新增或整理语义层区分：hard-deny、human-required、auto-eligible。由受控规则产生，不允许模型声明。locked 字段继续表示不可编辑，不能独立决定出口。

locked deny/critical 终止；locked ask/confirm-every-time 直接人工待办，不先让 Agent 批准。为此调整 gate 契约与生产者入口，复用持久化、通知、追认、恢复设施，禁止另造“强制人工待办表”。

### 7.2 审核结果

| 结果 | IM 处理 |
|---|---|
| approve 且授权与约束完整 | agent-approved，零长期缓存写入 |
| Agent 明确 deny | 终局拒绝；记录拒绝原因，不转为人工待办，不得向模型表述为已批准 |
| undetermined、timeout、暂时 unavailable | deferred，按原 IM 渠道创建精确待办并记录原始原因；待办不可用则安全失败 |
| unparsable、config-error、recursion-blocked、critical、hard-deny | 终局拒绝，不承诺批准后能执行 |
| 人工-required | 直接 deferred，标注必须用户决定的理由 |
| 待办存储失败、无可信回答者、容量满 | 明确阻止执行，不能默认为 allow |

Agent 超时沿用现有上界和并发 admission，不把它变成另一种长时间阻塞。TTL 24h、会话 5/身份 10 个 pending、原子预留、持久 epoch、envelope、租约、fencing、未知结果不重放等沿用既有约束。

### 7.3 消除重复打扰

同 invocationId 和同完整动作指纹幂等创建。为模型结果增加结构化状态：执行状态、cause、todoId、是否可重试、建议下一步。具体字段名实施时与现有工具结果契约对齐，并补 typeTests。

等待人工不是执行失败，也不是用户拒绝。回合账本记录“待批准”，允许其他独立动作继续；依赖该结果的后续动作挂起。相同或同类请求遇到 pending 时先停止重复尝试，用已有数据回复并提示待办。换关键词不会获得旧批准；安全层不能把相似动作指纹合并。

首条合法待办按已有协议立即逐条通知，不聚合成一条可含糊批准的消息；去重减少的是同一待办重复通知。独立动作仍逐条编号。补发沿用身份/epoch/TTL 校验、notificationVersion 和关联机制。异步待办两位编号永不复用及耗尽 fail closed 保持；同步活动确认码与异步待办编号保持独立，各自精确绑定 channel、identity/owner、originSession、Track 和 invocation/toolUse，异步待办另绑定 todoId、notificationVersion 与 authorizationEpoch。短码只定位待确认项，不构成授权；过期、错绑或旧通知码不得消费/派发，若以后扩展编号需单独修订协议。

## 8. 受控回复与主动外发

首版将普通任务回复从泛化工具外发中分离为可信运行时能力。建议产出 `deliveryPurpose`、绑定目的地、来源会话和内容分类事实；模型传的 recipient 不能覆盖绑定值。

普通回复自动发送必须同时满足：当前合法单聊 owner、来自当前任务、未命中禁止外发、无凭据或敏感数据、无未经授权的本地数据导出、附件合法且明确属于任务交付。条件不完整时按主动外发处理；第三方、群聊、批量导出、权限变更仍人工或禁止。

所有出口共用内容检查，包括 wechat_reply、微信发送工具、飞书系统 replyFeishuText、媒体和重试发送。专用审批通知使用最小 DTO，不含完整命令、凭据、绝对路径和不可信材料指令。工具不能把普通正文标成“通知”逃逸。

必须调整默认 outbound 兜底、缓存快捷路径和 imAsyncApprovalPolicy 的全 outbound 人工条件，并同步旧需求。保留所有禁止外发控制；新回复例外不能扩大 wechat_send 任意 userId 的能力。此项独立提交和验收；未完成时不启用例外，也不阻碍非 outbound 自动审核的评审。

## 9. 审计与效果看板

复用安全审计事件，补 policyDomain、policyRevision、实际渠道、最终动作、事实完整度、审核路径、原始降级原因、待办与派发关联。agent-approved 记 actor=agent；确定性放行记 system；人工批准记 user。不能因系统代发通知就把批准归为 system。

不要在审计里写完整正文、凭据和敏感路径。用受控引用与摘要/hash，必要的复核材料仍保存在主进程受控存储。审计展示“为什么自动”“为什么还要人”“是否已执行”，而不只显示 risk=high。

建立固定普通任务集：公开检索、报时、多轮检索、生成新文件、低影响协作修改、普通回复。每例用相同委托、工作目录、事实和能力条件分别跑桌面标准与 IM 标准；能力不可比项单列，不混进对比。

统计无真人且成功执行的调用比例、整任务完成率、人工通知数、待办率、审核超时率、审核耗时、等待时长、未授权派发数。报告样本的目标是合格搜索/报时零人工；普通任务集 IM 自动完成比例高于桌面，危险集未授权派发为零。固定任务集版本，保留每项分母，不靠提前结束任务提高数字。

## 10. 分期和完成条件

| 阶段 | 内容 | 完成条件 |
|---|---|---|
| P0 契约 | 明确锁定规则出口、普通回复例外、共同配置和旧文档冲突 | 需求/类型/矩阵同口径，现网不变 |
| P1 统一源 | 共同存储、迁移、IPC、设置、prompt | 两渠道只读共同源；差异迁移和回滚通过，旧 API 无旁路 |
| P2 事实与路径 | MCP/脚本/新文件事实，IM 自动动作与 assembler 接入 | shadow 对比通过；硬规则无退化，真实链路调用 Agent |
| P3 待办 | 强制人工异步出口、结果 cause、去重、独立任务继续 | 精确批准、撤销、重启、并发和通知失败通过；远程审批仅原渠道消费 |
| P4 回复与启用 | 受控回复、全出口外发检查、跨入口端到端门禁和灰度 | 旧外发契约同步；R13/R14 入口与审批隔离矩阵通过；既有门禁证据齐全，指标达标 |

shadow 只计算决策，不执行、不通知、不写授权缓存；敏感事实仍按现有隔离约束提供。灰度针对同一 IM 策略域/合法身份范围，不再产生微信一套、飞书一套用户配置。实施前先核实已有门禁证据，不能把文档里“机制已具备”当成验收通过。

复用 remoteAsyncApprovalGate 及既有开发计划 6.7：enabled 且 close_required=0、P1-1～P1-7、既有集成运行和 OQ 决议必须满足。新增验收证据绑定策略/代码版本，旧版本证据不能自动为新回复例外背书。

回退触发包括未授权派发、错绑批准、撤销逃逸、回复泄露；审核超时率升高只降级待办并告警，不开放自动批准。关闭入口后持久撤销、阻断旧追认/恢复、处理在途派发、登记审计，已执行结果未知不得自动重放。

## 11. 开发测试清单

| 层 | 必测内容 |
|---|---|
| shared 策略 | 微信/飞书同事实同结果；四档动作；custom ask 保持人工；locked deny 与 human-required；规则排序 |
| 数据迁移 | 两侧显式旧 standard → 升级 → 门禁开启 → 重启仍人工，独立切换新版才自动；旧 strict/loose/custom、条件和单侧配置；旧/新解析器隔离；缺失行为版本 fail closed；相同/冲突/单侧/缺失/损坏配置；条件无法比较；事务失败；重复升级；旧 IPC 和配置导入 |
| MCP/脚本事实 | 假只读注解、陌生服务、schema 变化、本地内容藏在查询词、未建模无害调用、动态执行 |
| 文件 | 新建、覆盖、符号链接、目录变更、敏感路径、派发前目标出现、内容被替换 |
| 真实调用 | 真实 assembler → 审核 → dispatcher：补证才发现动态执行/敏感路径/高影响 CLI、缓存或 approve 后事实变化，旧批准失效且无自动派发；assembler 到 Agent、快通道到 dispatcher、门禁关闭降级、强制人工进入待办 |
| 入口/确认隔离 | desktop/微信/飞书真实入站→accepted turn→assembler→policy/answerer→原渠道确认或待办→恢复/dispatcher；同会话跨入口新任务、lane/source 冲突、wake 来源漂移、IM pending 桌面 IPC 拒绝消费、Agent fallback 仅 desktop-origin 可落桌面卡 |
| 异步恢复 | 超时/解析失败/存储失败；限额并发；重复提交；TTL；撤销/批准竞态；执行未知；换绑；取消 |
| 外发 | 同 owner 普通回复、敏感附件、第三方、伪装通知、系统层回复、缓存/allow/approve 绕过尝试 |
| UI/类型 | 单 IM 入口、能力标签、实际档位显示、revision 冲突、禁用门禁说明、i18n、跨层公共契约 |
| 验收矩阵 | 复用 remoteAsyncApprovalAcceptanceMatrix.test.ts、imAsyncApproval.integration.test.ts，并加报告场景回放 |

实际开发按仓库要求先运行 npm install，按模块先跑 focused Vitest，再 npm test、typecheck:shared、typecheck:renderer、i18n:check 和 build。类型变化补 typeTests；UI 变化提供截图。本文仅新增文档，本轮不安装依赖或运行与文档无关的构建。

## 12. 实施前必须对齐的旧文档

- 异步审批安全需求 §5.3/§5.5/§11/§14：锁定规则出口、受控回复例外、档位与回答者正交。旧文档“agent 不得 loose/custom”与现有套餐注释不一致，应以新共同档位和硬底线写清。
- 远程私聊安全优化需求：共同配置源、认证和能力许可仍生效，取消按渠道重复存安全策略。
- 微信出站确认移除需求：从按工具名免确认收敛到受控 owner 任务回复，明确非普通回复不能豁免。
- 安全策略入口需求：从页面去重进一步做到存储、IPC 和运行时统一。
- 异步交互开发计划：加入真实引擎路径、强制人工待办、迁移与回复边界的门禁证据。

本轮更新三份安全改进文档，不改上述旧文件及用户已有工作区修改。实施时在同一功能变更中标出被替代条款，特别删除旧桌面代答契约并同步 IPC/测试/操作文档，防止产品文案、策略显示和运行时各说各话。

## 13. 本次评审整改对照

依据：[评审报告](../review/2026-10-11-im-security-review-improvement-plan-review.md)。

补充依据：[main 同步联合评审](../review/2026-10-12-im-security-review-improvement-main-sync-review.md)。本次新增 R13/R14 对应计划 2.1.7–2.1.9、4.1.2a–4.1.13、11.2.8；新增 R15/R16 明确标准档免打扰边界和严格档 Track 绑定的两位码确认，对应计划 3.3.8–3.3.9、4.1.14、5.2.11–5.2.13、5.3.16、11.2.8。关闭条件必须来自真实主进程 IPC 与真实入口到 dispatcher 的端到端结果。

| 阻断 | 已补的方案契约 | 关闭证据要求 |
|---|---|---|
| B1 旧策略隐式放宽 | §3.1/§4/§5.1：冻结旧解析语义，持久固定行为版本，门禁不切版本，采用新版需独立可审计配置变更 | 需求 R11 和 §11 迁移夹具通过，包括门禁开启后重启 |
| B2 补证绕过硬规则 | §5.2/§5.3：先可信提取再裁决，不可变快照，补证或动作变化废弃旧批准并重跑完整规则 | 需求 R12 和 §11 真实链路用例通过，无未授权派发 |
| B3 远程确认被桌面代答 | §1/§2.1/§3.1/§5.2：IM pending 只由原渠道消费；桌面兼容 IPC 拒绝且不消费；Agent fallback 只对 desktop-origin 生效 | 需求 R14、计划 2.1.9/4.1.11–4.1.13：真实 handler 拒绝，IM 入站仍批准，桌面本地确认仍批准，远程 fallback 不触发 DesktopChannel |
| B4 可信入口未端到端接线 | §3.1/§5.2：受理边界创建并冻结来源，传递到 accepted turn/materials/assembler/确认/待办/恢复派发，矛盾来源拒绝 | 需求 R13、计划 4.1.2a–4.1.10/4.1.13：覆盖 desktop↔IM 与跨 IM 矩阵，断言实际 domain、版本、answerer、审批渠道、旧待办绑定和 executor |
| B5 标准档错误承诺免确认 | §5.1/§7.2：仅 Agent 成功批准且最终检查通过免确认；人工底线进原渠道待办，拒绝/不确定/超时/不可用不转 allow，硬拒绝直接结束 | 需求 R15、计划 3.3.8–3.3.9/4.1.14/5.3.16：覆盖结果矩阵及真实 IM 待办/拒绝出口 |
| B6 严格档确认码错绑 | §3.1/§5.2/§7.3：同步确认码与异步待办编号分开，二者均绑定原 Track 和精确动作；异步另绑待办及通知版本 | 需求 R16、计划 5.2.11–5.2.13/5.3.16：真实渠道验证合法码只恢复原动作，错码/过期/跨域码不消费且无桌面卡 |

本轮完成文档整改，未实现或运行这些测试；本报告提出的阻断仍需复评与实施证据，不能据本文直接标记生产启用通过。

## 14. TODO：清理依赖桌面端的 IM 文案

- [ ] 优化微信回复文案，移除内部长会话 ID 和默认引导用户去桌面查会话的提示；同步检查飞书同类出口。对应需求 §11，纳入本轮交付清单。

实施时先排查渠道回复模板、进度适配器、会话创建/切换回执、错误和超时提示、审批通知以及 prompt 中的收尾要求。既要改固定模板，也要改引导模型反复输出 ID 和桌面提示的指令，避免只修一处字符串。

对用户只说任务名称、结果、当前状态和可以在 IM 中完成的下一步。内部 sessionId/requestId 留在主进程关联、日志和审计，不删除内部追踪字段，也不改变身份与批准绑定。审批继续使用现有精确待办编号；展示用任务名称不能代替授权标识。

参考文案（不是新增命令）：

| 场景 | 建议表达 |
|---|---|
| 检索完成 | “已查到最近一个月的资料，结论如下……” |
| 必须人工批准 | “这一步需要你批准：……。请回复‘批准 12’。”（12 由真实待办编号替换） |
| 部分动作等待审批 | “已完成资料整理，文件写入还在等你批准。现有结果如下……” |
| 执行失败 | “这次没有完成，原因是……。”随后只提供已支持的处理方式 |
| 切换任务完成 | “已切换到‘整理图片模型资料’，可以继续发消息。” |

如果当前 IM 没有对应能力，只说明限制和已完成部分，不用虚构“查看进度”“继续任务”等命令填补缺口；新增 IM 能力另列需求。正文中的“去桌面查看对应会话”不能作为兜底提示重新出现。

验证覆盖成功回复、进度、待办、超时、失败、切换任务及模型生成的最终答复，检查无内部长 ID、无默认桌面查会话引导、无不存在的命令。实现时更新对应文案测试与 i18n，保留内部关联和审批编号校验的回归测试；本次仅追加 TODO，未修改运行文案。
