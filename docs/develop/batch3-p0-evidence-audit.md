# 第三批 P0 证据复测销号表

> 复测时点:2026-09-20 | worktree:`.worktrees/batch3` | 分支 `codex/batch3-runtime-admission-sdk-reuse` @ `5bb10766`(与计划声明基线一致)
> 复测方式:计划 §1 表全部证据命令逐条重跑;无「文件 / 路径不存在」级失败,不触发整表复核纪律。

## 销号结果

| 偏差 | 命令 | 复测结果 | 与计划差异 | 销号 |
| --- | --- | --- | --- | --- |
| 23 | `rg -n -e admission -e rateLimit -e quota src/shared electron --glob '!*.test.ts'` | 命中全在 butler(仅拦 butlerInvoker)与 browser 域、config 类型 | 一致 | ✅ |
| 23 | `rg -n submit-outbound electron` | `agentProtocolIpc.ts:532`、`preload.ts:40` | 一致 | ✅ |
| 23 | `rg -n createOutboundAcceptor electron` | `outboundAcceptor.ts:202`(定义)、`agentProtocolIpc.ts:454`(消费) | 一致 | ✅ |
| 23 | `rg -n listActive electron/ipc/agentProtocolIpc.ts` | `:525` / `:539` / `:587` | 一致 | ✅ |
| 17 | `rg -n -e resolveWorkDir -e resolveApiKey -e getBrowserDetectContext -e turnBoundary src/shared/agent/invocation.ts` | `:166`(resolveWorkDir 函数属性)、`:172`(resolveApiKey 接口方法)、`:275`(getBrowserDetectContext 接口方法)、`:280`(turnBoundary 函数属性) | 一致;P0 专项补充:`:166`/`:280` 为函数属性形态(待清),`:172`/`:275` 为接口方法形态(合法) | ✅ |
| 18 | `rg -n -e "const registry" -e TypedToolRegistry electron/tools/builtinExecutors.ts` | `:38`(import)、`:1303`(`const registry = new TypedToolRegistry()`) | 一致 | ✅ |
| 18 | `rg -n "let singleton" electron/confirmation/audit.ts` | `:11` | 一致 | ✅ |
| 18 | MCP semaphore | `mcpToolExecutor.ts:31`(globalSemaphore)、`:32`(perServerSemaphores 声明)/`:39`/`:42`(消费);`semaphore.ts:4`(class)、`:32`(withSemaphore) | 一致 | ✅ |
| 18 | `rg -n globalConfirmIds electron/remote/confirmId.ts` | `:6`(Set 声明)及 `:19`/`:20`/`:28`/`:33`/`:37` 消费 | 一致 | ✅ |
| 18 | 注册入口 | `chatCancelRegistry.ts`(:18 registerChatCancel / :26 signalChatCancel / :32 clearChatCancel / :36 throwIfChatCancelled / :41 cancelAllActiveChats);`toolRevocationRegistry.ts`(:7 / :11 / :21 / :27) | 一致 | ✅ |
| 19 | `rg -n "from 'electron'" electron/toolChatLoop.ts` | 0 命中;`^import` 共 117 条 | 一致 | ✅ |
| 19 | `rg -n '"workspaces"' package.json` | 0 命中 | 一致 | ✅ |
| 20 | `electron/toolChatLoop.inMemoryPorts.test.ts` | 存在 | 一致 | ✅ |
| 15 | `rg -n -e strict -e loose src/shared/policy/policyPackages.ts` | 档位语义注释 `:6-7`、desktop transforms `:72-74`、im transforms `:79-80`、availablePackages `:85`/`:91`/`:97` | 一致 | ✅ |
| 13 | `rg -n menuLabels src/shared electron --glob '!*.test.*'` | 仅 `electron/menu.ts:3`(`getMenuLabels`) | 一致 | ✅ |
| 14 | `rg -n -e retention -e rotate -e prune electron/agentLogger/` | 仅 `types.ts:131`(`usageStats.retention.cleaned` 事件类型),无轮转实现;`agentLogPaths.ts:15`(dev 目录)/`:25`(发布态 `.agent/logs`) | 一致 | ✅ |
| 24 | `rg -n enforceSessionEventRetention electron/sessionEvents.ts` | `:635` / `:636` / `:639` | 一致 | ✅ |
| 24 | `rg -n enforceSessionEventRetentionDetailed electron/main.ts` | `:39`(import)、`:443`(调用,硬编码 `100`) | 一致 | ✅ |

## 23 号专项:调用发起入口盘点(接线清单)

| # | 入口 | 位置 | lane | 现状 |
| --- | --- | --- | --- | --- |
| 1 | 桌面受理端口 `chat:submit-outbound` | `electron/ipc/agentProtocolIpc.ts:532` → `outboundAcceptor.submitOutbound` | user | 准入挂发起前 |
| 2 | 远端发起 `runImRemoteAgent` | `electron/remote/imRemoteAgent.ts:43` | user | 准入挂发起前 |
| 3 | 管家发起 `butlerInvoker` | `electron/butler/butlerInvoker.ts:112-116` | automation | 现 ButlerAdmission(并发=1+小时上限)收敛为 automation lane 配置 |
| 4 | 嵌套调用 `invokeApproval` | `electron/confirmation/agentChannel.ts:87`(装配)/`:173`(调用) | 继承等待方 | 优先级继承 + 有界等待 + 保留位 |

排水器不单列(`outboundAcceptor.ts:379` `drain` 复用 `submitOutbound` 同源)。
`butlerAdmission` 消费点:`butlerInvoker.ts:19/112/113/116`、`main.ts:13/597/630`、`approvalAgent.ts:247`(注释:内层不取票防自锁)。

## 17 号专项:契约内函数形态清单

| 位置 | 符号 | 形态 | 处置 |
| --- | --- | --- | --- |
| `invocation.ts:166` | `AgentWorkspacePorts.resolveWorkDir?: () => string` | 函数属性(非方法简写) | 改方法简写或归并宿主端口 |
| `invocation.ts:172` | `AgentCredentialsPorts.resolveApiKey(): Promise<string \| null>` | 接口方法 | 合法,白名单 |
| `invocation.ts:275` | `AgentHostPorts.getBrowserDetectContext?()` | 接口方法 | 合法,白名单 |
| `invocation.ts:280` | `AgentHostPorts.turnBoundary?: (input: unknown) => Promise<void>` | 函数属性 | 改方法简写或清出 |

A1 实际改造面以本清单为准(可能缩为「方法简写归一 + 形状断言防退化」)。

## 18 号专项:消费方符号级盘点(另见 A2 阶段补充)

- `builtinExecutors` registry:`getToolExecutor`(`:1330`)、`getRegisteredTool`(`:1334`)及 `electron/tools/` 内注册方;
- `audit` singleton:`electron/confirmation/audit.ts` 导出函数群;
- MCP semaphore:`mcpToolExecutor.ts` 内 `:137` 等消费;
- confirmId:`electron/remote/confirmId.ts` 导出函数群(远程确认一次性消费);
- chatCancelRegistry / toolRevocationRegistry:导出函数群,消费方在 toolChatLoop / cancel IPC / revocation IPC。

## A4 补记:probe:sqlite 的 Electron 依赖评估(偏差 20 第 2 条)

**结论:保留 Electron 探针,落宿主适配层(现状即满足,无改动)。**
`npm run probe:sqlite`(scripts/probe-node-sqlite.mjs)的存在意义是验证 **Electron 内嵌运行时**的
node:sqlite 可用性——解除 Electron 依赖即失去探测对象。探针已在宿主侧(CI `sqlite-electron-probe`
job 以真实 Electron 应用启动);SDK 面的 sqlite 禁依赖由 A3 护栏(check:agent-core)锁定,
两侧分工成立。

## A4 补记:验收达标面(偏差 20)

- ✅ `createAgentRuntime` 装配 + 内存端口,不启动 Electron、不碰 SQLite,跑完
  「带工具调用的回合 + 一次批准确认 + 一次拒绝」,断言结果四态与事件台账
  (electron/toolChatLoop.inMemoryPorts.test.ts);
- ✅ CI 常驻回归:ci.yml test job 独立 step(vitest node 项目)+ 全量 npm test;
- ✅ 包级组件语义验收(packages/agent-core/test/agentCore.test.ts,纯 node);
- ⏳ 「测试文件及其 import 闭包 rg -l electron → 0 文件」子项未达标:回合执行引擎
  (toolChatLoop 执行闭包,实测 442 文件 / 32 文件 import electron)物理切分属基线 §13
  完整 P5,列后续批次(见 A3 边界形态说明)。

---

## P8 实施记录(2026-09-20,分支 codex/batch3-runtime-admission-sdk-reuse)

各阶段提交:S1 `06e1f1ea` / S2 `748dc239` / S3 `9a0db31c` / A1 `94ddabc3` / A2 `fa545fcd` /
A3 `3d44bc68` / A4 `76fefd24` / B1 `7005d0a6`。全量回归与本记录同提交。

### 偏差表回写(按 §8 预期逐项)

| 偏差 | 回写状态 | 依据(实测) |
| --- | --- | --- |
| 15 | **已解决** | user lane 档位范围化(scopePackages 显式清单取代目标条目);全 lane 无宽严变换结构断言;「任意 lane × 档位不放宽 locked 底线」属性测试入仓(policyPackages.scope.test.ts);底线校验全 lane 生效 |
| 13 | **已解决** | `rg 'menuLabels' src/shared electron` → 0 行;translate 端口入契约(AgentHostPorts.translate)+ 宿主实现直读 zh-CN 真源(electron/i18n/hostTranslate.ts);菜单/系统通知文案键化;i18n:check 通过 |
| 14 | **已解决** | Agent 日志保留期清理归 Storage(electron/storage/agentLogRetention.ts)挂统一保留策略;按日文件天然轮转;启动维护 + 跨天节流双触发;删除留痕(retention.agentLogs.cleaned) |
| 24 | **已解决** | `rg 'enforceSessionEventRetention' electron/sessionEvents.ts` → 0 行;`rg 'enforceSessionEventRetentionDetailed' electron/main.ts` → 0 行(runSessionEventRetentionMaintenance 维护入口,启动流程只触发不持参数);删除留痕测试入仓 |
| 17 | **已解决** | 契约函数属性 0 行(`=>` 仅剩 1 行注释;P0 复测在 4 处证据外追查到 :245 嵌套函数属性一并收口);契约形状断言测试防退化(invocation.contractShape.test.ts) |
| 18 | **已解决** | 四处模块级可变状态归 createAgentRuntime 实例 + 两个注册入口随实例;四点名文件 `^(let\|const)` 四类状态绑定 0;同进程双 runtime 并存互不串状态测试入仓;兼容转发 @deprecated 一个发布周期 |
| 19 | **已解决**(边界形态见附注) | workspaces 生效(`npm query .workspace`);exports 只暴露 createAgentRuntime 与契约类型;CI 断言脚本入仓入 CI(三条:零 electron / 零 sqlite 直依赖 / 入口闭包 20 模块零 electron);typecheck 双 tsconfig(typecheck:agent-core) |
| 20 | **已解决**(子项遗留见附注) | createAgentRuntime + 内存端口不启动 Electron、不碰 SQLite 跑完「带工具调用回合 + 批准确认 + 拒绝」四态断言;CI 独立 step 常驻;probe:sqlite 评估结论:保留(探针即探测 Electron 内嵌运行时,已落宿主侧) |
| 23 | **已解决** | 四处发起入口(桌面受理端口 / runImRemoteAgent / butlerInvoker / 嵌套 invokeApproval)统一准入;四维处置(排队/延后/降级/拒绝)调用方声明;优先级(交互式 > 后台,background 子界);保留位防自锁(全局 + lane 双维度);cause 分立审计(admission.rejected[cause] ≠ agent-deny);`rg 'butlerAdmission' electron` 机制 0 消费(仅注释性提及);渲染端无绕过结构断言入仓;属性/不变量测试(mulberry32)入仓 |

### 附注(如实记录的边界与遗留)

1. **偏差 19 边界形态**(计划风险 #3 回退条款):契约层物理文件暂留宿主树,经包入口
   `@spaceassistant/agent-core` 门面转发;宿主主进程为 tsc CJS 直出,包名 require 无运行时解析面,
   物理迁移会破坏构建链。逻辑边界由护栏闭包断言锁定(SDK 入口展开 20 模块零 electron)。
   **遗留**:执行闭包物理切分——基线 §13 预估 35-45 文件,P0 实测 builtinExecutors 闭包 442 文件
   (328 个在 electron/),预估已漂移;列为后续批次。
2. **偏差 20 子项遗留**:SDK 验收测试的「import 闭包零 electron」子项依赖上述执行闭包切分,
   当前由 vi.mock 隔离 electron 本体(不启动 Electron 达成,import 闭包未达成)。
3. **worktree 环境备注**:worktree 的 node_modules 为 junction 链接;workspaces 链接
   (node_modules/@spaceassistant/agent-core)以 junction 手工模拟使 `npm query .workspace` 可验,
   合入主线后 `npm install` 会自然重建为正确链接。
4. **护栏实现选型**:仓库无 ESLint 基础设施,计划改动清单中的 `no-restricted-paths` 以 CI 断言
   脚本(scripts/check-agent-core-boundary.mjs)等价落地,三条断言语义一致。
5. **真机验收项**(§6,不阻塞提交,合并后人工过一遍):桌面菜单/托盘/系统通知 zh-CN 文案(S2);
   日志与台账轮转触发(S3);桌面高优先发起抢占管家调用、定时任务被拒后审计可见(B1);
   CI 干净环境跑通 SDK 验收与护栏(A3/A4)。

### 下一批议题(从偏差面切到能力面)

24 条偏差全部闭环后,按基线 §12 收束:定时/事件驱动源编排(23 为其直接前置)、通用 SubAgent
派生业务、设置页 reasoning 档位选择器、执行闭包物理切分(19/20 遗留)。

### P8 补记:全量回归修复与结构解环(提交 `4b20923a` 之后)

首轮全量回归暴露两类问题并修复,最终全量 **4632 passed / 0 failed**(另有 typecheck 双 tsconfig、
i18n:check、check:agent-core 全绿):

1. **CJS 加载环**(channels/imChannel 实测「Class extends value undefined」):六原模块(兼容转发)
   → agentRuntime → builtinExecutors(442 文件闭包)→ feishu 工具链 → imChannel,首条边在环内触发
   半初始化类。终态:**agentRuntime.ts 纯工厂化**(组件全注入,零业务 import)、
   **agentRuntimeDefaults.ts 零依赖纯槽位**(未装配 fail-loud)、六原模块兼容转发改指 defaults。
2. **测试装配**:electron 项目新增 testSetup.ts(装配真组件类——兼容转发联动语义在测试同样生效;
   但不 import builtinExecutors 重链,避免抢先实例化模块图致 vi.mock('electron') 失效);
   需要 builtin registry 的 6 个测试文件显式 createBuiltinToolRegistry() 注入。
3. approvalAgent.test P2-7 用例随 butlerAdmission 退役迁移到统一准入门。

### P8 补记:评审修复(`batch3-runtime-admission-sdk-review.md`,P0-1 + P1-1..5 + 部分 P2;本地过程产物,不入版本控制)

评审结论「1 P0 + 5 P1」逐项处置(全部由源码复核确认属实):

| 项 | 处置 |
| --- | --- |
| P0-1 生产装配空壳 | 新增 `electron/runtime/desktopAgentRuntime.ts`(createDesktopAgentRuntime:六真组件 + builtinRegistry + 审计惰性工厂,独立模块不进加载环);main.ts 装配改用它并注释禁空参;**生产装配 smoke 测试**入仓(desktopAgentRuntime.smoke.test.ts,不经 testSetup:builtin 解析/confirmId 非空/取消真实中止/撤回生效/槽位兼容链) |
| P1-1 启动顺序颠倒 | main.ts 调换:先 resetActiveAdmissionOnStartup 再 new CallAdmissionGate({db});补「脏活跃状态 db → new Gate 容量不被蚕食」用例 |
| P1-2 速率窗口永不回写 | gate.tryAdmit / wakeNext 判定前 `this.state = rollAdmissionWindow(this.state, now)` 滚动落状态;补跨 HOUR 边界 gate 级用例(全局速率 + 管家 lane 配额两维度:窗口内拒、跨窗恢复) |
| P1-3 嵌套准入三缺陷 | ①生产接线:toolChatLoop 装配 AgentChannel 传 `admissionGate: getCallAdmissionGate()`;②lane 改继承 `this.deps.lane`(去掉硬编码 automation);③票据覆盖内层回合全程(settle 时释放,不再 invokeApproval 前瞬时释放) |
| P1-4 hostTranslate 目录错一级 | 开发态从 mainDirname 逐级向上探测 `src/renderer/i18n/resources`(最多 5 级,编译输出深度变化不再漂);探测不到回退历史口径 |
| P1-5 护栏漏边 | check-agent-core-boundary 重写:扫描面统一为「SDK 入口完整闭包」(此前 20 模块中约 16 个在宿主树不受禁令约束,实测修复后闭包 29 模块);正则覆盖单/双引号、副作用 import、require()、动态 import、`export * from`;bare `electron`/子路径与 `node:sqlite` 闭包内一律违规 |
| P2(本批顺手) | ticket.release once 幂等守卫;defaults 重复装配告警;imRemoteAgent progress session 挪进票据 try(消除泄漏窗口);outboundAcceptor acquire 带 requestId |
| P2(记录为遗留) | 排队无取消/超时(与 chatCancel 联动,涉及 butlerInvoker 取消面,下批);packages/agent-core main 指向 .ts 的潜在 require 地雷(当前无消费方);桌面受理票据瞬时(设计取舍,注释已声明) |

**偏差结论复核**(评审指出「全绿=假安全」与表述过头):

- **偏差 18「已解决」表述修正**:多实例能力(createAgentRuntime 任意多实例、互不串状态)对**显式注入**消费方成立并有测试;生产消费面经 defaults 槽位为**单例装配**(宿主选择,重复装配有告警)——「多实例化」指状态随实例走与工厂能力,非生产多实例运行。
- **偏差 23**:四处入口(含嵌套第四入口)现已真实接线并统一准入,「已解决」结论在修复后成立。
- **「4632 全绿」**:修复后重新全量核验(见下),且新增生产装配 smoke 不经 testSetup,测试/生产装配不一致的假安全面已关闭。
