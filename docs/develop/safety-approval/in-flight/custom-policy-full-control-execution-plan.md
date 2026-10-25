# 自定义安全策略完整可配置执行计划

- **日期：** 2026-10-22
- **状态：** 2026-10-25 v9 重审重新打开 T3、T5、T6 与 Phase 3 关闭门槛。两项 P1 已按源码审查结论修复并由定向自动化覆盖：deferred receipt 绑定 IM 行为版本/revision/epoch；claim 后发现 fresh ask 时，同一 todo 重新进入策略重判并替换旧审批；ingress/exposure 等待接收策略变更并取消旧审批。自动化和完整构建已复验；隔离 arm64 GUI 已验证桌面自定义动作即时保存及恢复默认，真实 IM 尚待最后复验。T9 本机最终验收与此前微信 owner 只读请求、arm64 用户域 PKG 安装/启动记录保留。飞书 owner 场景、arm64 DMG、其它目标平台验收仍未完成；Windows 打包按用户要求跳过。
- **2026-10-25 v9 P1 修复验证：** deferred dispatch 现在保留并传递真实 caller 的 `FRESH_APPROVAL_REQUIRED` 明确未执行结果；只有该结果可将 consumed todo 事务性重开为 invalidated，再经当前策略重新求值、更新 envelope 并替换审批，不复用旧 receipt。ingress/exposure 等待接收策略变更并取消旧审批，重新检查最新规则。合并 T3/T5/T6 集合 31 files / 624 tests 通过；`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`、`npm run check:system-invariant-registry`、`npm run build:electron:incremental`、`npm run build`、`git diff --check` 通过。隔离 profile 下安全策略页完整显示中文；桌面 `outbound-mode-standard-review` 从标准切到自定义并改为“直接执行”后即时提示“策略已保存”，界面出现“已覆盖 / 恢复默认”；点击恢复默认后动作回到“人工批准”且覆盖标记消失。隔离 SQLite 只读结果为 `selectedPackage=custom`、该规则 override 缺失、revision=3。未完成重启后的持久化 GUI 复验：错误地通过 `open -na` 重开时，macOS 忽略了隔离参数并启动默认 userData 实例；看到会话与“微信监听中”后立即退出，未点击该窗口、未发消息或批准；WeChat/Feishu CLI 无存活进程且日志时间未变化。该次 GUI 记录只以隔离数据库和首次直接启动窗口为证，不声称已完成 IM 弹窗 GUI 或真实 IM 验收。
- **2026-10-25 deferred 微信 owner 验收：** 最新修复提交 `64ff60bd`、`80366b70` 在已绑定微信隔离 profile 运行后，owner 发送只读请求读取当前工作目录 `package.json` 的 `name` 与 `version`。实际回复返回 `name: spaceassistant`、`version: 0.2.9`，并附“未修改任何文件”；按用户明确确认，此额外说明不影响验收。SQLite deferred result 状态为 `completed`；微信日志确认 owner 请求进入、敏感读取确认提示送达、owner 确认收到、completion wake 启动、`wechat.agent.remote.done` 成功及回复发送（textLen 58）。执行只调用只读 `read_file`，未修改文件。此项验证真实微信 owner 的 deferred 确认、恢复、工具结果回注和最终回复链路，不替代飞书或写操作策略场景。
- **2026-10-25 最新源码构建与 arm64 用户域 PKG：** 在提交 `64ff60bd` / `80366b70` 后运行 `npm run build` 通过（renderer 仅有既存 ineffective dynamic import 与 chunk size 警告；Electron 边界检查通过）。`npx electron-builder --mac pkg --arm64 --publish never` 生成 `release/SpaceAssistant-0.2.9-arm64.pkg`，SHA-256=`052d9f316fe8ba0d8fe9940267eb0afea8b1dd0b443b1ebe0f606a9a8a5e6512`；PKG 无签名，payload app `codesign --verify --deep --strict` 通过。使用先前授权的 `installer -allowUntrusted` 安装到 `/Users/space/Applications/SpaceAssistant.app` 成功，未覆盖 `/Applications/SpaceAssistant.app`。显式隔离 `--user-data-dir` 启动后，数据库迁移、session-storage 恢复、Feishu/WeChat auto-start 检查、renderer `did-finish-load`、window ready-to-show 与 first paint 均记录 `outcome=ok`，appVersion=`0.2.9`、Electron=`44.1.1`、SQLite=`3.53.3`。此项关闭最新提交在本机 arm64 用户域 PKG 的安装/启动冒烟验收，不代表签名公证、DMG 或其他平台验收。
- **2026-10-24 v8 评审修复记录：** 修复 deferred IM claim 失效后的新策略重判、ingress/exposure 丢弃旧审批答案、非 custom 桌面套餐显示默认套餐动作，以及相同动作覆盖仍提供恢复默认入口。RED 用例逐项复现；GREEN 定向 5 files / 97 tests、依赖图 127 files / 1,932 tests、全量 `npm test` 1,107 files passed / 1 skipped / 10,794 tests passed / 112 skipped。`typecheck:renderer`、`typecheck:shared`、`check:system-invariant-registry`（10 registrations / 37 refs）、`npm run build` 与 `git diff --check` 通过；提交 `4d99fd58`，工作树干净。全量测试输出有既存 `MaxListenersExceededWarning`，没有失败项。当时 native GUI 复验因 CUA 返回 macOS locked 未能进行；该待验项已由 2026-10-25 隔离 GUI 记录关闭，不需要登录 IM。
- **2026-10-24 当前源码 arm64 PKG 验证：** 从干净提交 `f03a4109cce6ae3c36f6bb342a56e26dde98facf` 运行 `npx electron-builder --mac pkg --arm64 --publish never`，产物 `release/SpaceAssistant-0.2.9-arm64.pkg` 为 193 MB，SHA-256=`be6558dfde8409f75a9a048c14ece20dd19b7ccca254c536e13faaa374eb78b0`；包内 build identity 为 `sourceTreeClean=true`、buildId=`2cb86888-8d6f-45ff-b43f-08b455583842`、arch=`arm64`。`pkgutil --payload-files` 与 `--expand-full` 确认包含 SpaceAssistant.app；解出 app 的 `codesign --verify --deep --strict` 通过，app.asar 与本次构建 bundle 一致（SHA-256=`7900aa1a4fab40595c37957abd0d129b6f3d6a82daa1008badd31ba06f5c0aa2`）。PKG 本身无签名，app 为 ad-hoc 签名；此为 payload 静态核验，不等同系统安装或 GUI 启动验收。
- **2026-10-25 隔离 native GUI 复验：** 使用当前 `release/mac-arm64/SpaceAssistant.app`，通过 `SPACEASSISTANT_DEV=1 --user-data-dir=<worktree>/.test-artifacts/custom-policy-full-control/gui-acceptance-20261025/profile` 启动；Electron 实际 profile 为新建的 `profile-dev`，数据库位于该目录，初始状态无会话、无模型且远程监听未启用。自定义套餐中将 `outbound-mode-standard-review` 覆盖为“直接执行”，界面出现“已覆盖 / 恢复默认”；再选回等于默认的“人工批准”，恢复入口仍存在。切回“标准”套餐后，动作显示套餐值“自动审核”，覆盖状态保留；应用退出重启后套餐、动作和覆盖状态一致，点击“恢复默认”后覆盖标记消失。GUI 复验未登录 IM。第一次仅设置 `HOME` 的启动仍使用 macOS 默认 userData 并显示已有数据，随即退出且没有修改设置；后续改用隔离 `--user-data-dir` 完成全部操作。该项关闭本机非 IM GUI 检查，不替代 IM owner、正式系统安装、DMG 或目标平台验收。
- **2026-10-25 DiskImages 复核：** `hdiutil info` 当前可返回，但仍列出本工作树创建的 `/dev/disk23`（T10 sparseimage）、`disk24` / `disk25`（诊断 sparseimage）、`disk28` / `disk29`（两次 DMG 探针）；`diskutil info` 确认它们均无文件系统且未挂载。仅对自建的 `/dev/disk23` 发起非 force `hdiutil detach`，10 秒无响应后中断调用；不再尝试其它设备或 force 卸载，也未重新创建 DMG。正式安装隔离卷和 DMG 在 DiskImages 恢复前仍无法验收。
- **2026-10-25 IM 测试环境准备：** 将现有模型列表、LLM 服务路由配置和当前活动服务的加密凭据复制到隔离 profile `gui-acceptance-20261025/profile-dev`，事务内只写 14 条配置记录；未复制会话、消息或 IM 账号凭据，也未输出明文密钥。随后只复制飞书 `appConfigured` 状态和区域，不复制账号授权、远程启用状态或 Owner 身份；事务写入时 `enabled=false`、`userAuthorized=false`、`remoteEnabled=false`、allowlist 为空。复核为 11 个模型、1 个活动服务、活动凭据存在、0 条会话；隔离应用启动日志显示数据库迁移与 renderer 加载完成。桌面解锁后，主界面显示 `deepseek-flash`、无会话且远程监听关闭；微信设置页显示“绑定微信”及 SDK 2.2.0 已就绪，本轮未触发绑定。飞书页确认“应用已配置”开启、“登录飞书账号”尚未完成、集成与远程监听均关闭、Owner 未绑定。当前隔离 GUI 停在飞书设置页，等待用户本人登录飞书并绑定微信后再跑 owner 验收。
- **2026-10-25 PKG 用户域安装准备：** `installer -dominfo -plist` 与 PKG `Distribution` 确认支持 `CurrentUserHomeDirectory`；当前用户域目标 `~/Applications/SpaceAssistant.app` 不存在，系统域 `/Applications/SpaceAssistant.app` 不作为本次目标。当前 PKG 为 arm64、版本 0.2.9、SHA-256=`be6558dfde8409f75a9a048c14ece20dd19b7ccca254c536e13faaa374eb78b0`，无包签名；应用为 ad-hoc 签名且 `codesign --verify --deep --strict` 通过。用户已明确同意通过 `installer -allowUntrusted` 安装到用户域并以隔离 user-data-dir 启动验收；若安装器要求管理员凭据则停止交由用户处理。
- **2026-10-25 PKG 用户域安装与 GUI 启动验收：** 在已获用户明确授权后运行 `installer -allowUntrusted -pkg release/SpaceAssistant-0.2.9-arm64.pkg -target CurrentUserHomeDirectory -verboseR`，安装器返回“软件已成功安装”，目标为 `/Users/space/Applications/SpaceAssistant.app`，未请求管理员凭据；未覆盖 `/Applications/SpaceAssistant.app`。安装 app 的 `app.asar` SHA-256 与 `release/mac-arm64/SpaceAssistant.app` 一致（`7900aa1a4fab40595c37957abd0d129b6f3d6a82daa1008badd31ba06f5c0aa2`），`codesign --verify --deep --strict` 通过。安装版本通过显式 `--user-data-dir=<worktree>/.test-artifacts/custom-policy-full-control/gui-acceptance-20261025/profile` 启动，GUI 首屏加载完成，显示 `deepseek-flash`、0 条会话；安全策略页完整载入并呈现桌面规则；微信设置显示 SDK 2.2.0 已就绪、“绑定微信”入口；飞书设置显示“应用已配置”，账号未登录、集成与远程监听关闭、Owner 未绑定。此证据关闭本机 arm64 用户域 PKG 安装/启动验收，不覆盖系统域安装、DMG 或其他平台；真实 IM owner 流程仍待用户登录/绑定后执行。
- **2026-10-25 绑定前状态复核（历史）：** 当时安装版仍以隔离 `--user-data-dir` 运行；只读查询确认飞书 `userAuthorized=false`、微信 `loggedIn=false`，两端 `remoteEnabled=false`，飞书 allowlist 为空。CUA 当时因 macOS 锁屏拒绝读取 GUI，未尝试解锁或改动设置。随后用户完成微信绑定并解锁 GUI，当前状态与该历史快照不同；arm64 用户域 PKG 安装/启动已有上条完整 GUI 证据。
- **2026-10-25 微信 owner 场景准备与回归修复：** 用户完成微信 SDK 扫码绑定；安装版微信页显示“已绑定 / 监听中”。排查发现配置 DB 的微信 `enabled=false`，而 CLI 日志在成功登录、启动 poll 后记录全局 `config:set` 写入整份旧 renderer snapshot，并触发 `authorization_revoked/channel_disabled`；`imInboundGuard` 因而拒绝该渠道入站。日志只按允许级别提取事件名/原因，未读取或输出 owner ID、凭据或消息正文；未触发 owner 消息或审批工具。TDD 新增过期快照覆盖 WeChat lifecycle 与 Feishu owner allowlist 的 `config:set` 回归，以及已登录 owner `wechat:poll-start` 应修复陈旧 disabled flag 的 IPC 集成用例：RED 均复现，GREEN 后 `electron/configIpc.keyAtomicity.test.ts`、`electron/wechat/weChatConfig.test.ts`、`electron/wechat/weChatIpc.test.ts` 共 12 项通过。修复仅允许全局设置写用户可编辑偏好；WeChat login/binding/poll lifecycle 继续由专属 IPC 管理，Feishu owner allowlist 继续由绑定 IPC 管理；登录用户启动微信监听时同步启用该渠道。`npm run build:electron:incremental`、`npm run check:system-invariant-registry` 通过。已绑定 profile 当前仍运行旧安装版，真实 owner 入站测试须更新 app 后重试。
- **2026-10-25 微信更新包与运行态复验（未闭合）：** 提交 `f24afc2f` 后运行 `npm run build` 与 `npx electron-builder --mac pkg --arm64 --publish never`，生成 arm64 PKG SHA-256=`c0c0f51717d3d742f9eced027097f84d987a2e9411afd3d618972165a70f3574`；包内 app `codesign --verify --deep --strict` 通过，用户域安装成功，安装版与构建版 `app.asar` SHA-256 均为 `c3dbb7d8b13bb8819427623bf32b05fa460148c9d10372ff78fdc14d2189042d`。更新后应用 SDK 就绪（2.2.0），但初次绑定发生在另一隔离 profile；不能将其运行态登录误记为当前安装 profile 已登录。安装版真实微信状态须以当前 profile 的连接状态为准。此前模型配置写入 profile-dev 而安装版实际使用 profile，故该次“模型不可用”不构成应用缺陷证据。Windows 未打包。
- **2026-10-25 安装版 profile 路径校正与模型复验：** 对安装版进程执行只读 `lsof`，确认实际数据库为 `.test-artifacts/custom-policy-full-control/gui-acceptance-20261025/profile/spaceassistant-data.db`；此前写入的 `profile-dev` 是独立隔离目录。先对活动 profile DB 做权限受限备份，再按用户此前要求从当前用户 profile 复制 LLM 服务/模型路由配置与加密凭据密文，不读取或输出明文 Key；保留该 profile 原有微信配置。重启后主界面显示 `deepseek-flash`，设置页显示“已配置 Key”，模型池可选，点击“测试连接”后 GUI 显示“连接成功”。微信设置页 SDK 就绪（2.2.0），当前显示绑定入口；用户扫码二维码待完成。真实 owner 消息、工具/审批链尚未运行；本项只关闭隔离安装 profile 的模型配置与连通性准备，不关闭 IM owner 验收。
- **2026-10-25 微信隔离 profile 登录态恢复：** `lsof` 确认安装版使用 `profile`，而用户此前已扫码的测试凭据位于同一 worktree 的 `profile-dev`。备份目标 profile 后，将隔离 SDK 凭据与 poll cursor 迁入安装版隔离 profile；仅恢复 owner allowlist/WeChat 设置，并先将 `enabled`、`remoteEnabled` 置 false，由安装版启动监听动作完成 runtime 登录复核和启用。配置镜像 `loggedIn=true` 后 SDK 从本地凭据成功恢复，GUI 显示已绑定；点击启动监听后 GUI 显示监听中，DB 三个 lifecycle 标志均 true，白名单长度为 1，CLI 事件确认 `wechat.poll.started`。未输出凭据、owner ID 或消息正文；截至本记录尚未观察到用户 owner 入站消息，故没有将真实消息验收记为通过。
- **2026-10-25 arm64 DMG 重试：** 在 `hdiutil info -plist` 成功返回（全局 25 个 image，5 个属于本 worktree）后，只运行 `npx electron-builder --mac dmg --arm64 --publish never`，未运行 Windows/x64 打包。electron-builder 重新封装 app，afterPack 与 ad-hoc codesign 校验通过；app.asar SHA-256=`c3dbb7d8b13bb8819427623bf32b05fa460148c9d10372ff78fdc14d2189042d`，与当前用户域安装版一致。DMG 阶段运行 `hdiutil create ... -format UDRW -fs APFS`；临时 `0.dmg` 写到 779,742,720 bytes 后约 103 秒无增长，hdiutil 与 DiskImages helper 均处于休眠、CPU 0%，hdiutil 不再持有镜像文件且目标 `release/SpaceAssistant-0.2.9-arm64.dmg` 未生成。仅对本轮 electron-builder session 发送 SIGINT；临时文件清理，`hdiutil info -plist` 复查全局 image 数仍为 25，5 个 worktree 挂载项不变。未卸载任何镜像、未终止 DiskImages helper；arm64 DMG 仍未验收。
- **方案真源：** [自定义安全策略完整可配置开发计划](./custom-policy-full-control-development-plan.md)
- **验收与不变量真源：** 方案 INV-01–INV-10；产品行为 AC-1–AC-22 以需求稿为准
- **代码基线：** `109a938404124235d632e4cdbd4f9e06eaa48728`

2026-10-24 v2 重审关闭记录：修复 S1–S4。S1 为策略变化后的 SDK recheck 标记专用 `policyChanged` 阶段，fresh allow 建立不含旧 receipt 的最终授权基线，并允许真实 registered tool adapter 重新规划；组合回归覆盖策略版本变化后 executor 恰好派发一次。S2 保留有效范围内的用户记忆，同时确保 default MCP ask 不被 MCP allow cache 绕过、显式 ask 不被缓存/快捷 allow 跳过，独立 ask 不被 `askUnless` 隐藏。S3 移除 `mcp-tool-ask` 对 `mcp-public-read` 的排除，明确 deny 覆盖完整 MCP 工具事实。S4 对重判/替换审批通知期间到达的策略变更置 dirty，并在当前串行处理释放后重新扫描持久 todo。定向跨域集合 21 files / 655 tests passed；新增/重点回归覆盖真实 SDK+Electron gate+registered executor 和审批通知并发窗口。`typecheck:shared`、`typecheck:renderer`、`check:system-invariant-registry`、`check:agent-sdk`、i18n normal/strict、`build:electron:incremental` 与 `git diff --check` 均通过。此前全量源码验收结果见下文；本轮尚未重跑全量测试，真实 IM owner 与正式安装/DMG/目标平台验收仍待完成。

2026-10-24 v3 重审关闭记录：V3-1 将所有未声明记忆例外的命中 ask 置于 allow 缓存之前，并由规则 `cacheableAsk` 明确标识确实支持精确用户记忆的脚本、浏览器域名与远程写路径；ask tie-break 由完整匹配集合决定，用户 ask 不再依赖规则排序或缓存键种类。对 ask 转换成自动审核的规则，仍先跑审核器再读取缓存。V3-2 在 permit-bound dispatch 明确返回未进入 executor 的 `AUTHORIZATION_STALE` 时，消费并关闭旧派发材料、清除旧确认、标记 policyChanged 后回到最多 8 次的 prepare/gate 循环；新 allow 可用新 plan/facts 派发一次，新 ask 重新请求批准，新 deny 终止。已进入 executor 的异常路径不重试。T3/T5/T6 针对本轮反例重新闭合；核心/邻接集合 11 files / 623 tests passed，policy rule 契约集合 5 files / 74 tests passed（其中 policyPackages.test.ts 与前组重叠）。`typecheck:shared`、`typecheck:renderer`、`check:system-invariant-registry`、`check:agent-sdk` 与 `build:electron:incremental` 通过；本轮未重跑全量 `npm test`。T10 真实 IM owner、系统安装、DMG 与目标平台验收仍未完成。

2026-10-24 v4 重审关闭记录：V4-1 将 `policyChanged` 作为 permit binding 的受控标记，由 SDK 仅在执行器未进入的 `AUTHORIZATION_STALE` 重入准备阶段传入，真实 Electron safety policy 在没有旧 baseline 时据此启动全新的 gate 裁决；新 allow 发放新 permit，新 ask 保存未确认的新 baseline 供重新批准，新 deny 终止。旧 receipt 与 permit 不复用。V4-2 在更新 dispatch 状态前先捕获 started 投影，并先写入 `AUTHORIZATION_STALE` 的 not-dispatched 结算事件，再把状态复位并重入 gate。真实 `createAgentSdkSafetyPolicy` + `SafetyGate` + permit-bound execution port + SDK 组合覆盖 allow/ask/deny；6 files / 276 tests passed，包含历史事件顺序与 registered adapter binding 传递。`typecheck:shared`、`typecheck:renderer`、`check:system-invariant-registry`、`check:agent-sdk`、`build:electron:incremental` 通过；全量 `npm test` 未重跑。T5/T6 的本机 claim 正向/拒绝与 attempt 结算边界已有真实 adapter 组合证据；T10 外部 IM 与安装/DMG/目标平台验收仍未完成。

2026-10-24 T10 DiskImages 复探：只读 `hdiutil info -plist` 可返回并列出 21 个映像。随后在 `.test-artifacts/custom-policy-full-control/dmg-diagnostic/recheck-20261024/policy-probe.sparseimage` 定向创建 32 MB APFS sparseimage；25 秒未返回，终止创建命令后确认该探针仍被 DiskImages 附加为 `/dev/disk26`（未发现对应文件系统挂载点）。仅对该新建探针执行 `hdiutil detach /dev/disk26`，15 秒仍无响应并终止调用方；未触碰既有映像或其他卷。该环境暂不能安全继续 DMG 或隔离系统安装验收；保留探针文件供后续诊断，待 DiskImages 恢复后先处理该映像，再重试 T10。真实 IM owner 场景也仍待外部验收。

本轮执行记录（2026-10-23）：T0 逐条盘点 101 条规则并核验 writer/consumer/批准后续路径；T1b 对照基线 `109a9384` 记录 UI 范围（追溯记录，时间偏晚已注明）。Phase 0 收尾 5 文件 / 178 项通过；Phase 1 收尾 19 文件 / 347 项通过（含 deniedTools 不可绕过与同级 ask 稳定选择）；Phase 2 收尾 9 文件 / 89 项通过，包含旧 toggle 兼容 shim 的 allow/reset 两条路径，以及 shared/renderer 类型检查。Phase 3 合并集合 15 文件 / 471 项通过；另有 Desktop Hosted policy-change 用例 1 项通过，`typecheck:shared` 与 Electron incremental build 通过。Phase 4 renderer 合并用例 21 项通过，i18n normal/strict 与 renderer typecheck 通过；Impeccable detector 返回 `[]`。Phase 5 T8 已删除旧 rule-enabled shim，并完成 AC/INV 矩阵；跨域集合 40 文件 / 802 项通过。Strict i18n 报出的 1714 条均位于测试文件（符合仓库例外），源码为 0。T9 隔离 SQLite 回滚演练与全仓最终验收已完成。T10 已尝试 macOS 包验收：x64 app bundle 构建并通过 ad-hoc signature verification，app.asar SHA-256=`7f1975aa8c7b1700000cdf8b70c6aa9b49f8e1ca5badf59eaee340fd71b0fcc1`；DMG 创建时 electron-builder 与直接 hdiutil 均超时。随后直接运行发布流水线使用的 `npx electron-builder --mac pkg --x64 --publish never` 成功生成 199 MB x64 PKG，SHA-256=`60fa15fe35424a91a01b53d983a232477c56225b63be50365ee89bdcf35a5c1c`；干净树重建身份为 commit `5a9739c25e84df4906b585fdef1cd86308a3949d`、buildId `4e936b85-22e6-4f2e-8084-a996ae2d1bab`、`sourceTreeClean=true`；`verify:macos-app` 与 `verify:rg:package` 通过，PKG payload 包含 app。PKG 未签名，app 为 ad-hoc 签名，当前 DMG/arm64 均未验收。以上为早期记录；后续已完成隔离包 GUI、启动迁移和重启持久性验证，数据库与自动化回归进展见 T10 最新状态。

本轮计划评审（2026-10-22）处理：B1 全规则覆盖及消费点、B4 T4/T7/T8 的兼容接口顺序；B2/B3/B5 分别在 T6/T5/T4 按最小范围补充。负责人确认 ingress 消息须经批准后才进入处理，exposure 对象须经批准后才暴露；这是本期必做能力，见需求 AC-21/AC-22。

2026-10-24 重审修复记录：R1–R4 的 adapter 新策略转换、同步 waiter 先取消竞态、父 floor 授权上界、自动审核与 automation deny 缓存顺序已修复；合并 14 个相关测试文件 / 526 项通过。IM deferred policy-change 的持久 todo 重判已接线：策略提交通知 bundle runtime，Feishu/WeChat lane 以真实 `executeDeferredImTool` gate 重评；allow 继续同一原 envelope，ask 替换旧审批，deny 收束且不派发，启动恢复会处理失效 todo。新增 IPC 策略写入→runtime→真实 gate→原 executor 组合矩阵，覆盖两条 lane 的 allow/ask/deny 与 claim 后再改 deny；Phase 3 定向 15 文件 / 260 项通过，T5/T6 与 v9 P1 重新打开 Phase 3：当前新 ask 的 deferred requeue 与 GUI 验收未完成。T7 补齐 101 条默认规则原因的 zh-CN/en-US 文案及 scope 规则映射；renderer 31 项通过、renderer build/typecheck、i18n normal/strict 通过；隔离打包 GUI 已核验 Desktop 与 Remote IM 英文显示完整一致。重审契约复验 `policyEngine`、`invocationAssembler`、`agentSdkSafetyPolicy`、`deferredImBundleRuntime`、`agentSdkConfirmationPort` 5 文件 / 285 tests passed，覆盖显式父 deny、显式 auto 对旧 allow 缓存、automation 明确 deny、策略变更后的 ask/allow/deny 及真实 caller 组合。另已用当前源码完成 macOS arm64 PKG，SHA-256=`cc4eb8ae3bc4e45221e7709fcae3057c9e1cebbec674351500b6a4d754375342`；payload app.asar SHA-256=`9357548aff0c05e7ad2d97705f3c3239c3064084ac63a595572a88bfa5d0bd5a`，PKG 无签名、app ad-hoc 签名校验通过。从展开 payload 以独立 profile 启动成功，GUI 核验 Desktop/IM 设置中文显示及逐次真人确认文案，没有登录或发送 IM。全仓最终验收、真实 IM 与正式发布平台验收仍待后续计划阶段。

2026-10-24 本机最终复验：修正共享 invocation 契约不允许函数属性这一边界后，host-only exposure policy reader 改为 `AgentHostPorts` 接口方法，由 Electron assembler 提供实现，不进入可序列化 invocation 契约。契约形状 + invocation assembler / tool loop 定向回归 3 files / 96 tests passed。`npm run test:renderer` 348 files passed，2558 passed / 2 skipped；`npm run test:electron` 726 files passed / 1 skipped，7807 passed / 110 skipped。最终 `typecheck:shared`、`typecheck:renderer`、`check:system-invariant-registry`（10 registrations / 37 refs）、`check:agent-sdk`、`i18n:check`、`i18n:check:strict` 与 `build:electron:incremental` 通过；i18n 命中 1748 条均在测试、源码 0；`git diff --check` 通过。T9 本机源码及自动化门禁收敛；当前未做真实 IM 登录/发送。T10 仍只剩真实微信/飞书 owner 场景，以及系统级安装、DMG 与目标发布平台验收；PKG 无 Developer ID 签名，DMG 受当前 DiskImages 子系统无响应影响，未声称发布关闭。

> 本文只维护任务状态、依赖和执行证据。需求行为、阶段边界与回退语义不在本文另行定义。状态只用 `- [ ]` 未开始、`- [～]` 进行中、`- [x]` 有证据完成。

## 当前环境验收边界

**当前机器可完成并可作为源码阶段门禁：** 定向 Vitest、Electron/renderer/shared 类型检查、增量 Electron 构建、i18n 检查、数据库 transaction harness、授权版本/派发屏障测试、executor spy、迁移 fixture 与回滚演练。

**需外部环境验收，不阻塞源码阶段：** 真实微信/飞书 owner 账号和异步审批待办；macOS 系统级 PKG 安装、DMG 生成与发布支持平台验证。Electron 桌面策略 UI、设置持久化、旧库隔离副本迁移/重启/恢复副本核对均已完成；外部环境项未完成前，发布/启用验收保持待完成。

## 任务依赖表（唯一 DAG 真源）

| 任务 | 直接依赖 | AC / INV 关联 |
|---|---|---|
| T0 基线盘点与变更前测绘 | — | 所有 AC；F-01–F-11 |
| T1a 界面归属卡批准记录 | — | D-UI；AC-1、AC-7–AC-9、AC-19 |
| T1b 方案期视觉基线 | T0 | D-UI；AC-1、AC-7–AC-9、AC-19 |
| T2 全规则动作域与覆盖合同 | T0 | AC-1–AC-6；INV-01、INV-02 |
| T3 invocation/ingress/exposure 策略消费 | T2 | AC-1–AC-6、AC-10–AC-12、AC-21–AC-22；INV-01–INV-03 |
| T4 Desktop/IM 旧停用迁移与兼容写入契约 | T3 | AC-7–AC-10、AC-19–AC-20；INV-04、INV-07 |
| T5 策略 revision 与待审批失效接线 | T4 | AC-13–AC-14、AC-18–AC-20；INV-05、INV-07 |
| T6 执行器派发线性化与 stale policy 拦截 | T3、T5 | AC-15–AC-18；INV-05、INV-06 |
| T7 设置 UI 与 i18n | T1a、T1b、T2、T3、T4、T5、T6 | AC-1、AC-7–AC-9、AC-19、AC-21–AC-22；INV-08 |
| T8 删除旧 rule-enabled 兼容接口并完成集成矩阵 | T3、T4、T6、T7 | AC-1–AC-22；INV-01–INV-10 |
| T9 回滚演练与源码关闭 | T8 | 全部 AC/INV 的关闭证据 |
| T10 外部桌面/IM/存量库验收与启用 | T9 | 外部验收记录；AC-7–AC-18 真实体验确认 |

T0 与 T1a 可并行，T1b 在 T0 完成后开展；T1b 只作为 T7 的 UI 实施前置，不属于 Phase 0 关闭门槛，也不阻塞 T2–T6。当前 worktree 接手时 T7 UI 已经落地，故 T1b 以基线 diff 追溯记录并标明时间偏差。各 Phase 按序关闭并提交后进入下一 Phase；T1b 可在这些阶段推进时并行完成。任务依赖表是唯一顺序真源，Phase 内可按依赖并行；T4 在 T3 后，T7 在 T5/T6 后，T8 在 T7 完成后才移除兼容 API，避免阶段交付之间出现未适配调用方。

阶段标题用于归类任务，任务启动顺序只由上方 DAG 决定。T1a 的界面归属卡批准已完成；T1b 已补记 source baseline 对照与本次范围检查。D-UI 于 2026-10-22 获项目负责人批准：保持现有设置界面和布局不变，只开放原来锁定规则的动作配置。

## 阶段与任务

### Phase 0：源码基线与界面准入

**阶段输入：** 需求 AC-1–AC-22、方案 F-01–F-11、源码基线。**阶段产出：** 可复核的规则/消费者矩阵和变更前定向测试结果。**允许改动：** 仅方案证据记录；不修改代码。**失败回退：** 对照源码修订未确认的事实，不改运行数据。

- [x] **T0 · 盘点规则集合、状态写入者和调用派发路径**
  - **目标文件/模块：** `src/shared/policy/defaultRules.ts`、`policyPackages.ts`、`policyEngine.ts`、`electron/confirmation/policyRulesRuntime.ts`、`policyRuleStore.ts`、`imPolicyStore.ts`、`electron/ipc/{securityIpc,policyIpc}.ts`、`toolCallGate.ts`、`agentSdkSafetyPolicy.ts`、`agentSdkTurnDispatch.ts`、`invocationAssembler.ts`、`packages/agent-sdk/src/{executionAdmission,toolExecutionPort}.ts`、`ToolsSecuritySettingsTab.tsx` 与邻接测试。
  - **产物：** 全量矩阵（规则 ID × lane × when: invocation/ingress/exposure × 默认/当前动作 × locked/disabled/humanRequired × UI 行 × writer × 消费者 × 测试），并标出批准对象、批准后的继续位置、迁移源、API caller 与派发路径。
  - **完成判据：** 设置页每一展示规则均有动作域、实际消费点和消费者测试落点；入口 ask 对应待处理消息对象，exposure ask 对应工具/能力对象；所有 enabled/disabled、policy write、批准/resume/claim 调用均有证据；记录实际源码基线偏移。
  - **验证：** `rg -n "id:|locked:|humanRequired|confirm-every-time|when:" src/shared/policy/defaultRules.ts`；`rg -n "decideIngress|exposure|disabledRuleIds|securitySetRuleEnabled|rule-enabled|rule-override" electron src/shared src/renderer/components/Config/ToolsSecuritySettingsTab.tsx`；`rg -n "beginDispatch|currentAuthorizationVersion|subscribeAuthorizationChange|deferredResume" electron packages/agent-sdk/src`；阅读对应实现与测试，不以搜索命中直接定性。
  - **环境 / 状态：** 本机 / 已完成；全规则逐条 matrix 与调用链核验已记录。


#### T0 源码规则与消费矩阵（2026-10-23）

矩阵依据 `defaultRules.ts` 全部规则对象、`settingsSecurityModel.toRuleViews`、设置页 `rulesForLane` 及实际 writer/consumer 实现建立。表中“默认动作”是源规则值；实际当前动作由所选 package/profile 和持久化 rule override 决定。工作树没有应用运行中的 `spaceassistant-data.db`，因此无法把某个用户当前的持久化动作或 legacy disabled list membership 误记为源码默认值。旧 `disabledRuleIds` 来源为 desktop legacy config 与 IM policy snapshot；迁移后不再作为运行时决策输入。

表中 source line 以当前 worktree 读取的规则定义为准；“current action source”描述运行时求值链，具体结果由当前 package 与 override 决定；逐用户 legacy disabled membership 因本机运行数据库不在该 worktree 中，不能凭源码判定。每条 invocation 规则的消费点和测试落点逐条列出。`所有匹配 lane` 表示 rule 没有静态 lane 限制，由 match 条件及调用 lane 决定；automation 规则由任务权限/调用者数据驱动，不开放设置页编辑。

| Rule ID | Source line | Lanes | When | Default action | Current action source | Locked | humanRequired | Legacy disabled state | UI row | Writer | Consumer | Test family |
|---|---:|---|---|---|---|---|---|---|---|---|---|---|
| `wiki-raw-write-deny` | 20 | all matching | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outside-write-deny` | 27 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-outside-standard-review` | 34 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-outside-strict-human` | 39 | desktop | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-outside-loose-review` | 44 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-mode-loose-allow` | 49 | desktop, wechat, feishu | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-mode-standard-review` | 54 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-mode-strict-human` | 59 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-sensitive-standard-human` | 64 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-sensitive-strict-human` | 69 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-sensitive-loose-review` | 74 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-strict-human` | 79 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-review` | 84 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-standard-review` | 89 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `outbound-incomplete-loose-review` | 94 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-write-scope-unknown-deny` | 99 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outside-read-deny` | 106 | wechat, feishu, automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-wechat-media-outside-deny` | 113 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-wechat-media-unknown-deny` | 120 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `write-target-unsupported-deny` | 127 | all matching | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `feishu-media-boundary-deny` | 133 | feishu, automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `feishu-media-boundary-unknown-deny` | 140 | feishu, automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-sensitive-workdir-switch-deny` | 147 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-unknown-workdir-switch-deny` | 154 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-network-deny-remote` | 161 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-dangerous-deny` | 170 | all matching | invocation | deny | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-deny-lark-write-outbound` | 180 | feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-deny-wechat-outbound` | 190 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-browser-disabled` | 202 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-shell-disabled` | 212 | wechat, feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outbound-budget-pause-wechat` | 223 | wechat | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `remote-outbound-budget-pause-lark` | 233 | feishu | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `shell-sensitive-path-confirm` | 243 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `shell-system-dir-confirm` | 250 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-script-path-unknown-deny` | 257 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-script-permission-missing-deny` | 264 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-unverified-script-language-deny` | 271 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-sensitive-path-deny` | 278 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-system-dir-deny` | 284 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-write-deny` | 290 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-deny` | 296 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-sensitive-path-confirm` | 302 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-system-dir-confirm` | 308 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-path-unknown-confirm` | 314 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-path-unclassified-confirm` | 320 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-dynamic-execution-confirm` | 326 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-suspicious-path-unknown-confirm` | 332 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-declared-path-scope-allow-desktop` | 338 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-unmodeled-path-ask` | 346 | desktop, wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-unverified-language-confirm` | 352 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `shell-precheck-auto-allow` | 367 | desktop | invocation | auto-evaluator | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `path-sensitive-read-confirm` | 376 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `path-system-dir-ask` | 384 | desktop, wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `read-target-workdir-allow` | 393 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `path-outside-readonly-allow` | 400 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-network-ask-desktop` | 408 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-uncertified-ask-remote` | 417 | wechat, feishu | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-clean-certified-remote` | 427 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `script-clean-allow-desktop` | 437 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-danger-ask` | 448 | all matching | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-browser-act-danger-human` | 456 | wechat, feishu | invocation | ask | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-allow-unconfigured` | 467 | desktop, wechat, feishu | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-ask-remote` | 477 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-browser-act-review` | 487 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-act-ask-desktop` | 496 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-navigate-ask-remote` | 506 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `browser-navigate-ask-desktop` | 518 | desktop | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-message-group-human` | 530 | feishu | invocation | ask | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-message-target-unknown-human` | 540 | feishu | invocation | ask | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-high-impact-ask` | 550 | desktop, feishu | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-unknown-ask` | 559 | desktop, feishu | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-write-ask` | 568 | desktop, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-lark-low-write-review` | 577 | feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-lark-message-self-review` | 586 | feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-lark-message-direct-review` | 595 | feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `lark-read-allow` | 604 | desktop, feishu | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `toolkit-read-allow` | 615 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-time-query-review` | 622 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `toolkit-act-ask` | 630 | desktop | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `mcp-account-unauthorized-deny` | 646 | all matching | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-mcp-permission-missing-deny` | 655 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `mcp-readonly-allow` | 664 | desktop | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-mcp-public-read-review` | 671 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `mcp-tool-ask` | 680 | all matching | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | desktop policyRulesRuntime + IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-low-risk-create` | 688 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-low-risk-edit` | 696 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-write-sensitive-path-confirm` | 705 | wechat, feishu | invocation | confirm-every-time | profile + persisted override | true | true | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-write-ask` | 712 | wechat, feishu | invocation | ask | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-bound-output-write-allow` | 724 | automation | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-grep-permission-missing-deny` | 731 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-readonly-allow` | 738 | automation | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-unsupported-deny` | 759 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-analysis-incomplete-deny` | 768 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-path-facts-incomplete-deny` | 775 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-outside-root-deny` | 782 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-shell-outside-risk-deny` | 789 | automation | invocation | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-authorized-shell-allow` | 796 | automation | invocation | allow | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `automation-default-confirm` | 807 | automation | invocation | ask | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | not editable in settings | automation/task authorization | `evaluateToolCallGate` | `toolCallGate/policyEngine + lane caller` |
| `im-no-wechat-send` | 818 | wechat, feishu | exposure | deny | profile + persisted override | true | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `resolveExposure` | `exposure/toolsConfigRuntime/effectiveTools` |
| `ingress-direct-other-deny` | 829 | wechat, feishu | ingress | deny | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `decideIngress` | `ingress/imInboundGuard/remote caller` |
| `ingress-feishu-group-deny` | 837 | feishu | ingress | deny | profile + persisted override | false | false | legacy per-user disabled list (runtime DB not in worktree) | desktop / IM custom rule row | IM snapshot/imPolicyStore | `decideIngress` | `ingress/imInboundGuard/remote caller` |

**跨行状态与对象核验：**

- 设置页展示来自 `settingsSecurityModel.ts:50` 的 `toRuleViews`；desktop 与 wechat 两个视图均通过 `ToolsSecuritySettingsTab.tsx:325` 的 `resolvePolicyRules` 派生。IM 的 wechat/feishu 共用一个 `policy_behavior_snapshots(domain='im')` revision；desktop action override 写入 `policyRulesRuntime.ts` 管理的 desktop package，IPC 经 `policyIpc.ts` 强制 expectedRevision。测试：`policyRulesRuntime.test.ts`、`imPolicyStore.test.ts`、`policyIpc.test.ts`、`ToolsSecuritySettingsTab.test.tsx`。
- Invocation facts 与 policy 决策由 `toolCallGate.ts` → `agentSdkSafetyPolicy.ts` 消费；Hosted SDK 再由 `agentSdkTurnDispatch.ts`、`invocationAssembler.ts`、`registeredAgentTurnTools.ts` 绑定调用、计划、facts 与 permit。批准继续位置为 prepare/recheck，再进入 `SafetyGate.authorize` 与 `toolExecutionPort`。测试：`agentSdkSafetyPolicy.test.ts`、`agentSdkTurnDispatch.test.ts`、`invocationAssembler.test.ts`、Hosted/IM caller integration suites。
- Ingress 对象是尚未处理的原始消息。`decideIngress` 由 `imInboundGuard.ts` 生产判定，ask 由 `imIngressApprovalPrompt.ts` 绑定原 channel/identity/message/envelope；只在批准后把同一条消息送入远程路由。测试：`ingress.test.ts`、`imIngressApprovalPrompt.test.ts`、`imInboundGuard.test.ts`、微信/飞书 remote-agent suites。
- Exposure 对象是单个工具/能力。`resolveExposure` 由 `exposure.ts` 求值，`toolsConfigRuntime.ts` 和 `effectiveTools.ts` 只在 deny/ask 解决后生成可见能力；ask 批准绑定工具身份后继续构建工具清单。测试：`exposure.test.ts`、`toolsConfigRuntime.test.ts`、`effectiveTools.test.ts`。
- 全部旧动作写入与派发入口检索已逐个阅读复核：`securitySetRuleEnabled`/`rule-enabled` 只保留迁移期兼容边界，本阶段尚未执行 T8 清除；rule action write 由 desktop/IM domain writer 接收；审批和 deferred/resume 由 confirmation adapter、`deferredResumeCoordinator.ts` 与一次性 resume request store 承接；permit claim/final dispatch 由 `executionAdmission.ts`、`toolExecutionPort.ts` 及 Electron coordinator 共同完成。
- **T0 基线验证：** policy runtime、IPC、policy engine、入口/暴露消费者、设置 UI、Hosted SDK 与 caller 定向测试均可启动；该测试运行发生在当前实现已落入 worktree 后，不能冒充改动前基线。源码规则按上表全量逐条盘点，批准对象、继续位置、迁移源、writer 和派发路径均有对应实现/测试证据。

- [x] **T1a · 记录界面归属卡批准**
  - **目标范围：** 本方案第 0 层已批准的界面归属卡；仅记录批准，不改代码。
  - **产物：** 项目负责人于 2026-10-22 的明确批准记录。
  - **完成判据：** 五行卡无待定项；范围明确为现有设置界面和布局不变，只开放原锁定规则动作配置；不新增入口、页签、页面或独立面板。
  - **验证：** 复读开发方案批准记录。
  - **证据：** 用户明确回复“批准上方界面归属卡：确认批准”，并澄清“现有设置界面不变，原来写死不可设置的，现在可以设置”。
  - **环境 / 状态：** 本机 / 已完成；完成 D-UI。

- [x] **T1b · 建立方案期视觉基线**
  - **目标范围：** `ToolsSecuritySettingsTab.tsx`、相关设置页主题与组件约定；只读核对。
  - **产物：** 现有布局/控件证据和 `$impeccable` 方案期有范围检查记录。
  - **完成判据：** 记录本轮只改规则动作控件及必要说明，不重新设计页面；实现后检查只覆盖批准范围。
  - **验证：** 对照组件源码与主题 token，保存检查结论供 T7 引用。
  - **证据：** 对照基线 `109a9384` 的 `ToolsSecuritySettingsTab.tsx` 与当前实现，原有设置 Tab、表格列、LANE tabs、Ant Design 控件与 token/CSS 结构保留；变化只涉及 custom 行动作选择、保存 pending/success/conflict 反馈和必要说明，未新增页面、分区或改变布局。规则动作沿用原表格 action 列和 `Config` 组件约定。UI 完成后执行 `$impeccable` manual detector：`detect.mjs --json ...ToolsSecuritySettingsTab.tsx ...ToolsSecuritySettingsTab.test.tsx ...config.json` 返回 `[]`。该 source baseline 比代码实现晚记录；这是本 worktree 接手时的既存实现，已以基线 diff 复核并如实登记。
  - **环境 / 状态：** 本机 / 已完成（追溯对照）；T7 UI 实施前置已具备范围与视觉证据。

- [x] **Phase 0 关闭门槛**
  - **证据来源：** T0 规则/消费者核验表与检索记录；T1a 批准记录。动作矩阵和多规则需求以需求 AC 为准。
  - **完成判据：** T0 全部展示规则及消费路径闭合；D-UI 批准记录可查；基线定向测试能启动且既有失败已登记，不把外部账号/窗口验收设为开发门禁。T1b 在 T0 后完成，且只作为 T7 的前置；T2–T6 不依赖 T1b。
  - **阶段收尾证据：** `./node_modules/.bin/vitest run src/shared/policy/policyPackages.test.ts src/shared/policy/policyEngine.test.ts electron/confirmation/policyRulesRuntime.test.ts electron/ipc/policyIpc.test.ts src/renderer/components/Config/ToolsSecuritySettingsTab.test.tsx` — 5 files / 178 tests passed。该检查在实现已存在的 worktree 上执行，不视作改动前基线。T0 的 101 条规则矩阵及批准对象/继续位置/writer/测试映射已记录；T1a 批准证据已复核；T1b 已对照代码基线与当前 UI 范围。

### Phase 1：规则动作和引擎语义

**阶段输入：** Phase 0 盘点；T2→T3。**阶段产出：** 规则覆盖校验开放且多规则结果固定。**允许改动：** shared policy/types、engine/runtime resolver、ingress/exposure 消费点与实际调用方、相关审批 adapter 及对应测试；不迁移持久化 disabled 数据。**移除兼容：** 本阶段暂不删除 `disabledRuleIds`，保证尚未迁移的用户状态仍有效。**失败回退：** 回退 Phase 1 policy changes，旧 persistence 与 IPC 保持原行为。

- [x] **T2 · 为全部展示规则开放 lane 动作校验并固定覆盖解析**
  - **目标文件：** `src/shared/confirmation/types.ts`、`src/shared/policy/policyPackages.ts`、`src/shared/policy/laneProfiles.test.ts`、`policyPackages.test.ts`、`policyPackages.recovery.test.ts`、`policyPackages.scope.test.ts`、`defaultRules.contract.test.ts`；`src/shared/policy/policyFloor.ts`、`electron/confirmation/toolCallGate.ts` 与 floor tests 按决策合同一并修改。
  - **产物：** action × lane × when × policy rule 合同测试；locked rule 可覆盖/重置；`confirm-every-time` 映射；显式覆盖移除同规则默认门控测试。
  - **完成判据：** 设置页每条 desktop 规则支持四动作，每条 IM 规则支持三动作，包括 invocation、ingress、exposure；未知规则、错误 lane、非法动作仍拒绝；`automation` 仍不可用户配置；`locked`、`humanRequired`、默认 floor 不拒绝显式用户动作；保留规则身份/匹配结构校验及 automation 当前 floor；子调用 floor 不扩大父调用当前用户策略。该任务只验动作合同，消费者语义在 T3。
  - **验证命令：** `npm exec vitest run src/shared/policy/laneProfiles.test.ts src/shared/policy/policyPackages.test.ts src/shared/policy/policyPackages.recovery.test.ts src/shared/policy/policyPackages.scope.test.ts src/shared/policy/defaultRules.contract.test.ts electron/confirmation/policyFloor.test.ts electron/confirmation/policyRulesRuntime.test.ts`。
  - **环境 / 状态：** 本机 / 已完成；完成 AC-1、AC-2–AC-6 的动作域部分，INV-01、INV-02。

- [～] **T3 · 在 invocation、ingress、exposure 消费点落实动作语义**
  - **目标文件：** `src/shared/policy/policyEngine.ts`/decision tests；`electron/confirmation/ingress.ts` 与入口 caller；`electron/confirmation/exposure.ts`、`electron/toolsConfigRuntime.ts`、`electron/effectiveTools.ts` 与暴露 caller；相关审批 adapter、trace 和 caller tests。
  - **产物：** invocation 全命中动作集合及 trace；ingress ask 的待处理消息批准与批准后继续；exposure ask 的工具/能力对象批准与批准后暴露；各 when 至少一条真实消费者测试。
  - **完成判据：** invocation 任意规则排列结果相同并符合 deny > ask > auto > allow；入口 deny 阻断进入、allow 继续；ask 经人工批准才继续原消息；exposure deny 不暴露、allow 正常暴露、ask 经人工批准才暴露目标；旧审批/授权不得跨对象批准；缓存/自动审核不越过优先级。入口与暴露两类 ask 均须实现并通过需求 AC-21/AC-22。
  - **验证命令：** `npm exec vitest run src/shared/policy/policyEngine.test.ts src/shared/policy/policyDecision.test.ts src/shared/policy/memoryEligibility.test.ts src/shared/policy/imPolicyBehaviorResolvers.test.ts electron/confirmation/policyFloor.test.ts electron/confirmation/ingress.test.ts electron/confirmation/exposure.test.ts electron/toolsConfigRuntime.test.ts electron/effectiveTools.test.ts`。
  - **环境 / 状态：** 本机 / 进行中；原有 AC-1–AC-6、AC-10–AC-12、AC-21–AC-22 与 INV-01–INV-03 证据保留。v9 新反例证明 ingress/exposure 旧审批等待不随策略通知主动结束；新增可取消审批等待回归已通过，尚待 GUI 与真实入口复核。

- [x] **Phase 1 关闭门槛**
  - **证据来源：** T2 与 T3 的测试/决策 trace 断言；若改 `src/shared/confirmation/types.ts`，同时提供 `npm run typecheck:shared` 输出。
  - **完成判据：** T2/T3 测试通过；旧停用数据仍按兼容路径工作（T4 尚未启动）；每种展示规则类型的动作均有消费测试；automation 未意外开放。
  - **阶段收尾证据：** `vitest run` Phase 1 合并集合 19 files / 347 tests passed；覆盖 policy action/lane contract、多规则优先级、ingress ask 的原消息对象、exposure ask 的精确工具对象，以及 automation floor。代码和阶段状态随本提交关闭。

### Phase 2：持久化、IPC 与存量迁移

**阶段输入：** Phase 1 shared contract；T4。**阶段产出：** desktop/IM 都以动作覆盖表达配置，存量旧停用状态幂等迁移。**允许改动：** stores/runtime、IPC、迁移与边界测试；T7 前暂时保留旧 renderer API 合同。**移除兼容：** 去除 runtime disabled filtering；旧 API 改为短期兼容 shim，直到 T7 迁移 caller、T8 才删除。**失败回退：** 事务/迁移失败保留旧数据；回滚时连同 shim 版本一起恢复。

- [x] **T4 · 迁移旧停用规则并收敛 desktop/IM 写入合同**
  - **目标文件：** `electron/confirmation/policyRulesRuntime.ts`、`policyRuleStore.ts`、`imPolicyStore.ts`、policy migration 模块、`electron/ipc/securityIpc.ts`、`policyIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`；对应 stores、IPC、renderer caller 与迁移 tests。旧 preload/API 保留兼容映射。
  - **产物：** 按域迁移函数、旧数据 fixture、revision 写入契约、兼容 shim 和调用方契约测试、审计语义测试。
  - **完成判据：** desktop/IM disabled IDs 同迁移为 `allow` override 并在同一提交清除；重复运行幂等，冲突覆盖不丢失；事务失败回滚；reset 恢复默认；runtime 不再读取 disabled 状态；旧 `securitySetRuleEnabled`/`rule-enabled` 调用仍有有效 handler，暂映射为旧 disabled→allow、旧 enabled→reset default 的兼容语义；新 action API 强制 expectedRevision；旧 toggle shim 在主进程读取当前 revision 并用同一写入路径提交，保证旧 caller 有效，T7 迁移后由 T8 删除 shim。兼容 caller contract tests 覆盖旧界面动作写入与恢复默认两种路径，确认新 API 的 expectedRevision 要求不影响尚未迁移调用；策略保存成功由持久化提交决定，异步审计失败不得反向报告保存失败。审计正常路径记录 before/after 与迁移来源，不含正文。
  - **验证命令：** `npm exec vitest run electron/confirmation/policyRulesRuntime.test.ts electron/confirmation/policyRuleStore.test.ts electron/confirmation/imPolicyStore.test.ts electron/ipc/policyIpc.test.ts electron/appIpc.securityRules.test.ts src/shared/policy/legacyPolicyMigration.test.ts src/renderer/components/Config/ToolsSecuritySettingsTab.test.tsx`；并执行 renderer typecheck，确认兼容 shim 阶段旧 UI 的动作写入与恢复默认均可用。
  - **阶段证据：** 定向集合 9 files / 89 tests passed；shared 与 renderer typecheck 通过。迁移覆盖旧 desktop config 与 IM snapshot 的 disabled→allow 原子迁移、已存在 override、重复启动/回滚与未知状态；旧 preload/API shim 在 T4/T7 留存，测试了 disabled→allow、enabled→reset default。
  - **环境 / 状态：** 本机 / 已完成；完成 AC-7–AC-10、AC-19–AC-20，INV-04、INV-07。

- [x] **Phase 2 关闭门槛**
  - **证据来源：** T4 migration fixtures（旧桌面配置、旧 IM snapshot、已存在 override、部分失败、重复启动）；transaction rollback 与 revision conflict 测试。
  - **完成判据：** 每种来源数据迁移后唯一动作状态确定；迁移失败不删除旧值、不写部分快照；所有 runtime 不再读 disabled ID 作为策略动作；未知字段不导致忽略整个有效 snapshot。
  - **阶段收尾证据：** T4 定向集与 migration/startup fixtures 通过；旧 desktop disabled API shim 在计划窗口内维持可用，持久化写入已改为动作覆盖，runtime 不再以 disabled ID 决策。Phase 2 源码与状态随本阶段提交关闭。

### Phase 3：策略版本与执行派发边界

**阶段输入：** Phase 2 revision-aware writes；T5→T6。**阶段产出：** 策略变化时旧待审批结果失效并由现有调用路径重入 gate；执行器进入边界拒绝过期策略。**允许改动：** safety policy、deferred resume coordinator/caller、registered tools/runtime assembler 与 lifecycle tests。**失败回退：** revision 不可判定时不沿用旧授权；回退时沿用当前授权撤销路径。

- [～] **T5 · 使审批、审核及已批准待执行调用绑定策略 revision**
  - **目标文件：** `electron/confirmation/imPolicyStore.ts`、`deferredTodoStore.ts`、`deferredResumeRequestStore.ts`、`electron/remote/deferredResumeCoordinator.ts`、`deferredApprovalAdapter.ts`、`agentSdkSafetyPolicy.ts`、`agentSdkTurnDispatch.ts`、`electron/runtime/invocationAssembler.ts`、必要的 desktop epoch/change publisher 与对应 tests。
  - **产物：** desktop epoch 与 IM revision/epoch；审批对象绑定策略域/revision/调用事实；明确由 `deferredResumeCoordinator`（IM deferred）及 T0 盘点出的对应 desktop caller 接收策略变化并重入 gate；新 gate 结果替换旧等待状态。
  - **完成判据：** 等待人工批准或自动审核时保存策略，旧结果不可恢复；正常运行中原调用由具体变化通知接收者重新送入 facts/policy gate：新动作 deny 收束调用，allow/direct 进入后续派发，ask 创建新的审批，auto 使用新策略审核；原请求标识与一次性 resume 防止同一调用重复 dispatch；迟到旧批准稳定返回 stale；不新增本期未要求的持久化恢复队列；桌面/IM 域不串扰；嵌套 floor 由最新父策略重建。
  - **验证命令：** `npm exec vitest run electron/confirmation/imPolicyStore.test.ts electron/confirmation/deferredTodoStore.test.ts electron/confirmation/deferredResumeRequestStore.test.ts electron/remote/deferredResumeCoordinator.test.ts electron/confirmation/deferredApprovalAdapter.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/confirmation/policyFloor.test.ts electron/tools/agentSdkTurnDispatch.test.ts`。
-  - **阶段证据：** 原 T5/T6 集合 15 个文件 / 260 项通过记录保留。v9 反例证明 claim 后新 ask 会被旧 receipt 自动确认；新增版本绑定后，两条 IM lane 在 late ask 下 executor 调用数为 0。策略变化 ask 的重新排队尚未完成。
-  - **环境 / 状态：** 本机 / 进行中；AC-13、AC-14、AC-18、AC-19 与 INV-05、INV-07 的旧证据保留；新增 receipt revision binding 回归通过，fresh ask 的 deferred requeue 尚未闭合。

- [～] **T6 · 覆盖 claim 后到 executor 进入前的策略变化窗口**
  - **目标文件：** `packages/agent-sdk/src/executionAdmission.ts`、`toolExecutionPort.ts`、`electron/tools/registeredAgentTurnTools.ts`、`permitBoundCoordinatorDispatch.ts`、`electron/runtime/invocationAssembler.ts`、remote/desktop caller adapters 及相应 caller tests。
  - **产物：** 现有 revision/失效通知在 `onDispatchClaimed` 异步窗口后的最终检查位置；两种顺序的 barrier tests 与 executor spy。
  - **完成判据：** `claim` 后暂停 `onDispatchClaimed`，保存新策略再恢复时，executor 零调用且调用返回 T5 gate/recheck；executor 已进入后保存时不伪称撤销；异步 validatePrepared 窗口同样检查当前 revision；无 revision 或检查失败不使用旧授权。不得把 claim 当作 executor 已开始；final-check 只核验批准对象、permit、材料与版本，不重新计算业务风险。若实现引入锁/等待，记录实际锁持有边界并确保锁内不等待审批、长执行或回调。
  - **验证命令：** `npm exec vitest run packages/agent-sdk/test/executionAdmission.test.ts packages/agent-sdk/test/toolExecutionPort.test.ts electron/confirmation/agentSdkSafetyPolicy.test.ts electron/confirmation/policyFloor.test.ts electron/tools/permitBoundCoordinatorDispatch.test.ts electron/tools/registeredAgentTurnTools.test.ts electron/runtime/hostedAgentTurnHost.test.ts`；屏障测试断言保存与派发两种顺序均可完成。
-  - **阶段证据：** `executionAdmission`、`toolExecutionPort`、Hosted turn 与 registered tool 用例覆盖 claim/`onDispatchClaimed`、validatePrepared 异步屏障及策略失效后 executor 不进入；SDK 在 stale authorization 后重入新 gate 的 allow/ask/deny 定向用例通过；executor 已进入后的 Hosted policy-change 用例只报告运行中断，不伪称未派发。新增 Feishu/WeChat lane 组合屏障用例在新 allow 已被 claim 后提交 deny，真实 gate 拒绝旧确认，原 executor 调用数为 0；正常 allow 顺序仍恰好派发一次。
-  - **环境 / 状态：** 本机 / 进行中；AC-15–AC-18、INV-05、INV-06 原 claim/final-check 证据保留；新增 claim 后新 ask 探针确认零 executor 派发，但需实现同一调用创建新审批并覆盖竞争窗口后才可关闭。

- [～] **Phase 3 关闭门槛**
  - **证据来源：** T5 revision invalidation tests；T6 barriers 与 executor spy；每个生产 caller 的 caller-level test 证据。
  - **完成判据：** T5 证明策略变化通知可驱动原调用重新过 gate；T6 证明 claim 后异步窗口出现策略变化时旧 executor 不进入；desktop Hosted、direct registered tools、IM synchronous、IM deferred/resume 实际入口均覆盖。无锁实现不要求假想死锁测试；若实现引入锁，则按实际持有范围验证。
  - **阶段收尾证据：** T5/T6 定向集合 15 个文件 / 260 项通过，包含真实策略提交→两条 IM lane→gate→executor 组合与 claim 后二次改 deny 的屏障；`check:agent-sdk`、`check:system-invariant-registry`、shared/renderer typecheck、`npm run build:electron:incremental` 通过。Hosted、direct registered、同步等待与 durable deferred/resume 路径均有回归证据。v9 P1 重新打开 Phase 3：当前新 ask 的 deferred requeue 与 GUI 验收未完成。

### Phase 4：设置 UI 与本地化

**阶段输入：** D-UI 已批准，T1b 视觉基线、Phase 1 action contract、Phase 2 新 write API；T7。**阶段产出：** 自定义规则可编辑和可保存；renderer 使用新 action API。**允许改动：** `ToolsSecuritySettingsTab.tsx`、settings model/IPC payload、i18n 与 renderer tests。**移除兼容：** UI 旧启停控件与旧 payload/key；旧 IPC/API shim 保留到 T8。**失败回退：** 可回退 UI，T4 shim 仍支持旧调用。入口与暴露 ask 均为本期必做能力；按需求 AC-21/AC-22 实现并验收。

- [x] **T7 · 改造规则行、IM 共享提示和保存反馈**
  - **目标文件：** `src/renderer/components/Config/ToolsSecuritySettingsTab.tsx`、`toolsSecurityFormat.ts`（如 view formatting 所需）、`ToolsSecuritySettingsTab.test.tsx`、`src/renderer/i18n/resources/{zh-CN,en-US}/config.json`、`src/renderer/i18n/types.ts`。
  - **产物：** 规则 action selector、逐条 reset、默认人工批准频率说明、旧停用迁移说明、IM shared-domain notice、pending/success/failure/conflict UI、语言同步。
  - **完成判据：** 每条规则（含 ingress/exposure）动作集合准确；不出现 locked 只读行或启停开关；成功后才更新显示；revision 冲突重新读取；所有文案经 `t()`；实现后 `$impeccable` 检查完成。自动化/静态检查作为本机门禁；真实 Electron 窗口窄布局手工结果记录为外部验收 T10，不阻塞源码阶段。
  - **验证命令：** `npm exec vitest run src/renderer/components/Config/ToolsSecuritySettingsTab.test.tsx`；`npm run i18n:generate-types`；`npm run i18n:check`；`npm run typecheck:renderer`。
  - **阶段证据：** 原 renderer 组件 21 tests passed；2026-10-24 新增四种默认频率说明与规则原因双语探针后，组件 31 tests passed；101 条默认规则及 scope 规则原因经隔离英文 GUI 抽查 Desktop/Remote IM，`i18n:generate-types`、`i18n:check`、`i18n:check:strict`、renderer typecheck/build 通过。Impeccable detector 原结果为 `[]`。未改现有页面布局；真实 IM GUI 归 T10。
  - **环境 / 状态：** 本机自动化 / 已完成；完成 AC-1、AC-7–AC-9、AC-19，INV-08。真实窗口检查归 T10。

- [x] **Phase 4 关闭门槛**
  - **证据来源：** T7 renderer tests、i18n check、typecheck、I8 card approval、`$impeccable` 检查记录。
  - **完成判据：** 桌面/IM action options 与主进程 validator 一致；共享配置说明明确；失败/冲突不误报；zh-CN/en-US keys 完整对齐；未经批准的界面改动为零。
  - **阶段收尾证据：** renderer 测试、i18n normal/strict、renderer typecheck 通过；当前 Impeccable 检查无 finding。Phase 4 UI/i18n 与阶段状态随本阶段提交关闭。

### Phase 5：集成、回滚与源码关闭

**阶段输入：** Phase 1–4 产物；T8→T9。**阶段产出：** 完整 AC/INV 映射、关闭证据、可执行回滚步骤。**允许改动：** 测试夹具、缺陷修复、文档证据与范围内代码；不新增产品行为。**移除兼容：** 删除 T8 已核验迁移的旧 rule-enabled shim 与剩余临时标记。**失败回退：** 源码可恢复；迁移数据按已演练步骤恢复。

- [x] **T8 · 移除旧接口并完成 AC × INV × 测试与安全审计矩阵**
  - **目标文件：** 所有阶段相关 tests；方案验收映射；必要的 `src/shared/security/systemInvariantRegistry.ts`/boundary tests（仅当代码核查证明新增了真正不可配置系统 invariant）。
  - **产物：** 删除 `securitySetRuleEnabled`/`rule-enabled` shim 的变更与静态搜索记录；AC-1–AC-22 → 用例名 → 命令 → invocation/ingress/exposure、dispatch/audit evidence 矩阵；外部项单列。
  - **完成判据：** T7 已迁移所有 renderer caller；删除共享 API、preload、handler、旧 payload 后本任务可独立通过类型检查和相关测试；AC-1–AC-22 有可达证据（含真实 ingress/exposure ask 消费者），每个 INV 有边界测试；审计不落正文/secret；不以 registry 锁定普通策略。
  - **验证命令：** `rg -n "securitySetRuleEnabled|rule-enabled|set-rule-enabled" electron src` 确认无生产引用；运行相关定向测试、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run check:system-invariant-registry`；涉及 agent-sdk 协议时补 `npm run check:agent-sdk`。
  - **环境 / 状态：** 本机 / 已完成；RED：旧接口不存在断言在 handler/API 仍存在时失败；GREEN：移除 `securityIpc` handler、preload 暴露与 shared API 类型后通过。`vitest run electron/ipc/securityIpc.policy.test.ts electron/appIpc.securityRules.test.ts electron/ipc/policyIpc.test.ts` 3 files / 18 tests；集成集合 40 files / 802 tests；`typecheck:renderer`、`typecheck:shared`、`check:system-invariant-registry`、`check:agent-sdk`、`build:electron:incremental`、`i18n:check`、`i18n:check:strict` 均通过。`rg -n 'securitySetRuleEnabled|rule-enabled|set-rule-enabled' electron src packages --glob '!**/*.test.*'` 无生产引用。AC/INV 证据见下表；Impeccable 静态 detector 为 `[]`。

#### AC 与测试证据映射

自动化用例标题可在所列文件中检索；本次合并门禁 `npm exec vitest run <相关文件>` 共 40 files / 802 tests。

| 需求 | 可复核用例与证据文件 |
|---|---|
| AC-1 | `laneProfiles.test.ts` 全规则/所有 lane 动作矩阵；`policyPackages.test.ts` 校验；`ToolsSecuritySettingsTab.test.tsx` 动作选项 |
| AC-2 | `policyEngine.test.ts` 显式 allow 清除同规则 locked、humanRequired、confirm-every-time 门控 |
| AC-3 | `policyEngine.test.ts` 用户动作优先于旧 human gate；`policyPackages.test.ts` 显式覆盖解析 |
| AC-4 | `policyEngine.test.ts` 显式动作遵循旧逐次确认语义；`agentSdkSafetyPolicy.test.ts` gate re-entry |
| AC-5 | `policyPackages.test.ts` locked invocation/ingress/exposure 可显式覆盖并剥离旧门控 |
| AC-6 | `policyEngine.test.ts` 显式 deny 与组合裁决；`policyIpc.test.ts` deny 写入 |
| AC-7 | `legacyImConfigBoundary.startup.test.ts` disabled→allow、原子清除与来源 marker；`ToolsSecuritySettingsTab.test.tsx` 迁移标签 |
| AC-8 | `policyIpc.test.ts`、`securityIpc.policy.test.ts` reset；UI reset 测试 |
| AC-9 | `policyPackages.test.ts`、`policyRulesRuntime.test.ts`、`policyIpc.test.ts` 套餐与覆盖保存/读取 |
| AC-10 | `policyEngine.test.ts` deny > ask > auto > allow 混合裁决与排列稳定性 |
| AC-11 | `policyEngine.test.ts` allow 与 ask 混合命中及 ask 胜出 |
| AC-12 | `policyEngine.test.ts` ask 与 auto 混合命中及优先级 |
| AC-13 | `agentSdkSafetyPolicy.test.ts` 策略变化后旧批准失效并重新进入 gate |
| AC-14 | `packages/agent-sdk/test/turn.test.ts` 最终复核转 ask；`remote/deferredResumeCoordinator.test.ts` stale todo |
| AC-15 | `packages/agent-sdk/test/executionAdmission.test.ts` admission 版本核验与未进入执行边界 |
| AC-16 | `packages/agent-sdk/test/toolExecutionPort.test.ts` dispatch port 授权终检 |
| AC-17 | `permitBoundCoordinatorDispatch.test.ts` prepared/claim 间版本漂移时 executor 零调用 |
| AC-18 | `permitBoundCoordinatorDispatch.test.ts` permit consume 后 claim barrier 与 executor 已进入边界；Hosted policy-change 测试 |
| AC-19 | `policyIpc.test.ts` revision conflict；`appIpc.securityRules.test.ts` expectedRevision；UI 冲突刷新且不误报成功 |
| AC-20 | `settingsAudit.test.ts` before/after；`imPolicyStore.test.ts` revision/audit 原子性；`securityAuditLog.test.ts` 敏感值脱敏 |
| AC-21 | `ingress.test.ts` ask 批准前阻止处理；`imIngressApprovalPrompt.test.ts` 一次性原消息批准；`imInboundGuard.test.ts` deny/allow/ask |
| AC-22 | `exposure.test.ts` ask 批准前不暴露、批准后暴露；`toolsConfigRuntime.test.ts`、`effectiveTools.test.ts` |

#### 不变量与边界测试映射

| 不变量 | 边界证据 |
|---|---|
| INV-01 全规则×lane×动作并接真实消费者 | `laneProfiles.test.ts`、`policyIpc.test.ts`、`ingress.test.ts`、`exposure.test.ts` |
| INV-02 每条规则只有用户最终动作来源 | `policyPackages.test.ts`、`policyEngine.test.ts`、`agentSdkSafetyPolicy.test.ts` |
| INV-03 唯一稳定优先级与胜出规则 | `policyEngine.test.ts` 多规则组合/排列用例 |
| INV-04 旧 disabled 迁移为普通 allow 且可幂等恢复 | `legacyImConfigBoundary.startup.test.ts`、`policyRulesRuntime.test.ts`、`policyPackages.test.ts` |
| INV-05 策略 revision 变化使旧审批失效 | `imPolicyStore.test.ts`、`agentSdkSafetyPolicy.test.ts`、`deferredResumeCoordinator.test.ts` |
| INV-06 final-check 只核验 permit/revision | `executionAdmission.test.ts`、`toolExecutionPort.test.ts`、`permitBoundCoordinatorDispatch.test.ts` |
| INV-07 snapshot/revision/epoch/失效/audit 同事务 | `imPolicyStore.test.ts`、`policyIpc.test.ts`；Desktop writer 测试验证 revision 与审计元数据 |
| INV-08 设置模型与 runtime 使用同一动作来源 | `settingsSecurityModel.test.ts`、`policyRulesRuntime.test.ts`、`ToolsSecuritySettingsTab.test.tsx` |
| INV-09 审计不含消息正文或敏感参数 | `securityAuditLog.test.ts`、`settingsAudit.test.ts` |
| INV-10 嵌套调用 floor 取父调用最新有效动作 | `agentSdkSafetyPolicy.test.ts`、`turn.test.ts` 父策略重建/重判用例 |

- [x] **T9 · 演练数据迁移、事务失败与版本回滚并关闭源码阶段**
  - **目标文件：** `imPolicyStore.test.ts`、`policyRulesRuntime.test.ts`、迁移 tests、相关计划/结果记录。
  - **产物：** 旧 disabled fixtures 升级前后快照；迁移重复运行、事务中断、部分 invalid legacy IDs、并发 policy write conflict、代码回退前 pending permit invalidation 记录。
  - **完成判据：** 测试证明迁移前规则集与旧 disabled list 可恢复；迁移提交不可出现覆盖与 disabled 两种状态并存；失败迁移保留原始数据；回退步骤先停止 writer、失效 pending permit、恢复一致快照；阶段相关全量测试和全仓 `npm test` 只在阶段收尾/最终验收执行；必要 build/typecheck/i18n 门禁通过。
  - **验证命令：** migration/recovery 定向测试；阶段最终 `npm test`；`npm run build:electron:incremental`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check`；`git diff --check`。
  - **环境 / 状态：** 本机 / 已完成。`legacyImConfigBoundary.startup.test.ts` 验证未知 ID 或 snapshot 持久化失败时旧 disabled 原值仍可读；成功迁移用例验证 allow override 与 disabled list 同事务切换。`imPolicyStore.test.ts` 验证 audit/持久化失败整体回滚，以及恢复经校验的历史快照会递增 revision/epoch、撤销旧 authorization 并失效 pending todo/resume request，dispatching 项不伪称取消；revision 冲突不覆盖胜者。旧 automation disabled-list 夹具已替换/移除：automation lane 不支持 custom policy，Hosted policy-change claim 屏障由 Desktop Hosted 集成用例覆盖。RED：全量 `npm test` 初次发现 2 个依赖已废弃 disabled runtime 语义的 `approvalAgent.test.ts` 用例失败；GREEN：更新夹具/移除 automation 不可配置 lane 的伪策略变化后，`npm exec vitest run electron/confirmation/approvalAgent.test.ts electron/claudeStreamHandlers.hostedIntegration.test.ts` 2 files / 168 tests 通过。最终 `npm test` 1102 files passed / 1 skipped，10,688 tests passed / 112 skipped；`npm run build`、`typecheck:renderer`、`typecheck:shared`、`i18n:check`、`i18n:check:strict`、`check:system-invariant-registry`、`check:agent-sdk`、`check:no-nul`、`git diff --check` 均通过。i18n strict 发现 1714 个中文命中，全部位于测试文件，源码 0。全量构建有既存 Vite ineffective dynamic import 与大 chunk 警告，但构建通过。演练基于隔离 SQLite fixtures；真实存量数据库/发布包验收保留在 T10。

- [x] **Phase 5 关闭门槛**
  - **证据来源：** T8 的 AC/INV 矩阵，T9 的迁移/回滚演练，Phase 0–4 测试结果。
  - **完成判据：** AC-1–AC-22 均有本机证据映射；所有当前可运行门禁通过；外部环境项继续标为待验收，不作已通过表述；SQLite 回滚证据与 Phase 5 源码验收完成，T10 启用/发布前置条件未被声称满足。

### Phase 6：外部验收与启用

**阶段输入：** T9 源码关闭；D-UI 批准；可用测试机器、备份数据库副本与真实 IM 测试账号。**阶段产出：** 手工/外部渠道记录、启用决定。**允许改动：** 发现问题后回到对应任务修复并重新验收；不绕过 AC。**失败回退：** 停止发布或关闭新功能入口；保留数据备份和审计；不得恢复旧代码并让新格式数据裸跑。

- [～] **T10 · 验收桌面、IM 账号、存量升级和发布包**
  - **目标范围：** Electron 桌面设置页；真实微信/飞书 owner 测试环境；脱敏存量 DB 副本；目标 OS 安装包。
  - **产物：** 外部验收记录（测试版本/账号环境、用例、结果、审批失效和 executor 未调用证据、迁移前后备份 hash、回滚结果）。
  - **完成判据：** 桌面自定义动作能控制真实调用；共享 IM 修改在两个 channel 正确生效；待审批/迟到批准按新策略收敛；已开始执行不被误称取消；存量 disabled 用户升级迁移与重启保持结果；正式包可启动并保存设置。
  - **验证方式：** 手工桌面与真实 IM scenario；目标平台 packaged app smoke test；存量数据库仅在隔离副本执行。
- **最新 T10 复探（2026-10-24）：** `diskutil info /dev/disk26s1` 确认该项目诊断镜像没有文件系统、未挂载；对应 backing file 已不存在，helper PID 50644 仍存活。仅对该项目设备执行 `hdiutil detach /dev/disk26`，12 秒超时。当前源码重建 arm64 DMG：`npx electron-builder --mac dmg --arm64 --publish never` 完成 app 打包与 ad-hoc 签名，进入 `target=DMG` / APFS 创建后 90 秒超时，已终止该调用进程组，没有生成 DMG。另以 Rosetta x86_64 显式指定 `-fs HFS+`，直接从当前 arm64 app 执行 `hdiutil create -srcfolder ... -format UDZO`，90 秒超时并返回 `hdiutil: create failed - 无子进程`，同样无 DMG 产物。完整 `npm run build` 已通过，但不能替代 DMG/系统安装/正式签名平台验收。CUA 仍报告 macOS 锁屏，当前源码动作显示/恢复入口的手工 GUI 复核待解锁后进行；不需 IM 登录。T10 保持进行中；真实 IM owner 验收尚未开始。

## 最终完成定义

- **源码阶段关闭：** Phase 0–5 关闭门槛完成；AC/INV 证据、相关测试、类型/i18n/build 与迁移回滚演练可复核。
- **产品启用/发布关闭：** T10 外部验收通过；未取得真实 IM、存量库或目标平台证据时，只能报告源码阶段完成，不能报告端到端发布验收完成。
- **提交纪律：** 每个独立阶段验收后单独提交；方案文档不记录任务状态，进度只更新本文；测试按仓库 AGENTS 规定的定向/阶段收尾策略执行。


T10 本轮状态（2026-10-23）：隔离旧库副本 `.test-artifacts/custom-policy-full-control/isolated-user-data/SpaceAssistant-dev/Library/Application Support/SpaceAssistant-dev/spaceassistant-data.db` 含 `remote-shell-disabled` 且无会话/消息；由我自行建立 user-data 副本并用当前 arm64 packaged app 首次启动迁移，随后同 profile 重启。复核旧 disabled 列表变为空，desktop rev2 snapshot 保留 `remote-shell-disabled:allow` 和迁移标记，IM snapshot rev1 存在，sessions/messages 均为 0。升级后 DB 与 SQLite `.backup` 文件 SHA-256 均为 `3a80921853e6854688ddecd68f49c140aefd146cd2476ce6ffad64605dca4580`。另在独立 rollback-run 目录从旧库恢复副本，确认旧 disabled ID 仍在、尚无 desktop snapshot、无会话/消息；SQLite backup 后页面布局 hash 不同（数据文件 hash 不作为逻辑等价判据），内容状态符合恢复前状态。此项验证的是隔离零会话旧格式副本，不代表真实用户库。定向回归 5 个测试文件 / 405 tests passed，覆盖 hosted claim 前策略变化时 executor 未调用、claim 后已进入 executor 的读取被中断、策略装配/门控、迁移与配置 UI。至此 T10 剩余两项：①真实微信/飞书 owner 场景（共享 IM 策略、异步待批、迟到批准/执行中状态）；②系统级 PKG 安装、DMG 生成及目标发布平台验收。当前包仅为 ad-hoc / PKG 未签名，正式安装和 DMG 尚未验证。


T10 本轮补充（2026-10-23）：最新 GUI 包复验发现 3 处中文界面混杂：MCP 未授权规则说明、浏览器禁用 / 远程消息预算内部码、旧版 IM 标准套餐复用了桌面提示。按 TDD 为规则说明与旧版 IM 提示补测试，RED 分别复现原始英文 / code 值和错误桌面说明，GREEN 后 `ToolsSecuritySettingsTab.test.tsx` 对应桌面/IM 全矩阵与 IM legacy hint 用例通过；`npm run typecheck:renderer`、`npm run i18n:check` 通过，最终 `npm run build:renderer` 通过。当前源码重建 arm64 PKG：`.test-artifacts/custom-policy-full-control/latest-pkg-final/SpaceAssistant-0.2.9-arm64.pkg`，SHA-256=`867b678e01547f382ad9dafb11bfce38e349d9a7cdbd5a6bc55222f674f1e8d6`；包 payload 中 `app.asar` SHA-256=`f4d7dba03e7f42b20ae3009739e59eb6f1c328b54e1bc4c60e427cc704c72963`，与打包 appOut 目录一致。`pkgutil --check-signature` 显示 PKG 无签名，payload app `codesign --verify --deep --strict` 通过（ad-hoc）；包声明 macOS 最低版本 13.0，当前主机 macOS 26.5.2 / arm64。从已展开的 PKG payload 以独立 HOME/user-data-dir 启动，日志有 `renderer.start-to-first-paint`；GUI 验证 IM 页显示“当前 IM 远程仍保留升级前的策略行为…”，浏览器禁用/远程预算/MCP 未授权行显示中文，未触发 IM 登录或发送。正式安装暂未进行：PKG `install-location=/Applications` 且 `auth=root`，本机已有 `/Applications/SpaceAssistant.app`；为避免覆盖，尝试创建隔离 APFS sparse image，但 `hdiutil create` 约 40 秒无响应，`diskutil list` 30 秒无响应后已中断并清理不完整 image。DMG 同样依赖 hdiutil，且 `/Volumes` 未发现可用隔离卷（仅有 Macintosh HD）；系统级安装/DMG/目标平台验收继续列为剩余发布项。

T10 追加诊断（2026-10-23）：重新审计当前 arm64 PKG 结构，`Distribution` 声明 `hostArchitectures=arm64`、macOS `min=13.0`、允许 `/`/当前用户域/本机系统域；`PackageInfo` 为 `install-location=/Applications`、`auth=root`、`relocatable=false`、`overwrite-permissions=true`、无安装脚本。只读 `installer -pkginfo/-dominfo/-volinfo` 查询通过；实际安装要求 root，且会替换本机已有 `/Applications/SpaceAssistant.app`，因此未尝试系统级安装。再次从当前源码运行 arm64 electron-builder DMG 流程，app 打包、afterPack 和 ad-hoc codesign 均成功；`hdiutil create` 生成约 758 MB 临时镜像后超过 1 分 40 秒无任何增长，进程与 diskimages-helper 均为休眠且 CPU 0%，故中止本次挂起构建。当前 DMG 与正式系统安装仍未验收；需 macOS DiskImages 子系统可用且有独立安装目标后继续。临时诊断 app 保留于 `.test-artifacts/custom-policy-full-control/dmg-diagnostic/`。

T10 镜像服务复核（2026-10-23）：`hdiutil info -plist` 可返回，但列出 20 个已附加镜像，包含旧临时 DMG 与未完成 sparseimage；当前探针 `hdiutil create -size 32m -type SPARSE -fs APFS` 仍在 11 MB 停滞超过 1 分钟，`diskutil list -plist` 与对本轮探针执行的 `hdiutil detach` 也无响应。创建进程已定向终止；卸载命令亦需强制终止，关联 diskimages-helper 仍保留，证明本机 DiskImages/挂载状态需恢复后方可重试；未触碰其他来源的映像或 `/Applications` 现有 app。小型探针保留于 `.test-artifacts/custom-policy-full-control/dmg-diagnostic/probe.sparseimage` 供诊断。

代码评审修复（2026-10-23）：针对 `docs/review/custom-policy-full-control-code-review-2026-10-23.md` 的 6 项阻断问题，新增 RED/GREEN 回归覆盖：IM rule resolver 不修改共享 `DEFAULT_POLICY_RULES`；首次 Desktop snapshot 导入旧套餐与合法 `PolicyRuleStore` 覆盖；IM ingress loader 从 canonical policy snapshot 读取；非 custom 套餐中的 override 保留但 dormant；Desktop package 写入尊重调用方 `expectedRevision`；旧 disabled source 仅在 Desktop 与 IM 迁移同事务成功后清空。实现分别落在 `policyRulesRuntime.ts`、`legacyImConfigBoundary.ts`、`securityIpc.ts`。RED 阶段 3 个缺陷测试文件共 7 项失败、36 项通过；GREEN 后原核心回归为 43/43。全量 Electron suite 首轮 6 项失败，检查确认是旧 fixture 在 `standard/strict` 套餐下仍要求自定义 override 生效；按 review #4 的 dormant 语义修正 fixture 与预期后，6 个相关测试文件 `policyRulesRuntime`、迁移、IPC、gate、assembler 共 300/300 通过。`npm run check:system-invariant-registry`、`npm run typecheck:shared`、`npm run i18n:check` 通过；`npm run build:electron:incremental` 首轮暴露规则映射字面量类型问题，修复后命令通过；`git diff --check` 通过。最终 `npm run test:electron` 通过：725 files passed / 1 skipped，7,772 tests passed / 110 skipped（768.67s）；执行中仅有既有 MaxListenersExceededWarning。此修复不关闭 T10 的真实 IM owner 与系统安装/DMG/目标平台验收。
