# Wiki 集中共享存储 — 开发与测试计划

> 依据：[wiki-shared-centralized-storage-requirement.md](../requirement/archive/knowledge-skills/wiki-shared-centralized-storage-requirement.md) v1.12（已通过；v1.11 实施基线 + v1.12 展示数据源补丁）
> 评审轨迹：需求 v1–v4 四轮评审无未决项；计划 v1 评审 9 条 + 复审 v2 4 条全部落实
> 更新：2026-10-10（初版）
> 修订：2026-10-10（**v2**：按[计划评审报告](../review/2026-10-10-wiki-shared-centralized-storage-dev-test-plan-review.md) 9 条建议修订——#3 T1.1/T1.2 倒置、#4 T1.12 拆 a/b/c、#5 T2.2 拆 a/b、#1/#2 补覆盖缺口（`config.wiki.migration` 持久化、失效广播 hint 词汇路径）、#6–#8 依赖与关键路径修正、#9 断言补齐）
> 修订：2026-10-10（**v3**：按[复审 v2](../review/2026-10-10-wiki-shared-centralized-storage-dev-test-plan-review-v2.md) 修订——N1 T2.2a 依赖补 T1.12b/T1.13；N2 需求补丁 v1.12（`wiki:status.projects`）同步到 T0.2/T1.12a/T2.5；N3 T1.12c/T2.2a 补互斥断言；N4 矩阵编号修正）
> **状态约定：** `TODO` = 未开始；`RED` = 测试已写、实现未过（TDD 红）；`GREEN` = 测试通过；`manual` = 需真机/人工验收。
> **实施状态（2026-10-10）：** P0–P3 全部任务开发与自动化验证完成（TDD 红绿，防护类任务均先证红再证绿）；§2 `manual` 项（M1–M7）待真机走查；全量终验见 T3.3。

---

## 0. 执行纪律（对齐 AGENTS.md）

1. **开发期只跑定向测试**：`npm exec vitest run <文件>`；不确定影响面用 `npm run test:related -- <改动文件>`；禁止循环跑全量。
2. **里程碑验证**：每 Phase 收尾跑 `npm run test:electron` + `npm run build:electron:incremental` + `npm run typecheck:renderer`（涉及时）；全量 `npm test` + `npm run build` 仅在 P3 终验。
3. **红绿验证**：防护类任务（互斥、deny、越界）必须先证红（破坏实现转红）再证绿。
4. **提交点**：每 Phase 收尾一次提交；**P1 与 P2 必须同一版本发布**（需求 §16 硬约束 D8）。
5. **验收边界**：见 §2——每 Phase 的 `manual` 项在收尾时集中跑，不阻塞开发循环。

---

## 1. 交付物与 Phase 概览

| Phase | 内容 | 发布约束 |
|-------|------|----------|
| **P0 基建** | 共享常量、配置模型、DB 迁移、wikiMount、wikiWriteMutex | 可独立发（行为不变） |
| **P1 主进程切换** | 探测层/permit/执行层/grep/fileIpc/技能/SCHEMA 注入全部经挂载 | **必须与 P2 同版本** |
| **P2 迁移与引导** | 迁移检测/执行/报告、别名注册、WikiPane/WikiTab UI、i18n | **必须与 P1 同版本** |
| **P3 收尾** | 字面量清理收口、文档升位、全量验收 | 可滞后一版 |

---

## 2. 验收边界（开工前对齐）

**可单测验证（本计划绝大多数任务）**：wikiMount 解析、zone 豁免、scope 分类、permit 一致性、互斥不变量、grep 双根、fileIpc 子通道、迁移合并（fixture）、改名流程、projectId/display_name 规则。

**需真机 / 手工验收（`manual`，集中在各 Phase 收尾）**：

| # | 项 | Phase |
|---|----|-------|
| M1 | 多 profile 切换：项目 A 沉淀 → 项目 B 查询 | P1 |
| M2 | 并行双会话同写 index.md 无内容撕裂 | P1 |
| M3 | 飞书/微信远程会话 ingest + 写 wiki 页全链路 | P1 |
| M4 | 迁移向导完整 UI 流程（检测含自定义根 → 执行 → 报告 → 旧目录确认 → 别名链接打开） | P2 |
| M5 | WikiPane 版本失效刷新、聊天历史链接、fileShowInExplorer、watch 实时刷新、export-markdown 图片 | P1/P2 |
| M6 | 打包模式 userData 路径与 `-dev` 隔离 | P3 |
| M7 | i18n zh/en 完整性走查 | P2 |

---

## 3. 任务依赖图（v2 修正：双链并行）

```
T0.1 常量 ──> T0.2 配置模型 ──> T0.5 wikiMount ──┬─ 链A（探测/执行）：T1.1 → T1.2 → T1.3/T1.4 → T1.5/T1.6/T1.7/T1.9/T1.10
T0.3 DB 表（独立）───────┬───────────────────────┤
T0.4 键收敛（独立）       │                        ├─ 链B（wiki/迁移）：T1.12a → T1.12b → T1.12c → T2.1 → T2.2a → T2.2b → T2.3 → T2.4 → T2.5/T2.6 → T2.7
T0.6 互斥（独立）────────┼───────────────────────> T1.7（互斥接入）
                          └── T1.12a/b（wiki_projects 表消费）
fileIpc 族 T1.15–T1.17（仅依赖 T0.5，与链A/链B并行）──┘
两链汇合于 T1.19（P1 收尾）→ T2.8（P2 收尾）→ T3.3
```

- **链A（探测/执行）与链B（wiki/迁移）在 T0.5 完成后即可并行**——这是缩短 P1 工期的主要并行机会（v2-S3 修正：原关键路径误把 T1.12 串在 T1.7 之后）；
- 链B 所画为**推荐串行次序**；表内依赖为**最小依赖**——如 T2.1 仅依赖 T1.12a，可在 T1.12b/c 期间插空提前；
- **真实关键路径**：`T0.1 → T0.2 → T0.5 → 链B（T1.12a → T2.1 → T2.2a/b → T2.4 → T2.5/T2.6 → T2.7）→ T2.8`（链B 任务更多且含 UI，是工期瓶颈）；链A 只需在 T1.19 前完成；
- 可并行组：`{T0.3, T0.4, T0.6}` 互不依赖；链A 内 T1.3/T1.4 可并行；fileIpc 族（T1.15–T1.17）随时可插空；T2.5/T2.6 可并行。

---

## 4. 任务清单

> 每个任务的「完成判定」均为客观可查：指定测试文件/用例名、命令或可观察行为。状态列初始 `TODO`。

### Phase 0 — 基建（行为不变，可独立发）

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T0.1** | 共享词汇常量：`WIKI_VOCABULARY_PREFIX`（词汇前缀）、`DEFAULT_WIKI_ROOT_DIRNAME`（默认物理目录名）唯一定义 | 新增 `src/shared/wikiConstants.ts` | ① 常量值断言测试 `wikiConstants.test.ts`（防误改）；② `typecheck:renderer` + `typecheck:shared` 绿 | — | GREEN |
| **T0.2** | 配置模型扩展：`WikiConfig.legacyRootAliases?: string[]`、**`migration?: { status; completedAt?; report?; legacyRootAliases? }`（v2-C1 补）**；`rootPath` 注释改「共享库目录名」；`WikiStatus` 增 `shared/projectCount/pendingLegacyMigration/legacyRoots` + **`projects: Array<{projectId, displayName, workDir, orphan}>`（v3-N2，需求 v1.12）**；虚拟目录条目 `virtual?` 字段；`readWikiConfig` merge 新字段默认值 | `src/shared/domainTypes.ts`、`electron/ipc/ipcShared.ts` | ① `readWikiConfig` 单测：旧配置（无新字段）→ 返回带默认值完整对象；含 `legacyRootAliases`/`migration` 的配置 round-trip；② `typecheck:shared` 绿 | T0.1 | GREEN |
| **T0.3** | DB 迁移 v(n+1)：建 `wiki_projects` 表（`project_id` PK / `work_dir` UNIQUE / `display_name` / `profile_id` / `first_seen_at` / `orphan`）+ CRUD 封装（insert / getByWorkDir / markOrphan / list） | `electron/database/schema.ts`、`migrations.ts`、新增 `electron/wiki/wikiProjectStore.ts` | ① 迁移测试（仿 `migrations.v11.test.ts`）：旧版库升级后表结构断言；② CRUD 单测：UNIQUE 冲突、orphan 置位、同 workDir 收敛同 projectId | — | GREEN |
| **T0.4** | config key 收敛（v3-S1）：`main.ts:132` 局部 `WIKI_CONFIG_KEY` 并入 `CONFIG_KEYS.wiki` | `electron/main.ts`、`electron/ipc/ipcShared.ts` | `rg WIKI_CONFIG_KEY electron/` 仅剩 `CONFIG_KEYS.wiki` 一处定义；`test:related` 相关测试绿 | — | GREEN |
| **T0.5** | `wikiMount.resolveWikiMount` 纯函数：§7.1 八条规则（规范化 / realBase 绝对反向命中→规则 4/5 / 越界不挂载 / 词汇前缀→读写 / 别名前缀→readOnly / 单次重映射 / disabled 恒 false / 纯函数无 IO） | 新增 `electron/wiki/wikiMount.ts` + `wikiMount.test.ts` | 单测逐条：①词汇相对命中；②根本身命中；③Windows 反斜杠与尾斜杠；④realBase 绝对反向命中（`{userData}/llm-wiki/raw/x.md` → 词汇 `raw` 分类一致）；⑤`..` 穿越不挂载；⑥越界绝对路径不挂载；⑦disabled 恒 false；⑧别名 readOnly；⑨**物理目录名读配置**（rootPath=`my-lib` 时 realBase 跟随）；⑩纯函数性（同入参同输出，无副作用） | T0.1 T0.2 | GREEN |
| **T0.6** | `wikiWriteMutex`：文件粒度异步互斥（`Map<absPath, Promise>` 串行队列 + `withMutex(path, fn)`） | 新增 `electron/wiki/wikiWriteMutex.ts` + `.test.ts` | **不变量测试**（AGENTS.md 纪律）：mulberry32（固定种子）随机生成 200 步并发 write/edit 序列，每步后断言：①同文件内容 = 按互斥区进入顺序串行应用的结果；②不同文件允许交错；③终态队列清空（无悬挂 promise/死锁）；**红绿**：临时移除互斥包装 → ①转红 | — | GREEN |
| **T0.7** | **P0 收尾** | — | `npm exec vitest run`（T0.1–T0.6 全部测试文件）绿；`npm run test:electron` 绿；`build:electron:incremental` 通过；提交（tag 备注行为不变） | T0.1–T0.6 | GREEN |

### Phase 1 — 主进程切换（必须与 P2 同版本）

**探测层族**

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T1.1** | 探测函数 `mountAnchors` 可选入参（**v2 倒置：先扩展签名，零行为差异先证**）：`probeWritePathFact` / `probeReadPathFact` 命中时包含锚点换 `realBase`，fact 增 `vocabularyPath` / `scopeBase` | `electron/confirmation/extractors/writePathFacts.ts`、`readPathFacts.ts` + 测试 | 单测：①挂载入参 fact.normalizedPath=真实路径、vocabularyPath=词汇、scopeBase=realBase；②**未传参行为与现状逐字节一致**（全量既有探测测试零改动通过即证，硬门槛）；③missing 回退路径（共享库无此文件）正常产出 | T0.5 | GREEN |
| **T1.2** | gate 三处调用点接入（**v2 倒置：T1.1 签名就绪后接线**）：写探测（`:583`）/读探测/微信 media 探测（`:681-687`）以 `resolveWikiMount` 结果构造 `mountAnchors` 传入；wiki 停用时不传 | `electron/confirmation/toolCallGate.ts` | gate 层单测：①挂载入参 → anchors 含 `{base: realBase, vocabularyPrefix}`；②wiki 停用 → anchors 缺省、探测入参与现状一致；③media 探测点同验（v4-C3） | T1.1 | GREEN |
| **T1.3** | `classifyReadPathZone` 增 `sensitiveRootExemptions`：豁免优先（短路全部敏感前缀，压过 `AppData\Roaming`/`~/Library` 祖先级前缀），豁免后走 system-dir → 包含判定；gate 侧 wiki 启用时构造 `[{userData}/llm-wiki]` 传入（ProbeInput 透传） | `readPathFacts.ts:69-85`、`shell/shellSensitivePaths.ts`（matchSensitive 透传）、`toolCallGate.ts` + 测试 | 单测：①wiki 子树（锚 realBase）zone=`workdir-normal`；②userData 其他路径照旧 sensitive；③home 下非 wiki 路径照旧；④**祖先级前缀不漏**（构造 `userData` 与 `AppData\Roaming` 双前缀命中场景）；⑤未传豁免行为不变；⑥写探测（writePathFacts:191 同入口）结果一致 | T1.1 T1.2 | GREEN |
| **T1.4** | 写范围分类基准：`classifyWriteTargetScope` 判定改用 fact.`scopeBase`（gate `:592` 调用处）；`unknown` catch 兜底保持 | `toolCallGate.ts:590-602` + 测试 | 单测：①挂载目标 → `inside-workdir`；②workDir 外真实越界 → `outside-workdir` 不变；③探测异常 → `unknown` 不变；信号 `write-target-scope` 值域断言（`inside-workdir/outside-workdir/unknown`） | T1.1 T1.2 | GREEN |
| **T1.5** | `defaultRules` 零改动契约：locked 规则集快照/diff 测试 | 新增 `src/shared/policy/defaultRules.contract.test.ts`（或就近） | ①快照断言 `DEFAULT_POLICY_RULES` 的 id/match/action/locked 全集（含 `wiki-raw-write-deny`、`remote-outside-write-deny`、`remote-outside-read-deny`、`automation-sensitive-path-deny`、`path-sensitive-read-confirm`、`remote-wechat-media-outside-deny`）；②人为改任一规则转红后还原 | — | GREEN |

**permit / 执行层族**

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T1.6** | 写 permit 双字段 + 一致性守卫：`WriteExecutionPermit` 增 `vocabularyPath`（签发映射带过）；写执行体入口对入参**二次挂载比对**，失配 fail-closed | `electron/confirmation/writeExecutionPermit.ts`、`toolCallGate.ts`（签发）、`builtinExecutors.ts:766-778` + 测试 | 单测：①permit.vocabularyPath === Agent 词汇入参；②**写侧审批卡片 facts 的 path 为词汇路径**（`path-target` 信号断言，v2-C4，与读侧 T1.8④ 对称）；③执行层入参与 permit 词汇一致 → 放行；④人为漂移（改配置模拟）→ fail-closed 错误码；⑤`validateWriteExecutionPermit` 对新字段校验 | T1.1 T1.2 | GREEN |
| **T1.7** | 执行层写挂载 + 互斥：write_file/edit_file 挂载命中走 `realBase` 沙箱解析（permit 目标或兜底 `resolveSafeWriteTarget(realBase,…)`）；wiki 命名空间写入包 `wikiWriteMutex` | `builtinExecutors.ts:814/964` 一带 + 测试 | 单测：①挂载写落 `{userData}/<rootPath>/`；②未挂载写落 workDir 不变；③wiki 根下拒 symlink / 拒硬链接 / 拒目录目标逐条**红绿**；④并发双写同 wiki 文件经互斥串行（内容无交错）；⑤别名路径写 → 拒绝 + 引导文案；⑥**写完成 → `notifyFileTreeChanged` hint 为 `llm-wiki/...` 词汇路径、不含 userData 真实路径**（v2-C2） | T1.6 T0.6 | GREEN |
| **T1.8** | 执行层读挂载：read_file / list_directory 经 `resolveReadPermitTarget` 前置挂载解析；读 permit 映射增 `vocabularyPath` | `electron/confirmation/readPermitExecutor.ts:18-21`、`toolCallGate.ts:975` 签发映射、`builtinExecutors.ts:1818` + 测试 | 单测：①挂载读返回共享库内容；②目录 permit（list/grep subtree）挂载解析 + identity 复核正常；③未挂载读不变；④审批 facts 的 path 字段为词汇路径（卡片展示断言） | T1.1 T1.2 | GREEN |
| **T1.9** | 远程写断言改造：`assertRemoteWriteTargetInsideWorkDir` 改按 scopeBase 结论（挂载命中对 realBase 断言） | `builtinExecutors.ts:755-764,775` + 测试 | 单测（四象限）：①远程 lane 写 wiki 页 → 通过（permit 正常签发）；②写 raw → `wiki-raw-write-deny`；③写 workDir 外非 wiki → `remote-write-target-outside-workdir`；④只读别名写 → 拒绝 | T1.4 | GREEN |
| **T1.10** | wiki-raw 信号反向识别：gate `:607` 信号判定前先 `resolveWikiMount`，命中（含 realBase 绝对形态）以 `vocabularyPath` 分类 | `toolCallGate.ts:607` + 测试 | 单测：①`llm-wiki/raw/x.md` → `wiki-raw-target`；②`llm-wiki/raw/p-xxx/f.md` → 命中；③realBase 绝对形态 → 命中（依赖 T0.5 规则 2）；④非 raw wiki 页 → 无信号；⑤desktop lane raw 写 → `wiki-raw-write-deny` forbid | T0.5 | GREEN |

**grep 族（P1 最重，内部三步）**

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T1.11a** | 双根规划：`planGrepInvocation` 支持多根（`roots: [workDir, wikiRoot]`），每根各产出 plan | `electron/tools/grepScope.ts:108` + 测试 | 单测：①无 path → 双根 plan（wiki 启用时）；②wiki 停用 → 单根（现状）；③path 指向 wiki 词汇 → 仅 wiki 根子路径 plan | T0.5 | GREEN |
| **T1.11b** | 双根执行编排与结果合并：rg/walk 每根各执行；head_limit / truncated 口径统一；`formatGrepNoMatchOutput` 多根文案；结果路径改写回词汇；排序确定性 | `builtinExecutors.ts` rg（`:1279`）/walk（`:1868`）/回填（`:1960`）三消费点 + 测试 | 单测：①两根各有命中 → 合并去重、排序稳定（同输入两次运行结果逐字节一致）；②仅 wiki 根命中 → 路径为 `llm-wiki/...` 词汇；③两根均无命中 → 无匹配文案含双根；④head_limit 截断口径跨根一致；⑤单根超时/降级 → 另一根结果照常返回 | T1.11a | GREEN |
| **T1.11c** | workDir 根排除挂载前缀实体目录（§7.7 去重）：rg/walk 排除 glob `!<rootPath>/**` 及别名前缀 | `grepScope.ts` / 编排层 + 测试 | 单测：fixture 中 workDir 内放残留实体 `llm-wiki/` 目录 + 共享根同名文件 → 结果**仅含共享根一份**；共享根为空 → 无该词汇路径结果（§7.7 语义） | T1.11a | GREEN |

**wiki 模块族**

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T1.12a** | wikiInit/wikiStatus 切共享根（v2 拆分）：①`wikiInit` 骨架建到 `{userData}/<rootPath>`（meta v2 `storage:"shared"`）；②`wiki:init` payload 忽略 rootPath 自定义（v2-C5 显式断言）；③主进程受控 rename 支持（改配置 + rename + 失效广播 + 失败回滚，供 T2.6 设置页调用，v2-S5 挪入）；④`wikiStatus` 读共享根 + 新字段（shared/projectCount/pendingLegacyMigration/legacyRoots/**projects 列表**，v3-N2） | `electron/wiki/wikiInit.ts`、`wikiStatus.ts` + 测试 | 单测：①init 骨架结构断言（子目录全集 + meta v2 `storage:"shared"`）；②重复 init 幂等；③**`wiki:init` 传入自定义 rootPath 值被忽略、骨架仍建在配置目录**（v2-C5）；④rename 成功 / 目标已存在回滚 / 失效广播触发；⑤wikiStatus 新字段取值（**含 `projects` 列表映射自 `wiki_projects` 表**，v3-N2） | T0.3 T0.5 | GREEN |
| **T1.12b** | projectId / display_name / `wiki_projects` 登记（v2 拆分）：canonical workDir sha256 前 8 位 `p-<hash8>`；`wiki_projects` insert/getByWorkDir/markOrphan 接通；display_name 取名规则（profile 名 → basename → 重名追加一级父目录 → 完整路径供 tooltip） | 新增 `electron/wiki/wikiProjects.ts` + 测试 | 单测：①同目录两次计算同 id、不同目录不同 id；②Windows 大小写/分隔符规范化收敛同 id；③display_name 四规则逐条；④登记后 `wiki_projects` 行断言（含 UNIQUE 冲突收敛、orphan 置位） | T0.3 T1.12a | GREEN |
| **T1.12c** | wikiImport 切共享根（v2 拆分）：ingest 目标 `raw/<projectId>/`、落盘经挂载沙箱（`resolveSafeWriteTarget(realBase,…)`）**且包 `wikiWriteMutex` 互斥区（v3-N3，§9.4）**；**ingest 完成失效广播 hint 为词汇路径**（v2-C2） | `electron/wiki/wikiImport.ts` + 测试 | 单测：①ingest 目标路径 `raw/p-xxx/<basename>`、重名 auto-rename、跨 workDir 来源拷贝；②广播 hint 断言：词汇路径、不含 userData 真实路径；③**ingest 落盘经互斥区**（与并发写同文件的 mock 写入串行，v3-N3） | T1.12b | GREEN |
| **T1.13** | 技能用户级安装 + 模板更新：安装到 `getUserSkillsDir`；SKILL.md/SCHEMA.md 新模板（共享守则 / `wiki/projects/` 分区 / `raw/<projectId>/` / 禁 shell / log 条目格式） | `electron/wiki/wikiInit.ts:11`、`wikiTemplates.ts` + 测试 | 单测：①init 后技能位于用户级目录、workDir `.space-skills` 无副本；②skillScanner 场景：用户级 llm-wiki 生效；③模板内容断言（含「跨项目共享」「禁 shell」关键句）；④迁移清理项目级副本的函数就绪（P2 调用） | T1.12a | GREEN |
| **T1.14** | SCHEMA 注入切换：`readWikiSchema` 内部经挂载读全局 SCHEMA（`agentProtocolIpc.ts:721-723` 调用方不变） | `electron/wiki/wikiInit.ts:123` + 测试 | 单测/集成：注入内容 === 共享库 SCHEMA.md；共享库未初始化 → 注入跳过（现状行为） | T1.12a | GREEN |

**fileIpc 族（可与探测层族并行）**

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T1.15** | fileIpc 子通道挂载（§7.4 表逐行）：list-directory（根列表虚拟条目 + 实体残留跳过）、read-file、showInExplorer、delete/rename（同侧映射 + realBase 断言）、move/copy（跨边界 copy 两段式 / move 显式拒绝）、wiki:resolve-path（absPath 经挂载 + 别名 readOnly 标记） | `electron/ipc/fileIpc.ts`、`agentProtocolIpc.ts:1328-1335` + 测试 | 每子通道至少一测：①`llm-wiki` 目录列出共享库内容；②根列表虚拟条目（`hideWikiFromFileTree=false`）/实体残留不双列；③delete/rename 同侧成功且限 realBase 内；④copy 跨边界成功、move 跨边界显式拒绝（错误文案）；⑤showInExplorer 收到真实路径（mock shell）；⑥resolve-path 的 absPath 为真实路径、别名标 readOnly | T0.5 | GREEN |
| **T1.16** | fileContentWatcher 挂载解析：`file:watch-content` 启动前经 `resolveWikiMount` 解析真实路径再 `fs.watch`；切 workDir 统一停 watcher 行为保持 | `electron/ipc/fileIpc.ts:61-72`、`electron/fileContentWatcher.ts:17` + 测试 | 单测：①wiki 词汇路径启动监听成功（tmp 目录模拟共享根，写文件触发失效广播）；②workDir 内普通文件监听不变；③切 workDir → 停止 | T0.5 | GREEN |
| **T1.17** | export-markdown：source 经挂载解析 + 图片调用点补传 `extraRoots=[source 真实目录]`（`fileIpc.ts:131`） | `electron/ipc/fileIpc.ts:114-137` + 测试 | 单测：wiki 页（含相对图片）位于共享根 → 导出 HTML 含图片；workDir 页导出不变 | T0.5 | GREEN |
| **T1.18** | configIpc wiki 字段：`legacyRootAliases` 保存/读取透传（`configIpc.ts:360-371` merge 链） | `electron/ipc/configIpc.ts` + 测试 | 单测：wiki 配置含别名字段 round-trip；非法值（非 string[]）被 merge 归一 | T0.2 | GREEN |

**P1 收尾**

| ID | 任务 | 完成判定 | 依赖 | 状态 |
|----|------|----------|------|------|
| **T1.19** | P1 收尾验证 | ①定向测试全绿；②`npm run test:electron` 绿；③`build:electron:incremental` + `typecheck:renderer` 绿；④`manual` M1–M3、M5（P1 部分）走查；⑤提交 | T1.1–T1.18 | GREEN |

### Phase 2 — 迁移与引导（必须与 P1 同版本）

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T2.1** | 迁移检测：`wiki:migration-status` 数据层——扫 profiles 的 `llm-wiki/` + 存量配置 rootPath（≠默认时双扫），旧结构特征判定（SCHEMA.md 或 wiki/index.md），产出 `legacyRoots/pendingLegacyMigration` | 新增 `electron/wiki/wikiMigration.ts` + 测试 | fixture 单测五态：无旧根 / 单默认根 / 多 profile 多根 / 自定义根 / 共享库已初始化但仍有未迁 profile（可增量） | T1.12a | GREEN |
| **T2.2a** | 迁移文件管线（v2 拆分）：raw 拷贝（projectId 目录）/ 页面合并（无冲突拷入、同内容跳过、冲突双保留 `<name>.from-<projectId>.md` + 平行版本提示行）/ 删项目级技能副本 / 旧目录改名 `.migrated-{ts}` / `extraLegacyRoots` 手工根 / **幂等可重试**（按目标存在性跳过，非事务）/ **写入经 `wikiWriteMutex` 互斥区（v3-N3，§9.4）** / **报告持久化至 `config.wiki.migration` 并 round-trip 可读**（v2-C1）/ **迁移写入失效广播 hint 为词汇路径**（v2-C2） | `wikiMigration.ts` + 测试 | fixture 双旧 wiki（含一个自定义根 profile）：①§15.1 迁移行文件管线部分逐条断言；②**`config.wiki.migration` 写入后 readWikiConfig round-trip 读回一致**（v2-C1）；③广播 hint 词汇路径断言（v2-C2）；④改名映射表产出；⑤中断后重跑收敛（中途 kill 模拟 → 重跑完成且无重复拷贝）；⑥技能副本删除断言（复用 T1.13④ 清理函数）；⑦**迁移写入经互斥区**（与并发 Agent 写同文件串行，v3-N3） | T2.1 T0.3 **T1.12b T1.13** | GREEN |
| **T2.2b** | index/log/SCHEMA 纯文本归并（v2 拆分）：index 按分类追加归并（冲突条目并列标注来源）/ log 时间戳归并注入 `[project:<id>]` 前缀 / SCHEMA 哈希分叉（等于旧默认模板 → 替换新版；已被修改 → 保留 `SCHEMA.legacy-<projectId>.md` 供人工比对） | `wikiMigration.ts` + 测试 | 单测：①index 分类归并 + 冲突并列断言；②log 多源时间戳排序 + 前缀注入；③SCHEMA 三分支（默认模板/已修改/缺失）；④与 T2.2a 管线串联的全量 fixture 断言（§15.1 迁移行整体绿） | T2.2a | GREEN |
| **T2.3** | 别名注册接通：迁移完成把旧自定义根名写入 `config.wiki.legacyRootAliases`（含 extraLegacyRoots 指定根） | `wikiMigration.ts`、`ipcShared.ts` + 测试 | 单测：迁移后 ①挂载层识别别名（读挂载 readOnly）；②`file:read-file('alias/...')` 打开真实文件；③别名写拒绝 + 引导文案 | T2.2a | GREEN |
| **T2.4** | IPC 通道：`wiki:migration-status` / `wiki:migrate-legacy`（payload `{profileIds?, extraLegacyRoots?}`）注册 + preload/api 类型 | `agentProtocolIpc.ts`、`electron/preload.ts`、`src/shared/api.ts` | ①handler 单测（复用 T2.1/T2.2a/b 数据层，断言 payload 解析与报告结构）；②`typecheck:renderer` 绿（API 类型闭合） | T2.2b | GREEN |
| **T2.5** | WikiPane UI：迁移提示条（`pendingLegacyMigration`）→ 向导弹窗（profile 选择 / extraLegacyRoots 手工输入 / 进度 / 报告含改名映射与冲突清单）；raw 节点 projectId 显示名 + tooltip 完整路径（**数据源 `wiki:status.projects`，v3-N2**）；读失败查改名映射 → 「已合并至 …」跳转（未命中 → 通用失败提示） | `src/renderer/components/WikiPane/*` + 测试 | 组件测试：①提示条条件渲染与点击事件；②向导表单提交 payload 组装（含 extraLegacyRoots）；③报告渲染（冲突/改名映射）；④改名提示逻辑纯函数单测（映射命中/未命中）；⑤**raw 节点显示名取自 `wiki:status.projects[].displayName`、tooltip 为 workDir**（v3-N2） | T2.4 | GREEN |
| **T2.6** | WikiTab 设置页：rootPath 改「共享库目录名」可编辑（受控 rename：改配置 + rename + 失效广播 + 失败回滚；有未迁移旧根先引导）；迁移入口/报告查看（数据源 `config.wiki.migration`）；打开共享库目录按钮 | `src/renderer/components/Config/WikiTab.tsx` + 测试 | ①组件测试：改名流程调用序列（含失败回滚断言）、未迁移引导优先；②报告查看从 `config.wiki.migration` 渲染（v2-C1 数据源闭合）；③打开目录按钮调用真实路径 | T2.4 T1.12a T1.18 | GREEN |
| **T2.7** | i18n：`wiki.json` + `config.json`（wiki.* 节）新增全部 UI 文案 zh-CN/en-US | `src/renderer/i18n/resources/{zh-CN,en-US}/` | `npm run i18n:generate-types` + `npm run i18n:check` 绿；硬编码扫描（`i18n:check:strict`）绿 | T2.5 T2.6 | GREEN |
| **T2.8** | **P2 收尾** | — | ①定向测试全绿；②`test:electron` + `test:renderer` 绿；③build 双端绿；④`manual` M4、**M5（P2 部分：迁移后聊天历史链接 / watch 实时刷新 / export-markdown 图片的迁移后场景）**、M7 走查；⑤**与 P1 同版本提交**（D8 硬约束） | T2.1–T2.7 | GREEN |

### Phase 3 — 收尾（可滞后一版）

| ID | 任务 | 改动文件 | 完成判定 | 依赖 | 状态 |
|----|------|----------|----------|------|------|
| **T3.1** | 字面量清理收口（D9）：`markdownExport.ts:54`、`ChatMarkdown.tsx:60` 等改引 `wikiConstants`；源码扫描断言测试（白名单：常量定义处 / `wikiTemplates.ts` 模板正文 / 测试 fixture / i18n 文案 / `legacyRootAliases` 数据） | `electron/markdownExport.ts`、`src/renderer/components/Chat/ChatMarkdown.tsx`、新增扫描测试 | ①扫描测试绿；②**红绿**：临时插入字面量 → 转红；③`DetailPanelFileList` 确认改用词汇常量过滤（v3-F3） | T0.1 | GREEN |
| **T3.2** | 文档升位：`llm-wiki-requirement.md` → v1.7 增补「集中共享存储」章节；`wiki-import-ingest-requirement.md` 更新 ingest 目标路径；本方案状态同步 | `docs/requirement/*` | 文档间交叉引用一致、无互相矛盾表述 | — | GREEN |
| **T3.3** | 全量终验 | — | ①`npm test` 全量绿；②`npm run build` 绿；③`manual` M6（打包模式 userData / `-dev` 隔离）+ §15.2 清单逐项勾选；④最终提交 | 全部 | GREEN |

---

## 5. 测试矩阵（需求 §15.1 ↔ 任务映射）

| 需求测试项 | 覆盖任务 | 测试文件（约定） |
|-----------|----------|------------------|
| wikiMount 八规则 | T0.5 | `electron/wiki/wikiMount.test.ts` |
| 三层一致性（fact=permit=落盘） | T1.1 + T1.6 + T1.7/T1.8（各测一层，联合断言在 T1.19 冒烟；v3-N4 编号修正） | `writePathFacts.test.ts` / `writeExecutionPermit.test.ts` / `builtinExecutors.*.test.ts` |
| 敏感 zone 豁免（含祖先级前缀） | T1.3 | `readPathFacts.test.ts`、`shellSensitivePaths.test.ts` |
| 分级映射矩阵（写 × desktop/feishu/wechat；读 × 四 lane） | T1.3 + T1.4 + T1.9 | `toolCallGate.wikiTiers.test.ts`（新增） |
| 远程边界回归（写四象限 + 读三 lane + 发文件） | T1.9 + T1.10 + T1.15 | `builtinExecutors.remoteWiki.test.ts`（新增） |
| defaultRules 零改动契约 | T1.5 | `defaultRules.contract.test.ts` |
| grep 双根 + 去重 | T1.11a–c | `grepScope.test.ts`、`grepChatSignal.test.ts` 扩展 |
| fileIpc 子通道 / 虚拟条目 / watcher / 导出 | T1.15–T1.17 | `fileIpc.wikiMount.test.ts`（新增） |
| 互斥不变量（mulberry32 随机序列） | T0.6 | `wikiWriteMutex.test.ts` |
| 迁移全场景（含自定义根、extraLegacyRoots、幂等、归并） | T2.1–T2.3 | `wikiMigration.test.ts` |
| projectId / display_name 规则 | T1.12b | `wikiProjects.test.ts` |
| WikiPane 展示名数据源（v3-N2：`wiki:status.projects`） | T1.12a⑤ + T2.5 | `wikiStatus.test.ts` / `WikiPane.test.tsx` |
| ingest/迁移写入经互斥区（§9.4，v3-N3） | T1.12c③ + T2.2a⑦ | `wikiImport.test.ts` / `wikiMigration.test.ts` |
| 迁移状态持久化（§10.2，v2-C1） | T0.2 + T2.2a + T2.6 | `ipcShared.test.ts` / `wikiMigration.test.ts` / `WikiTab.test.tsx` |
| 失效广播 hint 词汇路径（§7.6，v2-C2） | T1.7 + T1.12c + T2.2a | 各自测试文件内断言（含「不含 userData 真实路径」反断言） |
| 命名不写断言（D9 白名单） | T3.1 | `wikiLiteralScan.test.ts`（新增） |
| wikiPaths 既有契约不回退 | 全程回归 | `electron/wiki/wiki.test.ts`（现有，零改动通过） |

---

## 6. 里程碑与发布

| 里程碑 | 内容 | 提交 | 发布 |
|--------|------|------|------|
| **MS1** | P0 全绿（行为不变） | 提交点 1 | 可独立发 |
| **MS2** | P1+P2 全绿 + 真机走查 | 提交点 2（**同一版本**） | 正式版：共享库生效 + 迁移向导 |
| **MS3** | P3 全量终验 | 提交点 3 | 可滞后一版 |

## 7. 风险与预案

| 风险 | 触发信号 | 预案 |
|------|----------|------|
| T1.11 grep 双根编排改动面超预期（rg/walk/回填三消费点） | T1.11b 单测发现口径合并复杂度超 2 天 | 先落 `path=` 挂载（T1.11a）+ 无 path 暂限 workDir 单根并在技能/文档注明，双根编排拆到同版本后续提交（不跨版本） |
| 探测层改动引起既有审批回归 | T1.1 ②「现状逐字节一致」失败 | 逐用例二分定位；mountAnchors 缺省路径保证零行为差异是硬门槛，未达不进 T1.3 |
| 迁移冲突策略与用户预期不符 | M4 走查反馈 | 冲突双保留策略可配置化留作后续；首版以报告透明化缓解 |
| 远程 lane 真机行为与单测环境差异 | M3 失败 | 以 `diagnostic.caseId` 日志回溯探测层锚点是否生效（`wechat-media-target-outside-workdir` vs wiki 路径） |
