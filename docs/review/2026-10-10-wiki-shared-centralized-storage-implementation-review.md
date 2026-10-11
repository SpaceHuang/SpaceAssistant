# Wiki 集中共享存储 — 实现评审报告（worktree feat/wiki-shared-centralized-storage）

**日期：** 2026-10-10
**评审对象：** `.worktrees/wiki-shared-storage` 分支 `feat/wiki-shared-centralized-storage`（基线 `ed3dac54` 之上 3 个提交：`5c7e7a8a` P0+P1 挂载层 / `7e51b105` P2 迁移与 UI / `0678e04d` P3 字面量收口；84 文件，+6152/-223）
**需求基线：** `docs/requirement/wiki-shared-centralized-storage-requirement.md` v1.12
**评审方式：** 5 路并行分区评审（挂载与路径安全 / Wiki 模块与迁移 / IPC 与执行层 / 渲染层与 i18n / 需求符合性）+ 主评审员对全部阻断项逐条代码实证（含哈希计算与调用链核对）
**结论：存在 8 项阻断（Blocker），当前形态不可合并、不可发布（违反 §16-B5 硬约束）。**

---

## 一、阻断问题（Blocker）

### BLK-1 迁移向导全应用不可达：`wiki:status` 恒返回 `pendingLegacyMigration: false`

- **证据：**
  - `electron/wiki/wikiStatus.ts:63-64`：`pendingLegacyMigration: false, legacyRoots: []` 硬编码；`getWikiStatus` 不做检测。
  - `electron/ipc/agentProtocolIpc.ts:1324-1327`：`wiki:status` handler 直接返回 `getWikiStatus(...)`，检测只存在于 `wiki:migration-status`（:1358-1373）。
  - `src/renderer/components/WikiPane/WikiPane.tsx:55-59`：提示条/向导门控读的是 `window.api.wikiStatus()` 的 `pendingLegacyMigration` → 恒假；全渲染层唯一的 `wikiMigrateLegacy` 调用（WikiPane.tsx:110）因此永远触达不到。
  - `src/renderer/components/Config/WikiTab.tsx:60,136`：设置页弹窗虽调对了 `wikiMigrationStatus()`，但 `footer: null` 且**没有执行迁移的按钮**。
- **违反：** §10.1（`wiki:status` 契约）、§11①（提示条→向导）、§12.1（打开 WikiPane 时检测）、§16-B5（禁止「写入已切共享库、旧数据原地保留但无迁移入口」的版本形态——当前正是该形态）。
- **修法：** `getWikiStatus` 注入轻量检测（或 WikiPane 数据源切到 `wikiMigrationStatus()`），WikiTab 迁移弹窗补「立即迁移」按钮；补一条「检测命中 → 横幅出现 → 向导可执行」的端到端断言。

### BLK-2 SCHEMA 哈希分叉基准错误：「默认模板 → 替换新版」分支对真实数据永不命中

- **证据：**
  - `electron/wiki/wikiMigration.ts:20`：`LEGACY_DEFAULT_SCHEMA_MD_V1` 只是基线模板的**前两行截断**（注释却声称「v1（ed3dac54）默认 SCHEMA 模板全文」）。
  - 实证计算：基线 `ed3dac54:electron/wiki/wikiTemplates.ts` 的 `DEFAULT_SCHEMA_MD` 运行时全文（882 字符）sha256 = **LF `7caddb2e…` / CRLF `b2638fbd…`**；代码中哈希集合（wikiMigration.ts:207-211）为 stub 哈希 `d84635ae…` 与硬编码 `5a4c6999…`——**两个都不匹配**。
  - 连带缺陷：「已修改」分支（:219-223）只写 `SCHEMA.legacy-<pid>.md` 且**不补写共享库新版模板**（哈希分支才有 `mkdir+write`）；若共享库未初始化，`SCHEMA.md` 缺失 → `isWikiInitialized` 返回 false、SCHEMA 注入返回 null。
- **后果：** 全部未改过 SCHEMA 的老用户被误判「已修改」，生成无端 legacy 副本；极端顺序下共享库缺 SCHEMA。测试 fixture（wikiMigration.test.ts:252）用同一个错误 stub，自洽通过但失真。
- **违反：** §12.2 SCHEMA 行（哈希三分支语义）。
- **修法：** 基准改为真实 v1 模板全文的 LF+CRLF 双哈希；「已修改」分支补 `if (!existsSync(sharedSchema)) write(newSchemaContent)`（含 mkdir）；fixture 换完整模板。

### BLK-3 存量自定义 `rootPath` 被检测但永不进入迁移执行管线

- **证据：**
  - 检测侧：`detectLegacyWikiRoots` 双扫默认根 + 存量 `wikiConfig.rootPath`（wikiMigration.ts:48-49），`wiki:migration-status` 也传了 rootPath（agentProtocolIpc.ts:1363），向导 UI 还以 Tag 展示它。
  - 执行侧：`migrateLegacyWikis` 的 targets 只有 `profiles × DEFAULT_WIKI_ROOT_DIRNAME + extraLegacyRoots`（wikiMigration.ts:276-279）；IPC handler（agentProtocolIpc.ts:1392-1408）**只透传 payload.extraLegacyRoots，不把存量 rootPath 并入**；渲染层（WikiPane.tsx:104-110）也只回传用户手输的 extraRoots。
- **后果：** 改过根目录名的用户看到「检测到 N 个本地 Wiki（含自定义根）」→ 点迁移 → 自定义根原地保留、别名不注册、`pendingLegacyMigration` 恒 true、历史链接打开通道断裂。US-3/US-5 对该类用户破产。
- **违反：** §12.1/§12.2「自定义根与默认根同等对待」；§15.1 迁移用例缺「存量配置 rootPath 自动纳入管线」。
- **修法：** `wiki:migrate-legacy` 在 `wikiConfig.rootPath !== DEFAULT_WIKI_ROOT_DIRNAME` 时自动追加 `{workDir, rootDirName: rootPath}` 候选并注册别名；补用例。

### BLK-4 受控改名（`wiki:rename-root`）后词汇分类与渲染全链路失效（D9/§6.3 系统性违反）

`rootPath` 语义已改为「userData 下物理目录名，可改名」，词汇前缀固定 `llm-wiki`；但大量代码仍把 `rootPath` 当**词汇根**用：

- **主进程分类器：** `electron/wiki/wikiPaths.ts:29-32` `classifyWikiPath` / :12-22 `resolveWikiRelPath` 以 `wikiConfig.rootPath` 做大小写敏感前缀比较 → 改名后 `llm-wiki/raw/**` 分类为 `'other'`，`wiki-raw-write-deny` 信号（toolCallGate.ts:68-76）**全 lane 失效**，`wiki:resolve-path`（agentProtocolIpc.ts:1345,1350）恒返回 `kind='other'`。
- **渲染层：** WikiPane.tsx:35 `wikiRoot = wiki.rootPath`（FileTree 根变成不存在的 `{workDir}/my-lib`）；ChatView.tsx:895,1077 / FileOverlay.tsx:42 / FileContentView.tsx:50 / ReferencedFilesPanel.tsx:22 链接识别基准同上（改名后历史 `llm-wiki/...` 链接不再识别，US-5 破）；DetailPanelFileList.tsx:20,30 `hideWikiFromFileTree` 过滤基准同上；WikiTab.tsx:65「打开共享库目录」把 rootPath 传给只按词汇挂载的 `file:show-in-explorer`（WikiTab.test.tsx:132-144 还把错误行为固化为断言）。
- **fileIpc：** `electron/ipc/fileIpc.ts:44-46` `excludedRootNames` 用 `rootPath` 而非 `WIKI_VOCABULARY_PREFIX` → 改名后 workDir 残留 `llm-wiki` 实体目录不再排除（§7.7 S2 破），且与 grep 侧排除集（恒含词汇常量，builtinExecutors.ts:1884）口径相反。
- **迁移持久化不重置 rootPath**（wikiMigration.ts:257）：存量自定义根用户迁移后 rootPath 永久停留旧值，渲染词汇与 Agent 实际使用的 `llm-wiki/...` 永久错位。
- **违反：** §6.3、§7.5「WikiPane 主体词汇零改动 / 前缀识别链路不变」、D9「对 Agent 与历史完全透明」、§10.1「判定逻辑不变」。
- **修法：** 一切词汇判定/排除/展示前缀统一改 `WIKI_VOCABULARY_PREFIX`（`rootPath` 仅用于 realBase 物理派生与展示）；迁移完成后把旧 rootPath 转入 `legacyRootAliases` 并将配置重置为默认值；补「改名后读写矩阵 + 渲染链路」断言。

### BLK-5 大小写变体绕过 locked deny `wiki-raw-write-deny`

- **证据：**
  - `electron/wiki/wikiMount.ts:51-55` `hasPathPrefix` 双侧 `toLowerCase()`（大小写不敏感）；`buildMounted`（:116-128）按前缀长度切片，**`vocabularyPath` 保留入参原始大小写**。
  - `electron/confirmation/toolCallGate.ts:68-76` `isWikiRawSignalTarget` 把该 `vocabularyPath` 交给 `classifyWikiPath`，而后者（wikiPaths.ts:30-32）是**大小写敏感**比较。
  - 链路：`write_file('LLM-WIKI/raw/evil.md')` → 挂载命中（realRel 恒 `raw/evil.md`，Windows/macOS 大小写不敏感 FS 上写入真实 `raw/`；`llm-wiki/RAW/x` 形态同）→ 分类器返回 `'other'` → raw deny 信号不触发 → `writeFileAutoApproval.ts:87-89` 只查 zone/targetKind（挂载后 zone=`workdir-normal`）→ **桌面 lane 快通道免确认直写共享库 `raw/`**。执行层一致性守卫（builtinExecutors.ts:796-803）只校验 readOnly 与 realBase 包含，不兜 raw。
- **违反：** §9.1 locked deny、§14「raw 只读性不变」、§15.1 远程边界回归「raw 写（deny）」。
- **修法：** `buildMounted` 把 `vocabularyPath` 前缀段改写为命中的规范前缀（单点收口，下游大小写敏感消费者同步痊愈），或 `classifyWikiPath` 改大小写不敏感；补 `LLM-WIKI/raw/x`、`llm-wiki/RAW/x` → deny 用例。

### BLK-6 `file:watch-content` 挂载后广播 scope 错配，wiki 文件「变更→刷新」链路断裂

- **证据：**
  - `electron/ipc/fileIpc.ts:114-117`：挂载命中时 `startContentWatch(mounted.realBase, mounted.realRel)`；
  - `electron/fileContentWatcher.ts:18-23`：内部以该 rel 既做 `resolveSafePath` 又做 `broadcastScopeInvalidation(\`file:${relPath}\`)` → wiki 页 `llm-wiki/wiki/index.md` 的广播 scope 变成 `file:wiki/index.md`；
  - 渲染端 `DetailPanelContext.tsx:495,512` 以词汇路径过滤（`event.relPath !== currentFile`）→ 永不命中；更上游 `fileContentSyncBus.ts:59-66` 的 `settlePath` 用 `wiki/index.md` 调 `file:get-metadata` → 不挂载 → ENOENT → 事件直接丢弃（第二处断点）。
  - `fileIpc.wikiMount.test.ts:144-151` 把错误行为（`toHaveBeenCalledWith(realBase, 'wiki/index.md')`）固化成了预期。
- **违反：** §7.4「watch-content 不回退」、§15.1「watch-content wiki 文件监听生效」。
- **修法：** `startContentWatch` 增加第三参 `broadcastRel`（广播/状态键用调用方原始词汇路径）；补「广播 scope === 词汇路径」端到端断言。

### BLK-7 `file:list-directory` 根列表把共享根子条目平铺进根，且 path 基准错误产生含 `..` 的破碎路径

- **证据：** `electron/ipc/fileIpc.ts:53-54`：`listDirectoryEntries(ctx, sharedRoot, root)` 第三参（条目 path 的相对基准）误传 `root`（workDir）→ `e.path = path.relative(workDir, userData条目)` = `../../.../llm-wiki/wiki`；再经 `normalizeRelPathInput(\`llm-wiki/${e.path}\`)`（不解析点段）产出 `llm-wiki/../../...` 破碎路径。平铺行为本身也超出 §7.4-I1「仅合成虚拟条目」：`wiki/`、`raw/`、`SCHEMA.md` 同时以根级行和虚拟目录子节点两形态出现，点击后经挂载解析点段相消不命中前缀、`resolveSafePath` 抛「路径超出」——纯废行。触发条件：`hideWikiFromFileTree=false` 且共享根已存在。
- **修法：** 删除 `sharedRootEntries` 平铺（回归「仅虚拟条目」），或至少把基准改回 `sharedRoot`；补「根列表不得出现含 `..` 的 path、共享根子条目不出现」断言。

### BLK-8 `list_directory` 工具在挂载目标下输出 `../..` 相对化真实路径（泄漏 + 不可用）

- **证据：** `electron/tools/builtinExecutors.ts:610-612`：条目 path 恒为 `path.relative(path.resolve(ctx.workDir), entryPath)`；挂载命中时 target 在 userData 下 → 输出 `../../AppData/Roaming/.../llm-wiki/wiki/index.md` 形态。① 违反 §7.3/§14「真实 userData 路径不出进程边界」（直接进了 LLM 上下文与持久化消息）；② Agent 拿到该路径回喂任何工具都会被 `resolveSafePath` 越界拒绝——wiki 目录遍历结果不可用。grep 侧本需求专门做了 `rewriteMountedGrepOutput`（:1933-1941），list_directory 没有对应改写；`builtinExecutors.wikiRead.test.ts:112-120` 只断言 name 未断言 path 形态。
- **修法：** 挂载 permit（`targets[0].vocabularyPath` 存在）时条目 path 以 vocabularyPath 为基准拼接；补 path 断言（不得含 `..`、不得含 userData 片段）。

### BLK-9（数据丢失面）`file:delete`/`file:rename` 对挂载根本身无防护，UI 写通道不拒绝只读别名

- **证据：** `electron/ipc/fileIpc.ts:301-310`：`file:delete('llm-wiki')`（realRel 为空 → target=realBase）→ `fs.rm(realBase, {recursive:true, force:true})` **递归删除整个共享知识库**；`file:rename('llm-wiki', 'x')`（:312-324）会把 `{userData}/llm-wiki` 改名，与配置 rootPath 脱节。且全部写通道（create-file/create-directory/delete/rename/move/copy，:284-374）**均未检查 `mounted.readOnly`**——旧自定义根只读别名经聊天链接/文件面板可触达删除/改名/移动，§9.3「只读别名写显式拒绝」只在 Agent 执行层落实。
- **修法：** `mounted && !mounted.realRel` 时拒绝 delete/rename；写通道统一 `if (mounted?.readOnly) throw 引导文案`。

---

## 二、非阻断问题

### P1（应修，不阻断合并评审但应在发布前修）

1. **探测层锚点不支持 realBase 绝对形态反向命中**（v4-C2 只落实了信号半边）：`electron/confirmation/extractors/mountAnchors.ts:49-52` 对绝对入参只 `path.relative(workDir, …)`，userData 绝对路径永不命中锚点 → fact 无 `vocabularyPath`、审批卡片露出真实 userData 路径（§7.3 破）、zone 漂移为 `outside-workdir`（远程 lane 绝对形态写 wiki 页被误拒）。修法：`matchMountAnchor` 增加对 `anchor.base` 的绝对前缀反解分支。
2. **多段 `legacyRootAliases` 时探测层与挂载层目标不一致**：`toolCallGate.ts:59` 用 `vocabularyPath.split('/')[0]` 推导锚点前缀，别名 `docs/wiki` 时退化为 `docs`，与 `resolveWikiMount` 的 realRel 不一致（违反 §7 三层一致性）。修法：`WikiMountResolution` 带出 `matchedPrefix` 供锚点直接消费。
3. **迁移管线 mkdir 缺口**：`mergeIndexFiles`/`mergeLogFiles` 调用处（wikiMigration.ts:325-336）与 `migrateSchemaFile` 修改分支（:222）不建父目录；共享库未初始化且旧根极简时 ENOENT → 该 profile 整体 `failed`。
4. **`rawCount` 统计失真**：wikiStatus.ts:24-30 只数 `raw/` 顶层文件，共享结构为 `raw/<projectId>/` → 恒 0（§10.1 状态字段失真）。
5. **`mergeLogFiles` 丢弃 preamble**（wikiMigration.ts:172-201）：首个 `## [` 之前的行被吞，共享库默认模板头在首次归并后被重写为 `'\n'`。
6. **嵌套 `index.md`/`log.md` 静默丢失**（wikiMigration.ts:116）：任意深度跳过，但只有顶层两个文件被归并；嵌套同名文件不进共享库、报告无记录。
7. **ingest 重名竞态**（wikiImport.ts:152-161）：`resolveAvailableRawPath` 存在性检查在互斥区外，并发同名 ingest 后写覆盖先写——「选名+拷贝」应整体放入互斥区。
8. **`display_name` 被 ingest 登记覆盖**：wikiProjectStore.ts:53-56 ON CONFLICT 无条件覆盖 + wikiImport.ts:145 裸 workDir 登记 → 首次 ingest 后 §6.2 规则 1 的 profile 名退化为 basename。
9. **R1 覆盖陷阱：init 路径不清理项目级技能副本**：`initWikiStructure`（wikiInit.ts:90-161）未调 `removeProjectWikiSkillCopy`，仅迁移调（wikiMigration.ts:343）；选「暂不迁移」的用户 init 后旧项目副本仍压过用户级新版（§8.1-3）。
10. **§12.3-2「该文件已合并至…」提示未接线**：`resolveMigratedLink`（wikiMigrationUi.ts:8）只有测试消费，无生产调用方；read-file 失败路径不查 `report.renames`。
11. **§13 orphan 边界未落实**：`markWikiProjectOrphan` 无生产调用方（profile 删除链路未置 `orphan=1`）。
12. **export-markdown 挂载分支图片解析根收窄**（fileIpc.ts:193-195）：沙箱根从 workDir 换成 `path.dirname(source)`，wiki 页引用共享根内其他目录图片（`../assets/x.png`）被拒——相对现状的回退；建议用 `exportMounted.realBase`。
13. **§15.1 读矩阵缺 lane**：读分档矩阵要求 × {desktop, wechat, feishu, automation}，现仅 desktop+automation 有用例（toolCallGate.wikiMount.test.ts:139-227）。
14. **WikiPane 向导开关逻辑缺陷**（被 BLK-1 掩盖，修复后必现）：`open={pendingMigration !== null && migrationReport === null}`（:191）导致检测命中即自动弹窗；横幅「迁移」按钮 `setMigrationReport(null)` 是 no-op；向导取消把 `pendingMigration` 置 null 连横幅一起关掉。应加独立 `wizardOpen` state。
15. **WikiPane.tsx:156 硬编码英文 ` (orphan)`**，违反 i18n 禁令。
16. **WikiTab `rootPathLabel` 文案过时**（「相对工作目录」与 §6.3 新语义矛盾）；新增的 `rootPathHelp` 双语 key 在组件中无消费方；「存量自定义根未迁移时先展示迁移引导而非直接改名」（§11）未实现（`startRename` 无 pendingLegacyMigration 门禁）。

### P2（建议）

1. 迁移时间戳格式 `toISOString().replace(/[-:T]/g,'').slice(0,15)` 产出 `YYYYMMDDHHmmss.`（14 位+毫秒小数点、尾随 `.`），不符合 §12.2 `{YYYYMMDD-HHmmss}`，且 Windows 上依赖 OS 剥离尾随点行为（wikiMigration.ts:228）。
2. `wiki:rename-root` 持久化未 trim 的 `payload.newRootPath`（agentProtocolIpc.ts:1387），与 `renameWikiRoot` 内部 trim 后值不一致。
3. 迁移从不持久化 `'running'` 状态，§13「中断→报告标注上次未完成」无法实现；per-profile failed 时总体仍写 `'completed'`（wikiMigration.ts:371）。
4. `extraLegacyRoots` 的 `rootDirName` 无单段/越界校验（`../x` 可让迁移源逃出 workDir；渲染端受信，仅加固建议）；`mergeWikiConfig`/`resolveWikiMount` 对 `rootPath` 亦无 `..`/绝对形态校验，DB 直写可令 realBase 逃逸 userData。
5. WikiTab 保存设置整包回写 `payload.wiki`（configIpc.ts:365-377），渲染端副本陈旧时可覆盖迁移刚写入的 `migration`/`legacyRootAliases`。
6. `initWikiStructure` 返回的 `rootRel` 无默认值回退（wikiInit.ts:106/156）；`detectLegacyWikiRoots` 的 `sharedRootInitialized` 入参未使用（死参数）。
7. 双根合并注释与实际不符（builtinExecutors.ts:1966 称「子执行传 headLimit=∞」，实际仍按原 head_limit 截断且截断标注行占合并层名额）；合并结果 `searchScope` 只取 workDir 根。
8. grep 排除 glob `!**/<name>/**` 任意深度生效（grepScope.ts:149-152），误排 workDir 深处同名目录（如 `packages/llm-wiki/`），超出 §7.7 根级语义；fileIpc 排除名精确比较（Windows 上 `LLM-WIKI` 实体目录不被排除）与 grep `--iglob` 大小写口径不一致。
9. `wiki:resolve-path` 主进程已返回 `readOnly`（agentProtocolIpc.ts:1346）但 `src/shared/api.ts:539-541` 返回类型未加该字段。
10. `file:move` 跨边界拒绝文案为硬编码中文（fileIpc.ts:333），未走 errorCodes + errors 命名空间模式。
11. `wiki:rename-root` 广播在配置持久化之前触发且 `relPaths: []`；建议 rename 成功→持久化→再广播词汇根路径。
12. 横幅/向导 `count` 语义错误：`legacyRoots` 是去重目录名集合，文案说「{{count}} 个项目」（wiki.json:18,21）。
13. `extraRootsInput` 只作用于当前 workDir（WikiPane.tsx:109），S3 要求「逐 profile 或全局」。
14. 报告弹窗不展示改名映射表（§12.3-1）、不展示 per-profile failed/error；部分失败时标题仍写「迁移完成」；向导用手写 `<input>` 而非 antd `Input`。
15. 读侧执行层缺少写侧那样的二次挂载一致性比对（readPermitExecutor.ts 无 wikiMount 引用），rootPath 漂移时读侧无 fail-closed 守卫（写侧有，不对称）。
16. `wikiSchemaRelPath`/`wikiIndexRelPath`（wikiPaths.ts:40-48）仍拼 `${rootPath}/...` 词汇，改名后产出不可挂载词汇（当前仅测试引用，latent）。
17. `file:export-pdf`（fileIpc.ts:240-282）未接挂载（当前 preload 未暴露属死通道，仅记录）。
18. `resolveWikiMount` 不 trim 入参而 `matchMountAnchor` trim（wikiMount.ts:64 vs mountAnchors.ts:45），口径细微差异。

---

## 三、已验证无问题的关键点（抽查确认）

- **wikiMount 单点解析（§7.1）**：八条规则与文档逐条一致且纯函数；`..` 逃逸（相对/绝对/规则 2 后缀三条路径）fail-closed、`llm-wiki-evil` 段边界不命中、UNC/盘符守卫、别名 readOnly、disabled 恒不挂载；测试覆盖完整。
- **B7 读侧敏感 zone 豁免**：落点在共享分类器 `classifyReadPathZone`（readPathFacts.ts:78-104），豁免优先短路祖先级前缀（含 win32 `AppData\Roaming` 用例），豁免未传时行为零变化有对照；automation 读 userData 其他路径仍 deny。
- **写路径三层一致性**：探测锚点 → scopeBase 分类 → permit 双字段（vocabularyPath+identity）→ 执行层 fail-closed 二次比对（漂移/别名写均拒）；审批卡片与审计信号展示词汇路径，广播/结果不含真实 userData 路径（有断言）。
- **defaultRules 零改动契约**：快照测试锁定 70 条规则 id 全集 + 六条关键 locked 规则（defaultRules.contract.test.ts）。
- **wikiWriteMutex（§9.4）**：FIFO 串行、失败传播不堵队列；mulberry32 固定种子随机序列 + 不变量断言（符合 AGENTS.md 不变量纪律）。
- **grep 双根编排**：递归抑制（WeakSet）、S2 去重双侧落实、wiki 结果改写回词汇路径、单根失败降级、合成 permit digest 一致。
- **远程 lane 写路径**：写 wiki 页经 scopeBase 断言通过、workDir 外写拒、别名写拒+引导文案、微信发文件走既有 `remote-wechat-media-outside-deny`（规则零改动，§7.2 v4-C3 微信 media 探测接入落实）。
- **迁移主干**：raw→`raw/<projectId>/` 幂等跳过、冲突双保留 `<name>.from-<projectId>.md` + 双向提示行、index 追加归并、log 时间戳归并 + `[project:<id>]` 前缀去重、旧目录 `.migrated-{ts}` 改名保留不删除、符号链接条目天然跳过（拷入侧无 symlink 逃逸面）。
- **DB 迁移**：`wiki_projects` 表 v83 经 `runInTransaction`、fresh DB 链式执行建表、PK/UNIQUE/幂等有测试；projectId=workDir 哈希（realpath+win32 小写）、display_name 取名/重名消歧有测试。
- **D9 字面量收口**：`'llm-wiki'` 归一到 `src/shared/wikiConstants.ts` 单点，wikiLiteralScan.test.ts 扫描守护（含白名单），markdownExport/skillManager/wikiCommandService/ChatMarkdown/markdownLinkResolve 均改引常量；config.wiki 键归一 `CONFIG_KEYS.wiki`。
- **fileIpc 通道接入完整性**：对照 preload 全部 `file:*` 通道逐一核对无遗漏；move 跨边界显式拒绝、copy 跨边界两段式符合 §7.4。
- **i18n**：zh-CN/en-US 新 key 对齐、`npm run i18n:check` 通过（除上述 ` (orphan)` 一处硬编码）。

## 四、验证执行记录

| 项 | 结果 |
|----|------|
| `npm run typecheck:renderer` | ✅ 通过 |
| `npm run i18n:check` | ✅ 通过 |
| `npm run build:electron:incremental` | ✅ 通过（EXIT=0） |
| wiki 相关 electron 定向测试（wiki/\*\*、fileIpc.wikiMount、ipcShared.wikiConfig、builtinExecutors.wikiRead/wikiWrite、grepWikiDualRoot、readPathFacts/writePathFacts.wikiMount、toolCallGate.wikiMount、migrations.wikiProjects） | ✅ 19 文件 122 用例全绿（141s） |
| 渲染层定向测试（WikiTab、wikiMigrationUi、wikiConstants、markdownLinkResolve、WikiPane，5 文件 27 用例，分区评审实跑） | ✅ 全绿 |
| SCHEMA 哈希实证（git show 基线模板 + sha256 计算） | 代码基准与真实模板不匹配（BLK-2 坐实） |

> 注意：现有测试全绿不等于无阻断——BLK-1/2/3/6/7 的缺口均在现有断言盲区（fixture 自洽但失真、负面断言空白、测试把错误行为固化为预期）。修复时必须同步补红绿验证用例。

## 五、修复优先级建议

1. **第一批（正确性/安全，阻断合并）**：BLK-5（大小写收口）、BLK-4（词汇常量收口，与 BLK-5 同根因可一并修）、BLK-9（delete/rename 根防护 + 只读别名拒绝）、BLK-7/BLK-8（list 输出修复）。
2. **第二批（迁移链路闭环，阻断发布 §16-B5）**：BLK-1（检测并入 wiki:status + WikiTab 执行按钮）、BLK-2（哈希基准）、BLK-3（自定义根入管线）、BLK-6（watch 广播 scope）。
3. **第三批**：P1 全量（重点 1/2/3/7/9/10/11/14）；P2 择要。
4. 每批收尾跑定向测试 + `test:related`，全量 `npm test` 仅在最终验收。
