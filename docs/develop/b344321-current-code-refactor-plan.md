# b344321 当前代码评审后的重构改进计划

## 1. 目标、边界与已关闭项

本计划以 `main` 的 `b58c126` 为基线，处理
`docs/review/b344321-current-code-review.md` 中仍然成立的 C2–C4、H1–H9、M1–M3。
计划吸收了 `docs/review/b344321-current-code-refactor-plan-review.md`、v2 与 v3 的有效意见，
并将所有实现选择收敛为单一路径。本轮明确采用 Node `fs` 防护而非新增原生模块：
远程写入仍可用且必须确认；不把它宣传为能抵御拥有本机并发文件系统控制权的强沙箱。

不在本计划范围内：

- **C1** 已由一次性飞书配对码、原子消费、过期及失败关闭流程解决，不重复改造。
- 原评审中“远程脚本 allow 后无条件跳过确认”的描述已过期；保留的是 C3 的分析器放行边界缺失。
- 不增加新的 IM 渠道、工具能力、工作目录产品能力或发布平台；下文仅调整既有能力的安全边界、数据模型和验证链路。

所有工作包均按“数据模型/安全原语与单测”及“路由接入与端到端测试”拆成独立提交。一个提交只解决一个可验证问题，避免将安全原语、UI 和发布脚本混合改动。

## 2. 核心设计决定

| 范围 | 明确决定 |
| --- | --- |
| 文件写入 | 以 Node `fs` 实现统一的受控写入协议：逐段链接检查、句柄 identity/link-count 校验、排他创建和 fsync；远程采用受限的会话级写入授权。该协议不承诺抵御拥有本机并发文件系统控制权的攻击者。 |
| 远程脚本 | 远程 `allow` 采用正向白名单；不能被静态证明安全的语法和调用一律要求确认。 |
| 原生绑定 | 仅从官方发布地址按仓库内 SHA-256 manifest 取得 Electron 绑定；不用第三方代理和运行时 `npx` 下载。 |
| IM 入站 | 两个渠道共用入站 guard；guard 返回包含授权 generation 的配置快照，并在每个可能改变外部状态的 `await` 后重新验证；微信远程仅接收文本，不下载媒体。 |
| 消息去重 | 采用 `claimed → executing → completed` 持久化状态机；崩溃后只回收未开始执行的过期 claim。 |
| IM 确认 | 只接受带确认 ID 的显式命令；裸 `Y/N` 一律不执行。 |
| 授权撤销 | 任何远程授权失效先递增渠道 generation，再原子取消该渠道全部 pending confirm；撤销线性化点之后不得开始工具执行。 |
| 微信出站 | 远程只暴露 `wechat_reply`；`wechat_send` 是桌面专用工具。 |
| 远程会话 lease | 以不可变的 `originSessionId + requestId` 标识运行所有权；切换会话不迁移运行 lease。 |

## 3. 工作包

### WP1：基于 Node `fs` 的受控工作目录写入（C2）

**现状问题**

`resolveSafePathReal()` 在新目标不存在时退回词法路径，`atomicWriteFile()` 随后的路径操作可跟随工作目录内的外部符号链接。检查与写入/rename 之间仍存在 TOCTOU 窗口，且 rename 可以替换既有目标。

**实施方案**

1. 在 `electron/pathSecurity.ts` 中抽取 `resolveSafeWriteTarget()`。它先执行词法边界校验，再从工作目录根到最近存在父目录逐段 `lstat`，拒绝符号链接、非目录组件和无法判定的组件；随后对工作目录根及最近存在父目录做 `realpath` 包含关系校验。目标已存在时也必须是普通文件。
2. 已存在目标在读取、打开后、写入前和完成后均以 `FileHandle.stat()` 验证文件 identity（设备/文件号、size、mtime）与 link count。link count 大于 1 的硬链接直接拒绝；无法取得可靠 link count 时拒绝远程写入。打开文件时使用 Node `fs.constants.O_NOFOLLOW`；运行时不支持该标志的平台仍执行上述 `lstat`、`realpath` 和句柄复核。
3. 所有写入都在已验证的真实父目录创建随机临时文件，使用 `wx` 排他创建、完整写入和 `FileHandle.sync()`。新文件通过 `fs.link(temp, target)` 提交，目标已存在即失败；新文件提交不会使用会替换既有目标的 `rename`。
4. `edit_file` 和覆盖已有文件的 `write_file` 在写入临时文件后，重新打开当前目标并校验其 identity、类型和 link count 与读取时一致，关闭验证句柄后才以 `fs.rename(temp, target)` 原子替换。提交后重新打开最终目标，校验它是普通文件、link count 为 1 且 identity 与临时文件一致。检查和 rename 之间的本机并发替换属于第 12 项已声明的残余风险。
5. 临时文件写入、`sync`、目标复核、提交和提交后复核任一步失败或收到取消，均关闭句柄并删除临时文件；原目标保持不变。现有可选检查点仍在提交前备份旧内容，但不承担原子性保障；只有提交成功才更新文件状态缓存。
6. 临时文件统一使用应用专属随机前缀；安全写入初始化时只在已验证父目录内清理该前缀的遗留普通文件。进程在 rename 前崩溃时原目标保持不变，遗留临时文件由下一次安全写入初始化清理。
7. `pathSecurity.ts` 保留纯词法读取校验；写入类工具统一改用 `resolveSafeWriteTarget()` 和新的安全原子写入 helper，删除对 `resolveSafePathReal()` 与通用 `atomicWriteFile()` 的写入依赖。旧写入辅助函数在迁移完成后删除。
7. 新建进程内 `RemoteWriteGrantRegistry`。授权记录只绑定 `channel`、认证 owner、`originSessionId`、当前 `workDirProfileId` 和 `authorizationGeneration`，有效期固定 30 分钟，最多 500 次 `write_file`/`edit_file`，工具输入内容累计最多 50 MiB；不持久化，应用重启后不存在。
8. 当前远程会话首次需要写入时，创建 `remote_write_grant` 确认并使用独立提示模板，不能复用单次工具确认文案。提示必须明确写明：“当前远程会话在指定工作目录内的临时文件写入授权”，展示会话标识、工作目录名称、30 分钟、500 次和 50 MiB 上限，并说明它只覆盖 `write_file`/`edit_file`，不包含 shell、脚本、浏览器或消息发送。用户回复 `Y <confirmId>` 后创建授权并执行本次写入。授权有效期间，同一 `originSessionId` 的后续 Agent 请求在相同工作目录内不再申请确认；每次执行前以同步 `reserve()` 预扣一次操作与本次工具输入字节，预算耗尽后再次申请新的会话级授权。`fileAutoApproved` 只能作用于桌面请求，不能覆盖远程授权检查。
9. 远程写入授权在远程关闭、服务停止、登出、owner/allowlist 变更、授权 generation 变化、origin session 删除、会话切换、工作目录切换和到期时立即撤销。每次授权、预扣、写入结果和撤销都记录 grant ID、当前 requestId、路径摘要、字节数及原因；写入前仍执行本工作包的路径、句柄和当前 request-owned lease 检查。
10. 删除 `shouldSkipRemoteFileWriteConfirm()` 的自动放行分支及 `remoteAllowLocalWrite` 的生效路径。远程写入只能由有效的会话级授权放行，不能被配置默认开启。
11. 该方案的安全声明限定为：阻止路径穿越、既有符号链接、既有硬链接、目标覆盖和常见检查后替换。Node API 没有跨平台目录句柄与 `openat`，因此不承诺阻止具备本机权限且能在检查与 `rename` 之间并发篡改目录树的攻击者；此残余风险写入远程安全说明和发布说明，不再表述为完整文件系统沙箱。

**测试与验收**

- 新文件路径、已有文件编辑、正常取消和超时保持现有行为；远程 Agent 首次确认后可在同一授权范围内连续完成写入和编辑。
- `symlink-outside/new-file.txt`、任意父级符号链接、最终目标符号链接均被拒绝。
- 工作目录目标是工作目录外文件的硬链接、读取后被替换为硬链接、提交前被替换为硬链接时均被拒绝，外部文件内容不变。
- 新文件抢先创建、临时文件抢占、目标替换、打开后替换和写入前外部修改均失败，不会覆盖既有目标。
- 模拟临时文件写入失败、磁盘写满和取消时，原有文件内容保持不变且临时文件立即清理；模拟提交前崩溃时，原有文件内容保持不变，并在下一次安全写入初始化时清理遗留临时文件；成功提交后内容完整替换。
- 首次写入产生一次授权确认；同一 origin session 在相同工作目录内连续 500 次、累计不超过 50 MiB 的写入不再确认，即使其间完成并重新发起 Agent 请求；第 501 次、超出字节预算、超时、切换工作目录或会话后必须申请新授权。远程关闭、登出、owner/allowlist 变更和 session 删除会撤销授权且后续写入不执行。
- `remote_write_grant` 的 IM 与桌面确认提示均包含“临时文件写入授权”、会话、工作目录、30 分钟、500 次、50 MiB、仅 `write_file`/`edit_file` 及明确排除的能力；缺失任一范围字段的模板测试失败。
- 需要在 macOS、Windows、Linux 的 Electron 运行时执行相同集成测试；无需新增 ABI 产物、原生模块、签名步骤或打包资源。
- 测试与文档明确区分“常见链接逃逸防护”与“完整抗本机并发文件系统攻击”；后者不作为此工作包的验收承诺。

### WP2：共享入站 guard 与微信媒体边界（H1、H3）

**现状问题**

微信在 owner 和远程运行状态校验之前下载媒体；微信和飞书的业务命令入口没有一套统一的、可在停止竞态中复用的运行门禁。

**实施方案**

1. 在 `electron/remote` 新建 `remoteAuthorizationRegistry`，按渠道维护单调递增的授权 generation。渠道关闭、远程关闭、服务停止、登出、owner 清除和 allowlist 任何变更都必须先同步调用 `invalidate(channel, reason)`：递增 generation、取消该渠道全部 pending confirm、撤销该渠道全部会话级写入授权、以 `authorization_revoked` 写入审计，再执行持久化、停止服务或后续异步操作。这一步是撤销的线性化点。
2. `invalidate()` 通过确认管理器的同步 `cancelByChannel()` 立刻把等待者解析为拒绝，并调用 `RemoteWriteGrantRegistry.revokeByChannel()`；所有待确认请求都携带 `channel`、认证 owner、`authorizationGeneration` 和 `requestId`。撤销后旧 generation 的确认不能被解析为批准，也不能继续使用既有写入授权。
3. 在 `electron/remote` 新建 `imInboundGuard`，统一接收渠道、发送者、当前配置读取函数和登录状态读取函数；成功时返回包含 owner 与 authorization generation 的不可复用授权快照。业务命令判定顺序固定为：渠道已启用、远程已启用、服务已登录/可用、发送者属于 owner allowlist。确认回复走单独的确认授权路径，不会触发新的命令执行。
4. 路由在每个会触发外部状态变化的 `await` 后调用 `guard.revalidate(snapshot)`：限流通过后、去重 claim 成功后、创建会话前以及启动 Agent 前。任一次失败即停止。
5. 微信远程入站明确只接受文本。图片、文件及其他媒体类型在初次 guard 后直接回复“远程仅支持文本指令”，不调用 `bot.download()`，不创建临时文件，也不写入 `.wechat-inbound`。移除路由对 `weChatMediaInbound` 的调用及其不再使用的下载实现。
6. 飞书和微信路由只通过 guard 和 `remoteAuthorizationRegistry` 获取授权结论，移除各自散落的同类业务门禁，确保停止、关闭远程和 allowlist 变更有唯一语义。

**测试与验收**

- 非 owner、关闭远程、未登录、停止服务、allowlist 在处理中变更、排队消息在关闭后被消费时，均不会启动 Agent。
- 图片、文件、无 `Content-Length` 的分块媒体和超大媒体都不会调用 SDK 下载接口，不产生完整内存 Buffer、临时文件或工作目录文件。
- 等待确认时关闭远程、停止服务、登出、清除 owner、变更 allowlist 都会立即取消等待、撤销写入授权并阻止工具副作用和后续 Agent 回合。
- 确认批准与撤销并发时，以 `invalidate()` 递增 generation 为线性化点；撤销后批准必定拒绝，撤销前已批准的请求在 executor 调用前仍需最后一次授权和 lease 校验。

### WP3：远程脚本的正向自动放行模型（C3）

**现状问题**

分析器对未命中规则的脚本可能返回 `allow`。即使补齐 `spawn` API，动态导入、反射属性访问、变量调用、包装函数和无法解析的语法仍可能避开命中规则。

**实施方案**

1. 保留当前 `deny` 规则，并将脚本分析结果拆为桌面 verdict 与远程 verdict；桌面继续现有确认体验，远程不复用其默认放行结果。
2. 远程只有同时满足下列条件才返回 `allow`：Python 语法完整可解析；所有 import、属性访问和调用链可静态解析；全部调用都属于显式的安全能力白名单；白名单内的文件路径是静态相对工作目录路径；不存在动态 import、`getattr`/`setattr`、`eval`/`exec`、变量承载调用对象、未知 decorator、未知上下文管理器或分析器未建模的 AST 节点。
3. 进程创建能力表统一覆盖 `os.spawn*`、`posix_spawn*`、`asyncio.create_subprocess_*`、`subprocess.*`、`pty.*`、别名及导入别名；这些调用至少返回 `ask`。网络、动态加载、删除和逃逸型文件操作沿用或强化为现有 `ask`/`deny`。
4. 远程配置中即使开启“安全脚本可跳过确认”，也只对上述远程 `allow` 生效；任何 `ask`、解析失败或未知情况都强制走 IM/桌面确认。

**测试与验收**

- 已列进程 API、`getattr(os, 'spawn' + 'v')`、`__import__`、变量别名、包装函数和解析失败全部不能获得远程 `allow`。
- 远程跳过确认开关开启时，上述脚本仍产生确认请求。
- 可解析且只使用白名单内静态安全能力的脚本获得 `allow`；现有网络、文件删除、动态库和 shell 规则不回归。

### WP4：受信任的 SQLite 绑定与可启动发布产物（C4、H8、H9）

**现状问题**

Electron ABI 仍由开放式 major 映射得出，Electron 35 会落到 ABI 130；回退路径使用第三方代理且没有可信哈希；`npx --yes` 引入未锁定下载；安装、签名和数据库启动失败并非都能阻断发布或给用户明确结果。

**实施方案**

1. 将 `node-abi` 固定为直接开发依赖并提交 lockfile，使用它从 Electron 版本解析 ABI，删除 `electronModuleAbi()` 硬编码区间。
2. 新建受版本控制保护的 `scripts/native-bindings-manifest.json`，每条记录精确绑定 `better-sqlite3` 版本、Electron ABI、平台、架构、官方 GitHub Release URL 和 SHA-256。绑定下载后先校验 SHA-256，再解包和安装。
3. 移除 `gh-proxy`、`mirror.ghproxy` 与 `npx --yes prebuild-install`。Electron 运行时绑定只由 manifest 下载；Node 开发绑定通过锁定依赖的本地源码构建，构建失败立即失败。
4. `postinstall` 不再吞掉失败；安装、打包或 ABI 校验失败均返回非零退出码。启动期数据库初始化失败显示阻塞性错误，再有序退出主进程。
5. 保留 `afterPack` 的 macOS ad-hoc 签名，确保 `CSC_IDENTITY_AUTO_DISCOVERY=false` 时仍必定执行；签名命令失败立即抛错，并紧接着在同一 `.app` 上执行 `codesign --verify --deep --strict`。新增打包后 CI 验证脚本，对 electron-builder 生成的最终 `.app` 再执行一次相同验证；它覆盖无证书时保留的 ad-hoc 签名和有证书时 electron-builder 覆盖后的正式签名。
6. 发布 CI 建立实际加载矩阵：Windows x64、macOS x64、macOS arm64、Linux x64。每项在相应 runner 上构建目标架构，并运行以 Electron 启动的 `require('better-sqlite3')` 探针。Linux x64 是构建/启动验证产物，不改变现有 Windows/macOS 发布资产范围。

**测试与验收**

- Electron 35 解析 ABI 133；manifest 中任一版本、ABI、平台、架构不匹配均在下载前失败。
- 错误哈希、被篡改归档、缺失记录、错误 ABI、缺失绑定和本地源码构建失败都使 CI 失败。
- 四项运行矩阵都实际加载 SQLite 原生模块；不是只检查 DMG、EXE 或归档存在。
- 无证书 CI 路径和配置 Developer ID 的正式签名路径都验证最终 macOS `.app`；签名命令和任一次验证失败都会失败 build job。

### WP5：IM 去重和确认的持久化协议（H4、H7）

**现状问题**

`has()` 与 `mark()` 不是原子操作，加载和保存也会并发冲突；确认解析只接受裸 Y/N，并取第一个 pending，导致重复执行、丢失投递或错误批准。

**实施方案**

1. 将 `ImProcessedStore` 改为单写队列和共享加载 Promise 管理的持久化状态机。每条记录包含 `messageId`、`state`、`claimId`、`claimedAt`、`leaseUntil`、`completedAt` 和审计结果摘要；文件以唯一临时名、`fsync`、原子替换方式保存。
2. 状态迁移固定为：guard 通过后原子写入 `claimed`；即将调用 Agent 前原子迁移为 `executing`；Agent 的成功、失败、取消和创建确认请求全部迁移为 `completed`。没有取得持久化 claim 时绝不启动 Agent。
3. 重启恢复时，仅将 lease 过期的 `claimed` 记录回收为可重新 claim；lease 过期的 `executing` 记录标记为 `completed/interrupted_uncertain` 并保留审计信息，不自动重投，防止已产生副作用的任务重复执行。解析、授权、限流和文本长度校验失败发生在 claim 之前，因此可以重试。
4. 将确认协议定义为 `Y <confirmId>`、`N <confirmId>`、`Y <confirmId> TRUST`。`confirmId` 为每条 pending 使用加密随机生成的 4 位 Crockford Base32，注册时在全局 pending 集合中检查碰撞。确认仍受 owner 私聊校验、既有频率限制和短时过期约束。注册时捕获 WP2 guard 返回的 `channel`、owner、`authorizationGeneration` 和 `requestId`。`remote_write_grant` 是独立确认类型，`Y <confirmId>` 只创建 WP1 定义的受限写入授权并继续当前写入，不会授予 shell、脚本、浏览器或出站消息权限。
5. 裸 `Y/N`、缺失 ID、格式不符、过期 ID、跨用户 ID、授权 generation 不一致和不具备信任资格的 TRUST 一律不执行，并回复协议提示。若平台提供 reply/thread 元数据，必须同时匹配原确认消息、`confirmId` 与授权发送者；缺少这些元数据时只以 `confirmId + 授权发送者` 匹配。
6. 两个确认管理器使用共享协议解析器、共享 pending 索引和 WP2 的授权 registry；确认注册、授权撤销与确认解析在同一事件循环临界区内完成，避免“第二个请求注册与第一个回复”串单。
7. 工具循环收到 `y` 后，在调用 executor 的同一同步回合内校验确认的 authorization generation、当前 guard 授权和 request-owned lease；校验与 executor 调用之间不插入 `await`。任一校验失败即记录 `authorization_revoked` 并结束该工具调用，不进入下一轮 Agent。

**测试与验收**

- 同 ID 的并发投递只获得一个 claim；不同 ID 并发持久化不互相覆盖；重启后 completed 仍去重。
- 覆盖“持久化后、执行前崩溃可重试”“执行后崩溃不重试”“执行失败成为可审计终态”“lease 过期”的恢复测试。
- 两个会话并发 pending 时，裸 Y/N 不执行；伪造、碰撞、过期、跨用户 ID 和并发注册/回复不能批准其他请求。
- 覆盖“等待确认时关闭远程、停止服务、登出、清除 owner、变更 allowlist”及“批准与撤销并发”；撤销线性化点之后没有 executor 副作用和后续 Agent 回合。

### WP6：远程发送、会话与工作目录 lease（H2、H5、H6）

**现状问题**

远程 `wechat_send` 可以使用模型给出的任意 `userId`；assistant 消息的创建 session 与完成事件可能在会话切换后分离；运行注册表只按 sessionId 记录，使当前 Agent 自己也无法切换工作目录。

**实施方案**

1. 远程工具配置始终过滤 `wechat_send`，远程提示词和工具定义只保留基于认证入站上下文的 `wechat_reply`。桌面模式保留 `wechat_send`，其 executor 不承担远程调用。
2. 将远程请求上下文显式建模为 `originSessionId`、`outboundSessionId`、`requestId`。assistant 消息创建、流式更新、完成事件、数据库状态更新、进度清理和备份调度全部绑定 `originSessionId`；IM 回复、出站后缀和后续续接使用 `outboundSessionId`。
3. 将 `remoteAgentRegistry` 从 `Set<sessionId>` 改为以 `originSessionId` 为键、含 `requestId`、`startedAt`、取消句柄和过期时间的运行 lease。claim 只有 `(originSessionId, requestId)` 完全一致时可视为当前请求所有者；`finally`、取消和超时都只能释放同一 requestId 的 lease。
4. `switch_work_dir` 将当前 `requestId` 传入 `bindSessionWorkDir`；仅持有 origin lease 的当前 Agent 可以修改自己的 session 工作目录。其他 requestId、桌面操作和无 owner 的调用继续收到 busy 错误。`switch_session` 不迁移 lease，直到原请求结束；两种切换都撤销当前 `RemoteWriteGrant`，避免授权跨越 session 或工作目录。

**测试与验收**

- 远程工具列表、提示词和执行路径都无法调用 `wechat_send`；桌面 `wechat_send` 保持可用。
- 会话切换后，assistant 消息、streaming/完成状态、审计、进度清理和备份均落在 origin session，IM 出站使用 outbound session。
- 当前远程 Agent 可以切换工作目录，并且下一工具调用使用新目录；不同 requestId 的并发切换、取消后切换、超时后切换和重复 requestId 都符合 lease 所有权规则。会话或工作目录切换后，旧写入授权不能继续使用。

### WP7：渲染竞态、完整备份与类型边界（M1、M2、M3）

**实施方案**

1. `remoteSessionSwitchService` 为每次切换创建单调递增 token；消息加载完成后仅当 token 和 `currentSessionId` 仍匹配时提交 `setMessages`。工作目录切换成功而消息加载失败时，以同一 token 回滚桌面选择和 UI 状态。
2. 备份导出使用按 sequence 的分页读取和流式 JSON 写出，直到无下一页；写入任何一页失败即删除临时备份并报告失败，不能生成不完整 `messages.json`。
3. 新建 `tsconfig.renderer.json`，仅包含 `src/renderer` 与其需要的 `src/shared`，排除 Electron 主进程。`configSet` payload 明确加入 `wechat` 和 `workspaceLayout`，新增 `typecheck:renderer` 脚本并在 CI 的质量门禁中执行。

**测试与验收**

- 不同会话快速切换、加载失败和后发先至响应均不会让旧会话消息覆盖当前会话。
- 10,001 条及多页消息的备份/恢复完整且 sequence 稳定；中途失败不保留可被恢复的不完整文件。
- 设置页的真实 `wechat`、`workspaceLayout` 调用通过 renderer 类型检查；删去任一字段会在 CI 失败。

## 4. 实施依赖与合并顺序

```text
WP1 Node 写入核心 ───────────────────────────── WP1 会话级写入授权接入
WP2 授权基础 ────────────────────────────────── WP5 去重状态机 + 确认协议 ──┘
                                                                                 └─ WP2 路由接入与文本边界
WP3 远程脚本分析 ─────────────────────────────── 独立安全提交
WP4 原生绑定 manifest + 发布验证 ─────────────── 独立构建链路提交
WP6 远程路由/会话/目录 lease ─────────────────── 独立一致性提交
WP7 UI/备份/类型检查 ─────────────────────────── 独立一致性提交
```

推荐合并顺序：WP1 Node 写入核心；WP2 授权 generation registry 与配置变更测试；WP5 去重和确认状态机；WP1 会话级写入授权接入；WP2 guard 与渠道路由接入；WP3；WP4 manifest 与下载链路；WP4 启动/签名/CI 矩阵；WP6；WP7。WP2 路由接入只调用共享 guard 和 registry，不在渠道路由中复制授权逻辑。

## 5. 总体验收门槛

合并前必须满足：

1. 每个工作包的攻击、竞态、崩溃恢复和负向测试通过，且测试断言外部可观察行为，不只覆盖内部 helper。
2. 全量单测、Electron 主进程类型检查、`typecheck:renderer`、renderer 构建和 Electron 构建通过。
3. Windows x64、macOS x64、macOS arm64、Linux x64 的 SQLite Electron 加载探针通过；最终 macOS app 的签名验证通过。
4. `git diff --check` 通过；旧的路径写入、媒体下载、去重和裸确认分支已删除，没有遗留兼容回退。
5. 每个提交的说明记录修改原因、状态/协议迁移、执行过的验证命令与已知平台限制。
