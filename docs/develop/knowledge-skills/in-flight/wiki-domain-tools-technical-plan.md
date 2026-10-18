# Wiki 专属能力接口技术方案

> 状态：技术方案修订稿（D-TP-01 至 D-TP-05 已决定；D-06 界面归属已批准；未实施）
> 需求真源：[Wiki 专属能力接口需求](../../../requirement/knowledge-skills/in-flight/wiki-domain-tools-requirement.md)
> 核对基线：当前工作区 HEAD 28dd3223（2026-10-17）；需求稿事实基线为 main 7c0edc41（2026-10-17）
> 适用范围：主进程 Wiki 服务、Agent 工具注册与授权、通用文件工具旁路封锁、兼容迁移及页面历史恢复

## 第 0 层：已批准决策摘要【人必读】

**一句话：** 让 Agent 通过稳定的 Wiki 操作使用共享知识库；页面、SCHEMA、来源的版本协调和索引/日志生成由主进程服务承担。

**决策状态：** 以下五项技术选择和历史交互归属均已由负责人决定，不需要再次审批。实现前只复核代码事实与安全写入接口；复核不改变已批准的产品边界。

| ID | 已批准的选择 | 边界 |
| --- | --- | --- |
| D-TP-01 | Wiki 能力通过按需发现入口 `memory` 暴露；Wiki 操作命名为 `memory.wiki_*` | 预留 memory 命名空间；schema 按需加载 |
| D-TP-02 | SCHEMA 使用固定标记包围的 JSON 分类区块 | 动态 categoryId 由 SCHEMA 提供，分类规则仍可用自然语言描述 |
| D-TP-03 | 复用现有集中 Wiki 根和文件存储机制 | 本期不换根、不换文件存储、不引入数据库；必要服务文件位于同一 Wiki 根的 `.wiki-service/` |
| D-TP-04 | 页面、SCHEMA、raw 历史不自动过期 | 本期不自动清理历史 |
| D-TP-05 | 文件写入复用项目现有 Wiki 写入安全逻辑 | 使用现有 mutex、identity 检查和 `safeAtomicWrite`；不另造并发提交协议 |
| D-06 | 历史版本在当前聊天查看和恢复 | 复用现有工具确认体验，不增加 Wiki 面板入口 |

上述裁决来源于需求决策 D-01 至 D-06 及负责人后续明确的 D-TP-01 至 D-TP-05 选择。逐项需求来源见需求稿；技术规格和执行任务必须服从此表。

### 决策的技术落点

- `memory` 入口只发现工具；Agent 按需取得完整 `memory.wiki_*` schema。详见 §1.2、§2.4。
- JSON 分类区块及其版本校验见 §2.3。
- 页面、来源、SCHEMA 快照、journal、状态和迁移 manifest 的具体文件布局见 §2.5、§2.6、§2.9。
- 历史不自动过期；快照与迁移备份均不自动删除。详见 §2.5、§2.9。
- 文件写入复用现有 mutex、identity 检查及安全原子写入；该应用内逻辑不限制旧版本二进制或外部编辑器。详见 §2.6、§2.9。
- D-06 当前聊天的历史查看与恢复入口已经批准；确认界面沿用现有体验，不增加 Wiki 面板控件。

## 第 1 层：概要【人机共读】

### 1.1 方案结论

在主进程新增 Wiki 领域服务，Agent 工具执行器只接收领域 ID 和版本号，不接收页面目标路径。服务内部调用现有 Wiki 挂载、pathSecurity、项目溯源、安全文件写入和确认能力。页面 Markdown、SCHEMA、raw、历史快照和服务记录都使用现有集中 Wiki 根下的文件存储；索引与日志成为服务生成的兼容视图。不新增 Wiki 数据库或另一个数据根。

页面文件含保留的机器元数据注释，标明 pageId、categoryId、summary、parentPageId 和 sourceRefs；页面正文仍是 Markdown。版本快照、操作 journal 和生命周期状态以文件方式保存在同一 Wiki 根的服务保留区；具体模型见 §2.5，不使用数据库。

Wiki 文件仍能被用户从文件管理器或外部编辑器修改。相关工具在返回结果前扫描对应对象并协调文件变化。search 扫描完整活动页面集合；open/save/restore 扫描目标页面；Schema 工具扫描 SCHEMA；来源读取扫描目标来源。首版不运行后台 watcher。

### 1.2 架构边界

| 层 | 责任 | 不持有的责任 |
| --- | --- | --- |
| 模型与 Skill | 理解请求、选择 categoryId、归纳内容、选择来源与页面、解释冲突 | 文件目录枚举、raw 路径读取、索引/日志编辑 |
| Agent 工具注册 | 独立 Wiki schema、轻量索引、按需发现、运行时授权集合 | 直接访问 Wiki 文件系统 |
| Wiki 工具执行器 | 校验参数形状、取得可信 invocation context、调用领域服务 | 根据 projectId 授权、信任模型提供的确认状态 |
| Wiki 领域服务 | Schema、页面、来源、树、版本、事件、派生视图、迁移和恢复 | 决定 lane 是否有权；绕过 Policy Engine |
| 策略与确认 | facts、策略决策、确认、审计、permit、final-check | 从未经批准的模型字段推断用户授权 |
| 文件存储层 | Markdown 页面、SCHEMA、raw、服务保留区中的历史/操作状态文件、安全文件提交 | 将内部物理路径返回给 Agent；创建独立数据库 |

目标调用链：`memory` 按需发现入口 → 完整 `memory.wiki_*` 工具 schema → facts/Policy Engine → 现有确认流程（需要时）→ permit final-check → Wiki executor → Wiki service → 现有 Wiki 根中的安全文件。

### 1.3 代码事实与核验命令

事实基线按当前工作区 HEAD 28dd3223 记录。下列命令用于实现开工时复核；如果路径或签名已变化，先更新本方案和执行计划。

| ID | 事实 | 复核命令 |
| --- | --- | --- |
| F-01 | 内置 LLM Wiki Skill 指示 Agent 通过通用文件工具读写页面、index.md 和 log.md。 | rg -n 'write_file|read_file|index.md|log.md' electron/skills/bundled/llmWikiSkill.ts electron/wiki/wikiTemplates.ts |
| F-02 | Wiki 虚拟根由 resolveWikiMount 映射；文件 IPC 为用户文件面板提供共享根目录读写能力。 | rg -n 'resolveWikiMount|wikiMountOf|file:read-file|file:write-file|file:list-directory' electron/wiki/wikiMount.ts electron/ipc/fileIpc.ts |
| F-03 | raw 导入已使用 resolveSafePath、共享根和 wikiWriteMutex，并登记来源项目。 | rg -n 'resolveSafePath|withWikiWriteMutex|registerWikiProject|importRawToSharedRoot' electron/wiki/wikiImport.ts |
| F-04 | tool_search 当前只查 MCP snapshot；toolkit.find 是产品能力发现入口。 | rg -n 'mcpToolSnapshot|toolkit.find|tool_search' electron/tools/toolSearchTool.ts src/shared/builtinToolDefinitions.ts |
| F-05 | 内置工具执行上下文携带 requestId、toolUseId、lane、用户确认事实和策略 permit，可用于服务端幂等键与 final-check 绑定。 | rg -n 'requestId: string|toolUseId: string|lane\\?|toolUserConfirmed|writeExecutionPermit' electron/tools/types.ts |
| F-06 | 当前默认锁定 Wiki raw 写拒绝；未见覆盖页面读写/grep/list 的统一 domain-only 规则。 | rg -n 'wiki-raw-write-deny|wiki-' src/shared/policy/defaultRules.ts |
| F-07 | Wiki 当前使用共享根内的文件存储；本方案不把 Wiki 历史或操作状态迁入业务数据库。 | 复核 `electron/wiki/wikiMount.ts`、`electron/wiki/wikiImport.ts` 及既有 Wiki 文件布局 |

本轮只做静态读取；没有运行测试、构建或真机流程。

## 第 2 层：规格【机｜人工可跳过】

### 2.1 不变量

| ID | 不变量 | 落地位置 | 验证证据 |
| --- | --- | --- | --- |
| INV-01 | Agent Wiki 工具参数、结果和错误不包含物理目标路径；导入只接受应用绑定的来源引用，不接受 Agent 自由路径。 | schema、executor、错误脱敏 | AC-01、AC-09、AC-11 边界测试 |
| INV-02 | Wiki 页面、Schema、raw 来源的授权只由 lane 与工具策略决定；projectId 只做来源标注。 | facts、Policy Engine、Wiki file service | AC-10、AC-18 同项目/跨项目对拍 |
| INV-03 | 每个已接受 pageId 只有一个当前 revision；revision 只递增，历史快照不可原地覆盖。 | Wiki 文件服务与不可变快照文件 | AC-05、AC-19、AC-23 |
| INV-04 | 页面正文、索引、操作日志的权威来源唯一：正文和 SCHEMA 文件、服务操作记录及页面元数据分别归属 Wiki service；index.md/log.md 只是可重建投影。 | file service、projection writer | AC-06、AC-07、AC-13、AC-22 |
| INV-05 | Schema/category 校验始终使用同一次读取确认的 schemaVersion 与文件 hash；失效基线拒绝提交。 | Schema coordinator、write final-check | AC-02、AC-03、AC-15、AC-20 |
| INV-06 | 页面更新基于 expectedRevision；restore 还基于 expectedCurrentRevision、targetRevision 和当前 Schema；不匹配时零页面写入。 | write service、permit final-check | AC-05、AC-19、AC-23 |
| INV-07 | 页面每次最多一个逻辑父级；同一类别与父级下标题唯一；页面写入、移动、恢复、SCHEMA 应用和外部协调都必须在同一 Wiki 域提交锁内读取同一份完整页面集与有效 SCHEMA，完成所有跨文件校验后才提交。所有当前版本会改变领域状态的操作按域锁→按规范化相对路径排序的文件锁顺序串行化；提交前复核校验读集的文件 identity/hash，外部编辑变化则拒绝并进入协调/冲突处理。域锁只串行化当前版本服务调用，不声称锁住旧版或外部编辑器。 | Wiki domain coordinator、page/schema validators | AC-04、AC-13、AC-17、AC-19、AC-20、AC-23、AC-26 |
| INV-08 | 授权和调用身份核验后，必须先用 requestId+toolUseId 查询持久化调用映射，再做 expectedRevision/schemaVersion/hash 等可变基线校验；同键异参拒绝，已完成调用回放原结果，未完成调用只恢复原操作，不新建 revision/event。 | Wiki 根服务保留区内的 operation journal 文件 | AC-07、AC-13 |
| INV-09 | Wiki 文件写入复用 `write_file`/`edit_file` 的既有安全写入语义：域提交锁先于文件级 Wiki mutex；同一操作持有域提交锁直到领域提交或恢复隔离完成；更新前核对读取状态并捕获目标 identity；`safeAtomicWrite` 在原子替换前复核目录与目标 identity。发现基线变化时拒绝写入，要求重新读取，不以第二套文件提交协议替代现有行为。 | Wiki domain coordinator、Wiki service、`wikiWriteMutex`、`safeAtomicWrite` | AC-13、AC-16、AC-19、AC-20、AC-22 |
| INV-10 | 工具发现只披露 schema，不改变工具授权集合；执行仍经过当前 lane 的策略、确认和 final-check。 | deferred registry、toolChatLoop、Policy Engine | AC-10、AC-14、AC-24 |
| INV-11 | schema、页面身份或来源身份无法唯一判定时 fail closed；保留现场及历史，不自动挑选或覆盖。 | reconciler、restore validator | AC-19、AC-20、AC-21、AC-23 |
| INV-12 | Agent 通过通用文件工具访问 Wiki 挂载路径会被稳定拒绝；普通工作目录文件行为不变。 | file facts、locked Policy Engine rule | AC-11 安全矩阵 |
| INV-13 | 工具发现、执行、通用文件旁路和旧命令/Skill 路由由同一 lifecycle 状态控制；首次初始化只能由当前版本 lifecycle provider 在可信 Wiki 挂载根执行，控制面损坏不得重置为首次初始化；门禁只约束当前运行版本，不能声称拦截旧版二进制。 | Wiki lifecycle provider、bootstrap seal、catalog/dispatch/policy/file facts | AC-11、AC-16、AC-25 |

### 2.2 领域对象与状态所有权

| 对象/状态 | 权威数据 | 唯一 writer | 提交点 | 恢复者 |
| --- | --- | --- | --- | --- |
| SCHEMA 当前文本 | llm-wiki/SCHEMA.md | 用户外部编辑，或通过批准的 `memory.wiki_update_schema` | 复用 `safeAtomicWrite` 原子写入，再由 Wiki service 记录 schemaVersion/hash | Schema coordinator；无效时只读返回最近有效快照 |
| SCHEMA 历史/提案 | Wiki 根服务保留区中的版本快照与提案文件 | Wiki service | 经 safeAtomicWrite 原子替换对应记录文件 | Wiki service |
| 页面当前 Markdown | 对应页面文件 | Wiki service；用户可外部编辑 | 复用 `safeAtomicWrite` 原子写入并完成文件 journal 最终确认 | page reconciler |
| 页面元数据/位置/别名 | 页面 marker 与标题正文是当前用户可编辑值；服务保留区的 catalog 文件是核对后的可重建查询投影 | Wiki service；用户可外部编辑文件元数据 | reconciler 或保存操作提交 | page reconciler |
| 页面 revision 快照 | Wiki 根服务保留区中的不可变 Markdown 快照 | Wiki service | 页面写入前保存旧快照，新快照随页面写入完成后登记 | operation recovery |
| raw 当前文本 | 共享 raw 文件 | 应用导入或用户外部编辑 | 文件创建/替换完成后登记当前指纹 | source reconciler |
| raw sourceRevision 快照 | Wiki 根服务保留区中的不可变原始资料快照 | Wiki service | 通过 safeAtomicWrite 写入独立快照文件 | source reconciler |
| 操作事件 | Wiki 根服务保留区中的 operation journal 文件 | Wiki service | 领域数据提交与成功事件材料在同一个 `domain_committed` journal 替换点成立；`completed` 只表示必需投影已确认 | operation recovery |
| index.md/log.md | index 从已提交页面集生成；log 从处于 `domain_committed` 或 `completed` 的成功事件生成 | projection writer | 每个视图复用 `safeAtomicWrite` 原子更新；投影代次记录在服务状态文件 | projection recovery |
| pending operation | Wiki 根服务保留区中的 operation journal 文件 | Wiki service | 页面写入前登记 prepared；每次状态转换用 safeAtomicWrite 原子替换 | operation recovery |

页面 marker 采用一个保留 HTML 注释区，格式版本固定为 1，包含 pageId、categoryId、summary、parentPageId、sourceRefs（每项固定 sourceId 与 sourceRevision）和 revision；revision 以活动 marker 与 `.wiki-service/page-history/<pageId>/` 中的不可变快照共同核验。Markdown 正文的首个一级标题为标题。marker 缺失、重复 pageId 或 marker 无效时登记 identity conflict，禁止自动保存。categoryId/parentPageId 外部改变仍须通过现行 Schema 与树规则验证。

当前文件的 marker、首个一级标题和 Markdown 正文是页面可编辑内容的权威输入；`.wiki-service/catalog.json` 保存经校验、可重建的目录投影和 content_hash。发生外部编辑时，marker 解析成功且规则校验通过后再推进投影及 revision；journal 恢复中的文件则按 2.6 的 old/new hash 协议判定，不能直接覆盖。marker 被旧版本或外部编辑器移除时，不以标题猜测身份；若现有别名/历史路径也不能唯一映射，则登记 identity conflict 并暂停该页写入，要求人工重新关联。活动页面标题冲突按 categoryId、parentPageId 和归一化标题判定：标题经 Unicode NFKC、首尾裁空、连续空白折叠及不区分大小写转换后形成 title_key；同类别/同父级下的活动页 title_key 唯一。根页面 parentPageId 为 null。

### 2.3 SCHEMA 分类格式和版本语义

分类区块采用下列逻辑形状；最终边界文本以 D-TP-02 裁决值为准：

    <!-- wiki-categories:start -->
    {
      "formatVersion": 1,
      "categories": [
        {
          "id": "concept",
          "name": "概念",
          "description": "术语与稳定概念",
          "status": "active",
          "allowedParentCategoryIds": ["topic"]
        }
      ]
    }
    <!-- wiki-categories:end -->

解析器约束：

- 恰好一个开始标记和一个结束标记；区块外自然语言只提供整理规则。
- 必填字段为 id、name、description、status；status 为 active 或 deprecated。
- id 使用稳定 ASCII 标识；同一 Schema 内不得重复；更名只改 name，不改 id。
- allowedParentCategoryIds 缺省表示允许任意有效父类别；提供后只允许列出的父级类别。
- parser 拒绝重复 JSON 键、未知格式版本、非法类型、重复 id、未知父类别、非法状态和未闭合区块，返回含行号/类别 ID 的诊断。
- 存量 category 映射需要迁移预览。现有 entity、concept、topic、source、query 映射到同名稳定 ID；其他类别由规范化名称确定性生成 ID，冲突时追加由原始类别名确定的稳定短 hash。预检展示完整映射；类别身份无法唯一识别时进入冲突态，要求用户先修复现有 SCHEMA/页面并重跑预检，不新增专用映射界面、不回退默认分类。
- 页面标题冲突按同一 categoryId、同一 parentPageId 下 title_key 唯一判定；跨类别或跨父页面可重名。title_key 算法见 §2.2。
- 每次有效文件内容变化（包括外部编辑）产生严格递增 schemaVersion。服务以版本号和 SHA-256 文件指纹共同判断提案、确认和提交是否仍基于同一版。
- 无效外部文件保留原样；查询可返回最近有效 Schema 的只读快照和当前诊断；所有依赖分类的写入拒绝。
- 删除仍被页面使用的 categoryId、让现存 parent-child 关系违反约束或降低字段格式版本时拒绝 update_schema，直至调用方先通过页面专属操作在当前 Schema 下迁移受影响页面，或将类别保留为 deprecated。Schema apply 自身不做多页面隐式迁移；域锁内发现任一现存页面不兼容时返回完整冲突集合且零写入。

### 2.4 Agent 工具契约

本方案将对外工具名统一放在 `memory.wiki_` 命名空间，为 `memory` 下未来其他知识能力保留命名空间。下表定稿工具名与输出边界；入参字段和业务语义遵循需求 §5。调用参数不携带 targetProjectId、Wiki 文件路径、索引路径或日志路径。资料导入由应用命令路由取得可信来源引用并绑定 sourceId；Agent 不提供任意 Wiki/raw 目标路径。

`memory` 是初始模型工具列表中的真实可调用发现工具，输入为 `query: string`、`limit: integer`（默认 8、上限 20）、`offset: integer`（默认 0）；结果含匹配名/用途/完整 input_schema、totalMatches、truncated 和 usage。发现结果由 tool loop 注入后续模型请求的可调用工具 schema，再由 dispatcher 按原 tool name 执行；这不是只给 Agent 文本说明，也不改变该操作的授权集合。表中 `memory.wiki_*` 是由该入口发现并调用的领域操作名。

| 工具 | 输入关键字段 | 返回关键字段/规则 | 授权类别 |
| --- | --- | --- | --- |
| memory | query、limit、offset | 初始模型上下文中真实注册的轻量发现工具；返回匹配的 `memory.wiki_*` 工具名、用途和完整 input_schema，含 totalMatches、truncated、usage；schema 不得截断。查询只披露 schema，不改变授权集合 | discover/read |
| memory.wiki_get_schema | 可选 section | schemaVersion、categories、规则文本、诊断、有效状态 | read |
| memory.wiki_search | query、categoryId、limit、cursor | pageId、title、category、summary、snippet、matchLine、revision、source attribution；无物理路径 | read |
| memory.wiki_open_page | pageId、可选 revision | readHandle、固定 revision、标题/类别/摘要/父级/来源元数据、charCount、lineCount；不返回正文；删除态返回 tombstone | read |
| memory.wiki_read_page | readHandle、cursor?、startLine?、maxChars? | 固定 revision 的有界正文片段、startLine/endLine、startOffset/endOffset、nextCursor、hasMore；cursor 与 startLine 互斥 | read |
| memory.wiki_import_source | 应用绑定的 sourceRef / sourceId；不接收 Agent 自由路径 | sourceId、sourceRevision、显示名、来源 projectId 标注；拒绝未绑定引用、越界、目录、二进制与 Wiki 挂载源 | import/write |
| memory.wiki_read_source | sourceId、可选 sourceRevision/cursor/maxChars | 指定版本的有界正文片段、project attribution、nextCursor、hasMore；无权和未知对象返回相同外部错误类 | read |
| memory.wiki_save_page | pageId?、title、categoryId、summary、markdown、sourceRefs、schemaVersion、expectedRevision?、parentPageId? | pageId、revision、projectionStatus、页面引用；更新不允许在该操作改 parentPageId | write/confirm by current policy |
| memory.wiki_move_page | pageId、parentPageId 或 null、expectedRevision | 新 revision、原 categoryId/pageId、逻辑面包屑；拒绝环、自父级、不可读父级 | write/confirm by current policy |
| memory.wiki_list_page_revisions | pageId | 按时间倒序返回 revision、时间、变更摘要、externalEdit、deleted 状态 | read |
| memory.wiki_restore_page | pageId、targetRevision、expectedCurrentRevision、可选 title/categoryId/parentPageId overrides | 返回完整冲突集合或 proposal-to-confirm；执行前展示最终标题、类别、摘要、父级、正文、来源版本和差异 | write + mandatory user confirm |
| memory.wiki_propose_schema_change | complete proposed SCHEMA content、expectedSchemaVersion | proposalId、规范化全文 diff、影响页数、有效期、基线 hash；不写 SCHEMA | write/proposal |
| memory.wiki_update_schema | proposalId、expectedSchemaVersion | 只应用绑定提案；确认 receipt 由 host context 提供，不信任模型参数；成功返回新 schemaVersion | write + mandatory user confirm |

页面 readHandle 是短期、不可猜测且不含路径的服务端句柄，绑定 caller/lane、pageId 与不可变 revision；每次 read_page 仍重新检查当前授权，句柄不是 permit。页面变化不会让已打开的读取混入新旧正文：后续片段继续读取固定快照；需要最新内容时重新 open_page。句柄过期返回稳定错误 page_read_handle_expired，Agent 重新打开目标当前/历史版本。read_page 默认上限 4,000 Unicode code points、硬上限 8,000；超长单行在合法 Unicode 码点边界切分，响应同时给 offset 与行号。首次调用可指定 startLine 进行随机定位，后续只用 cursor；搜索结果提供 matchLine 作为定位依据。cursor 不接受文件路径或任意 revision，且绑定 handle、调用上下文和读取位置。read_source 使用相同的有界片段原则，sourceRevision 固定后才续读。

公开错误统一为 success=false、error.code/message/retryable/diagnostics。消息不包含绝对路径、raw 正文、未授权对象存在性或敏感文件内容。稳定 code 至少包括 wiki_not_initialized、schema_invalid、schema_conflict、category_invalid、page_not_found、page_deleted、revision_conflict、title_conflict、parent_invalid、restore_conflict、source_missing、source_revision_missing、page_read_handle_expired、wiki_access_denied、external_change_conflict、projection_pending、operation_pending、idempotency_conflict 和 confirmation_required。

结果响应的 success=true 仅代表页面/Schema/来源操作及其必要 index/log 投影都完成。若正文已提交但投影失败，返回 projection_pending 和 operationId，不返回完整成功。Agent 重试同一 toolUseId 得到已记录结果或恢复状态。

### 2.5 持久化模型（现有 Wiki 根内的文件存储）

页面、SCHEMA、raw、index.md 和 log.md 保留在现有集中 Wiki 根及原有文件格式。服务私有数据放在该根内的保留目录 `.wiki-service/`，仍由同一文件系统和现有安全写入链路管理；不创建数据库、不迁移数据根，也不把 Markdown 正文改存数据库。

| 文件区 | 内容 | 权威性与恢复规则 |
| --- | --- | --- |
| `.wiki-service/page-history/<pageId>/<revision>.md` | 页面每个已提交版本的完整 Markdown（含机器元数据） | 不可变；同名已存在时只校验 hash，不覆盖 |
| `.wiki-service/source-history/<sourceId>/<revision>` | 每个已登记 sourceRevision 的原始资料字节 | 不可变；页面引用版本由 sourceId+revision 精确寻址 |
| `.wiki-service/schema-history/<schemaVersion>.md` | 每个有效 SCHEMA 完整快照 | 不可变；无效外部 SCHEMA 不覆盖最近有效快照 |
| `.wiki-service/operations/<invocationKey>.json` | 调用指纹、主体/lane、目标、旧/新 hash、状态、结果及成功事件字段 | 幂等与崩溃恢复唯一依据；成功事件在 `domain_committed` 时成立，只有未提交状态不得含 success_event；不存放明文正文 |
| `.wiki-service/staging/<invocationKey>.payload` | 尚未完成操作所需的新页面/SCHEMA/raw 内容 | 只在 operation 未完成时存在；完成后删除；通过现有安全写入链路写入 |
| `.wiki-service/state.json` | lifecycle、格式版本、投影代次和恢复状态 | lifecycle 唯一真源；只由当前版本 WikiLifecycleController 更新 |
| `.wiki-service-bootstrap.json` | 根身份、bootstrapId、初始化类型/阶段、seal 格式版本 | `.wiki-service/state.json` 的持久初始化见证；写入后不自动删除；损坏时进入 recovery_required |
| `.wiki-service/migrations/<migrationId>.json` | 本次必要文件格式迁移的清单、逐项 hash 和进度 | 只记录新版本可执行的迁移；发现外部变化时停在 conflict，绝不覆盖 |

活动页面文件内的保留 HTML 注释保存 pageId、categoryId、summary、parentPageId、sourceRefs 和 revision；页面正文仍为 Markdown。页面文件和 SCHEMA 是当前内容真源；历史文件不可变；`operations` 中成功状态是操作事件真源；index.md/log.md 和 `.wiki-service/catalog.json` 均是可重建视图。`state.json`、journal、快照均位于现有 Wiki 根内，且所有写入复用 `safeAtomicWrite`。不得建立数据库、sidecar 或另一份全局存储根。

文件系统没有跨文件事务。每一步都使用原子文件替换、旧/新内容 hash 和可重启状态判定；目录或单文件写入由既有安全写入 helper 保证。Wiki domain coordinator 提供当前进程内的域级串行化，不替代文件级安全写入，也不声称锁住外部编辑器或旧版应用。

### 2.6 调用幂等、文件提交与崩溃恢复

Wiki 领域写入复用本项目文件写入工具，不实现第二套提交协议。对 Wiki namespace 的调用通过 `acquireWikiWriteMutex(absPath)` 与当前应用的文件写操作串行；目标状态校验与文件发布沿用 `write_file` / `edit_file` 的代码路径：读取当前正文并与调用提交的 revision/hash 对照，捕获 `FileIdentity`，然后调用 `safeAtomicWrite`。目录句柄 worker 在发布前复核父目录和目标 identity；更新已有文件时原子替换，新建文件要求目标仍不存在。

该契约由以下现有代码提供，Wiki service 必须调用而不能复制实现：

- `electron/wiki/wikiWriteMutex.ts`：同一 Wiki 文件的应用内互斥。
- `electron/safeAtomicWrite.ts`：父目录身份检查、`captureFileIdentity`、临时文件写入和安全原子写入口。
- `electron/confirmation/directoryHandleWriter.ts`：发布前复核目录和目标 identity，拒绝目标被替换或新目标被抢占。
- `electron/tools/builtinExecutors.ts`：现有 `write_file` / `edit_file` 的读取状态比较、permit 复核、Wiki mutex 和提交调用顺序。

所有会改变页面、SCHEMA、raw 身份或目录投影基线的当前版本操作，以及外部协调和迁移恢复，先取得 Wiki domain coordinator 的单域锁，再取得所需的文件级 Wiki mutex。若需多文件锁，按 Wiki 根内规范化相对路径的字典序依次获取，并在释放前按反序释放；不得在持有文件锁后反向请求域锁。读操作若依赖多个对象的一致快照，也在域锁内完成读取/快照固定。域锁覆盖完整的“扫描全部相关对象→跨对象校验→写入领域提交点或进入恢复隔离”区间。SCHEMA 应用必须在锁内以提案基线重新读取 SCHEMA 和全部活动页面，校验类别、父类别、树和标题约束；任一现存页面不兼容则零写入并返回完整冲突，不允许先写 SCHEMA 再修页面。save/move/restore/reconcile 同样在当前 SCHEMA 与完整活动页面集上校验。域锁是当前进程内互斥；旧版/外部编辑并不遵守它，提交前仍须按既有 helper 核验目标 identity/hash，检测到跨文件扫描期间的外部变化则停止并进入 conflict/recovery_required，不能声称提供外部写者的全库原子事务。

文件内容与 operation journal 文件不是一个跨文件原子事务，按 journal 与目标 hash 恢复同一调用：

1. 校验可信主体、caller、lane、工具动作和当前策略；按 `(requestId, toolUseId)` 计算确定性 invocationKey 并读取对应 journal。已存在的调用先比较完整参数指纹；已完成则回放结果，进行中则只恢复原操作，不先因旧 expectedRevision 拒绝重试。
2. 新调用才检查 expectedRevision/schemaVersion、读取当前文件并协调外部变化；记录旧 hash 和目标 identity，在 `.wiki-service/staging/` 写入待提交内容并核对 staging hash。
3. 通过 `safeAtomicWrite` 原子写入 `prepared` journal，包含调用指纹、staging 引用、目标、old_hash 和 new_hash；随后保存旧版本快照，再用现有安全写入逻辑提交目标文件。
4. 目标文件 hash 等于 new_hash 后，以 `safeAtomicWrite` 将 journal 更新为 `domain_committed`，同时记录成功事件材料和最终结果。
5. 从页面文件重建 index；从所有 `domain_committed` 或 `completed` 且含 `success_event` 的 journal 重建 log。投影完成后把 journal 更新为 `completed` 并删除 staging；投影未完成则保留 `domain_committed` journal/staging，返回 `projection_pending`。

崩溃恢复按 journal 状态和活动目标 hash 分支：目标等于 new_hash 时幂等补齐缺失的 history/event 材料并将状态推进至 `domain_committed`，该状态立即成为 log 输入；再生成 index/log，最后推进 `completed`。因此 `domain_committed` 崩溃后可被本次 log 投影消费；log 已写入但尚未推进 `completed` 时，重建同一投影不会重复事件。目标等于 old_hash 时，在调用仍获准且 revision 未变化的前提下，用 staging payload 通过同一 `safeAtomicWrite` 路径重试；目标既非 old 也非 new 时记录 conflict、保留外部版本并要求重新读取。新建目标被抢占时沿用现有“不覆盖已存在目标”的拒绝结果。helper 返回不确定结果时保留 pending journal，由启动或下次相关 Wiki 操作恢复，不伪装为普通拒绝或成功。`prepared`、`conflict` 等未提交状态不含 `success_event`，不进入成功日志。

`input_fingerprint` 对字段键排序后的规范 JSON 做 SHA-256，覆盖完整业务入参，包括 expectedRevision、schemaVersion、正文、目标及覆盖项，不包括 permit/确认票据等 host 临时字段。invocationKey 对 requestId+toolUseId 做 SHA-256，避免把不可信调用字段直接拼入路径；caller、lane 或 tool 不符时按 idempotency_conflict 处理。

页面分段读取由 open_page 创建固定 revision 的短期 handle，read_page 只读取 `.wiki-service/page-history/<pageId>/<revision>.md` 中的不可变快照；默认片段上限 4,000 Unicode code points、硬上限 8,000，startLine 可定位首片段，cursor 续读。读取期间发生外部编辑时，当前 handle 不混读新版本；新调用重新 open 才读取最新 revision。读取授权逐次校验，handle 过期或 lane 权限撤销时拒绝续读。search snippet 附 matchLine 供 Agent 定位长文档相关段落。

外部页面扫描先核对活动文件。首次登记以当前文件建立 revision 1 快照；后续变化通过 marker 定位 pageId，先保存前一完整快照，再校验类别/标题/树，推进 revision 并写入 externalEdit journal。无后台 watcher，因此 revision 表示服务在相关操作时观测到的状态，不承诺保存两次扫描之间每次短暂存在的外部编辑版本。文件改名/移动更新相对路径别名，不改变逻辑 parentPageId；删除形成 tombstone。身份冲突不自动改名或重归类。search 全量扫描 Wiki root 并完成协调后，按 lane 可读范围检索可重建 catalog；不跟随越出 root 的 symlink。query 做 Unicode NFKC 与大小写规范化，按空格拆词并要求全部命中标题/摘要/正文；标题命中优先，其次摘要，再按更新时间排序；limit 默认 8、上限 20，cursor 使用排序键与 pageId，snippet 上限 500 字符。本期只做本地字面搜索。

SCHEMA、raw、index/log 也经过相同 coordinator 与现有 safe write helper。`memory.wiki_update_schema` 在确认后、journal 查询后校验提案 hash；基线变化则 proposal 标 conflict，不覆盖。raw 导入使用现有安全新建路径并保存 sourceRevision 快照；index/log 漂移先在 `.wiki-service/projection-backups/` 保留异常内容，再从页面文件和成功 journal 重建。投影更新不推进页面 revision 或 schemaVersion。

### 2.7 授权、安全与调用事实

| 阶段 | Wiki 责任 | 明确禁止 |
| --- | --- | --- |
| facts | 只生成 toolName/action、lane、pageId/sourceId、project attribution、schemaVersion/hash、expectedRevision/sourceRevision、确认能力等观测 | facts 不得给出 allow/confirm/deny |
| policy | Shared Policy Engine 决定 Wiki read/import/write/schema/restore 的 allow/confirm/deny，产生稳定 rule ID 与 trace | 不按 projectId 决定权限；不把工具已被发现当授权 |
| confirmation | 复用当前桌面/IM 工具确认；restore 与 SCHEMA apply 展示绑定版本和最终材料；automation 无用户确认能力时拒绝二者 | 不接受 Agent 输入中的 confirmed=true 或 approval receipt |
| final-check | 核验主体、lane、授权代次、permit、resource ID、文件 hash、SCHEMA/page/source revision 和 proposal 差异仍匹配 | final-check 不重新评估业务风险 |
| executor | 只有上述材料有效后调用 Wiki service；在任何失败路径不得写入文件或记录成功操作事实 | 不改走 read_file/write_file/grep 绕过领域工具 |

代码责任和验收分层固定如下：`electron/confirmation/toolCallGate.ts` 与 Wiki facts adapter 只产出 tool/action、lane、领域 ID、版本/hash、可信 sourceRef 与调用身份观测；`src/shared/policy/defaultRules.ts` 定义稳定 Wiki rule ID 并由 Shared Policy Engine 输出 trace；`electron/confirmation/writeExecutionPermit.ts` 与 `writePermitExecutor.ts` 绑定并 final-check 主体、lane、调用输入和批准材料；`electron/tools/builtinExecutors.ts` 是 Wiki executor 边界；`electron/toolChatLoop.ts` / `electron/effectiveTools.ts` 负责 dispatch 和 lifecycle recheck。E-08/E-11/E-12 分别测试确认、发现/dispatch 状态和旁路；拒绝必须断言 Wiki service/file executor 未调用。

建议稳定 rule ID：wiki-domain-page-read、wiki-domain-source-read、wiki-domain-source-import、wiki-domain-page-write、wiki-domain-page-move、wiki-domain-schema-propose、wiki-domain-schema-apply、wiki-domain-page-restore、wiki-domain-file-bypass-deny。精确 rule/actionClass/风险档位在安全实现阶段按现有 Policy Engine 分类核验，不以 system invariant 绕过策略扫描。若实现新增不可配置 system invariant，必须先按仓库要求登记并追加边界测试；本方案当前采用 locked Policy Engine rule 管理 Agent 文件工具旁路。

旁路覆盖 read_file、grep、list_directory、write_file、edit_file、copy/move/rename/delete 和 run_shell 中可识别的 Wiki 词汇路径。相对路径、绝对挂载路径、别名、大小写变体和 symlink 逃逸按既有 Wiki mount/pathSecurity facts 解析。拒绝结果提供“请使用 Wiki 专属能力”的稳定诊断；普通工作目录文件继续走原逻辑。外部编辑器不经过 Agent policy，服务按需求协调外部版本。

项目 A 的来源可由项目 B 的已授权 lane 读取；same-lane/same-operation 的拒绝结果不因 projectId 差异而变化。应用从当前 workDir 校验用户选择的来源并生成可信 sourceRef，再调用导入服务复制到共享 raw；来源 projectId 从现有项目注册表取得。Agent 不提交 sourcePath；任何来源读取都以 sourceId/sourceRevision 寻址，不接受 raw 路径。

### 2.8 索引、日志和兼容界面

index.md 从有效 Schema 类别顺序、页面元数据和逻辑父子关系生成，至少包含 pageId、标题、categoryId、摘要、父级、更新时间、来源引用和旧词汇路径链接。log.md 从状态为 `domain_committed` 或 `completed` 且带有 `success_event` 的 `.wiki-service/operations/*.json` 记录生成，含时间、动作、pageId/sourceId、revision 和脱敏摘要。`domain_committed` 是领域变更及其成功事件材料的唯一提交点，`completed` 只表示必要投影已确认；因此首次单页保存在本次 log 投影时即可见。重复 invocation 不重复事件；失败/拒绝/冲突不记为成功事件。

旧 index.md/log.md 切换前逐字备份。E-05 预检报告列明旧 index 中转为普通页面“Wiki 旧索引说明（迁移）”的内容区块、无法分类内容和旧 log 只读档案位置；用户通过现有确认体验确认报告后 E-13 才接管投影。若目标页面标题已存在或内容无法无损归类，迁移停止并报告冲突，不自动覆盖或改名。迁移不把旧 log 文本伪造成 event。

Wiki 面板保留现有操作和布局。file:list-directory 对 Wiki 用户视图仍可列出现有路径；文件访问服务把旧路径 alias 解析到 pageId 的当前位置。Agent 对同一通道的通用文件工具由 locked policy 拒绝。移动/改名后旧聊天链接继续路由到同一 pageId；页面 tombstone 在 Agent 工具结果中明确返回。当前聊天的历史列表、版本查看及恢复前确认依 D-06 使用现有消息和确认组件，不增加 Wiki 面板入口。

### 2.9 生命周期、兼容迁移与恢复

#### 生命周期唯一状态源与首次初始化

生命周期状态保存在现有 Wiki 根的 `.wiki-service/state.json`，由当前版本的 WikiLifecycleController 唯一写入。它控制当前进程的工具披露、dispatch、`/wiki`/Skill 路由、Policy facts 和通用文件工具旁路；不控制另一个旧版进程，也不代表能锁住外部编辑器。

| 状态 | 当前版本工具发现/执行 | 当前版本旧 Skill/通用文件路径 | 外部编辑器或旧版应用 |
| --- | --- | --- | --- |
| initializing | 隐藏新 Wiki 工具；只执行 seal 对应的初始化续跑 | 当前版本停止 Wiki 写入 | 不受当前版本控制；外部变化纳入后续预检 |
| legacy | 隐藏新 Wiki 工具 | 保持现有行为 | 可按旧行为写文件 |
| preflight | 隐藏新工具；只读检查 | 当前版本停止 Wiki 写入 | 不受当前版本控制；外部变化纳入 hash 检查 |
| migrating | 隐藏新工具；仅迁移器可执行 | 当前版本旧写路由和 Agent 文件旁路拒绝 | 仍可能写文件；变化导致该项迁移 conflict，不覆盖 |
| domain_ready | 候选环境注册新路由但不向生产会话披露 | 当前版本写入保持关闭 | 可按旧行为写文件；新版本启动时协调变化 |
| domain_enabled | 按需披露；执行经过当前策略与 permit | 当前版本 `/wiki`/Skill 走领域服务；Agent 通用文件旁路拒绝 | 旧版二进制仍能照常写；本服务不声称拦截 |
| recovery_required | 当前版本隐藏写工具，提供安全只读诊断 | 当前版本全部 Wiki 写入口拒绝 | 不受当前版本控制；保留现场，等待新版恢复处理 |

首次引导使用 Wiki 根内的 `.wiki-service-bootstrap.json` 作为持久 seal，先由现有 Wiki 根初始化流程确保挂载根目录存在，再以目标必须不存在的原子安全创建写入 `initializing` 意图；root identity 绑定规范化的 `resolveWikiMount.realBase` 与现有目录 identity，不采用 Agent 提供的路径。随后创建 `.wiki-service/` 与 state，最后把 seal 原子更新为 `initialized` 并记录根身份、bootstrapId、类型和格式版本。若并发启动导致 seal 已被创建，失败方必须重读并按现有 seal 分支处理，不得覆盖。该文件只由当前版本 WikiLifecycleController 创建/推进；启动入口是 Wiki mount 已解析到可信集中根之后、任何 Wiki 工具披露或读写之前。初始化扫描只读：若根已有 SCHEMA/页面/index/log，则写入 `preflight`，记录 `bootstrapKind=existing`；若根为空，则进入 `domain_ready`，记录 `bootstrapKind=empty`，不创建内容迁移。两个分支都仍须通过 E-15/E-16 才能 `domain_enabled`。

判定规则：seal 与 state 均不存在时，且 Wiki mount 根身份可信，才允许走一次首次初始化；seal 已存在为 `initializing` 时按 bootstrapId/hash 校验并继续幂等初始化；seal 与 state 一致且格式有效时按 state 运行。seal 存在但 state 缺失/损坏、seal 与 state 的 root identity/bootstrapId 不符、或只有 service 目录却没有有效 seal 时，lifecycle provider 将有效运行状态判为 `recovery_required`，绝不重置为 `legacy` 或重新初始化，也不覆盖损坏文件。seal 不存在但已发现 `.wiki-service/` 保留数据时同样视为控制面损坏。恢复只接受用户从可信备份恢复出的 seal/state 文件；当前版本随后核对 root identity、bootstrapId、格式版本和 migration manifest 后才恢复原生命周期。无可信备份时保持只读诊断，需人工修复控制面文件，不自动清空重建。若用户同时删除 seal 与整个 service 目录，单靠该 Wiki 根无法区分从未初始化和双重删除；因此 seal 作为迁移后的长期控制文件保留，并纳入用户现有 Wiki 备份；检测范围以至少一个控制文件仍存在为前提。

外部或旧版应用对 Wiki 的写入属于文件系统外部变化：新版下次相关操作扫描文件，基线不同则由 reconciler 保存旧快照、校验身份并登记新 revision；无法唯一识别时进入 identity conflict，不覆盖内容。当前版本的 `migrating` 屏障只阻止当前版本内部写入，不能阻止旧版/外部写入。

#### 仅限必要的原位文件迁移

迁移只用于将既有 SCHEMA 分类映射到稳定 categoryId、为现有页面补齐服务识别所需的 marker，以及把 index/log 转为服务生成视图；不移动 Wiki 根、不将 Markdown 改存数据库、不改变既有文件存储机制。常见旧类别使用预设稳定 ID；其他类别以规范化名称生成 ID，发生碰撞时追加由原始类别名确定的稳定短 hash。预检报告完整映射；无法唯一识别的类别或页面进入冲突态，要求用户先通过现有文件编辑能力修复 SCHEMA/页面，再重新预检，不提供本期专用映射界面。迁移清单和进度保存在 `.wiki-service/migrations/<migrationId>.json`，逐文件备份存放在同一 Wiki 根的 `.wiki-service/migrations/<migrationId>/backup/`。备份保留原字节和 SHA-256，不自动过期。

每个文件条目记录 object_kind、相对路径、old_exists、old_hash、new_hash、备份引用和 step（pending/written/verified/conflict）。开始应用前写好完整 manifest 与备份；每项写前再次核对 old_hash，通过现有 `safeAtomicWrite` 提交后核对 new_hash，再原子更新 manifest。旧版应用或外部编辑器不遵守本应用 mutex；若它们在迁移中改变当前目标，目标既非 old_hash 也非本次 new_hash 时立即停在 conflict，保留现场和备份，不尝试覆盖或继续该文件。

启动恢复在 Wiki domain coordinator 锁和当前版本写屏障内，按 manifest step × 目标存在性/hash × 旧目标是否存在完整判定：`pending + old_exists + current=old_hash` 表示尚未写入，可在备份和 staging 校验通过后重试；`pending + current=new_hash` 表示目标已写而 manifest 未推进，校验备份 hash、目标 identity 与 new_hash 后幂等补记 `written/verified`，不得重复改写目标；`written + current=new_hash` 直接核验并标记 `verified`；`pending/written + current` 不等于 old/new、备份缺失/不符、manifest 歧义均进入 `recovery_required` 并保留现场。创建项 `old_exists=false` 时，`pending + current 不存在` 可安全重试；`pending + current=new_hash` 补记 verified；其他现存内容一律 conflict。回退已有文件仅在目标仍为本次 new_hash 且备份 hash 正确时通过现有安全写链路恢复旧字节；回退创建项只在目标 identity 与本次写入一致且内容仍为 new_hash 时调用现有安全删除路径删除，否则停在 conflict。恢复本身可重启，只有所有条目逐项核对并且最终活动文件 hash 集合匹配 manifest 后才完成迁移并离开写屏障。

#### 启用与应用版本回退

1. 可信挂载根首次引导后，存量库进入 `preflight` 并只读检查 SCHEMA、页面身份、index/log 和历史目录；空库进入 `domain_ready`，无内容迁移。两者都不改 Wiki 根位置或存储类型。
2. 必要迁移使用隔离副本演练；正式数据逐文件执行时以 manifest/hash 防止覆盖外部变化。外部写入无法被生命周期状态锁住，检测到冲突即停。
3. 迁移与本机验收通过后进入 `domain_ready`；外部渠道和安装包验收全部完成后，当前新版一次提交 `domain_enabled` 与当前版本 Agent 文件旁路规则。
4. 用户启动旧版时，旧版仍按原代码写入共享 Wiki 文件。新版不尝试拦截旧二进制，也不要求数据反向迁移。
5. 用户再次启动新版后，reconciler 扫描旧版期间改变的页面、SCHEMA 和 raw；保存前一版本、推进 revision、重建 catalog/index/log。出现身份或内容冲突时保留现场并报告冲突，绝不以旧备份覆盖新内容。

程序版本回退不回退 Wiki 文件或 `.wiki-service/` 历史。恢复旧版期间写入的文件仍是共享 Wiki 当前文件；后续新版按外部编辑规则协调。没有“首个领域写入后锁定旧版”的门禁，也没有数据库恢复或反向格式迁移。

### 2.10 阶段边界与出口证据

| 阶段 | 依赖理由 | 交付边界 | 出口证据 | 可回退实体 |
| --- | --- | --- | --- | --- |
| P0 基线与安全写入复核 | 实现必须服从已批准的现有文件存储和写入逻辑 | 复核 Wiki 根解析、文件 identity、现有 safe writer 与实际调用签名；不新增存储机制 | E-00/E-01 源码复核和临时 fixture | 方案、临时 fixture |
| P1 文件模型与 SCHEMA 基础 | 分类解析和文件状态模型是协调/读写前置 | Schema parser、文件形式的版本/journal 状态模型、bootstrap 数据适配 | E-02/E-03 parser 与文件模型定向证据 | Wiki 文件和新模块 |
| P2 页面/来源协调与读操作 | 读操作依赖稳定身份及外部变化协调 | reconciler、只读迁移预检、search/open/read、source import/read | E-05/E-06 external edit/move/delete fixture、跨项目/lane 对拍 | 文件协调模块 |
| P3 页面写入与投影 | save/move/restore 共享域级锁、revision 和 operation journal | 页面写服务、幂等恢复、索引日志投影 | E-07 崩溃注入/交错/重试/投影证据 | journal 和 projection modules |
| P4 SCHEMA 与恢复交互 | 依赖确认绑定和当前规则解析 | propose/update SCHEMA、版本列表、聊天恢复 | E-08/E-09 confirmation receipt 与冲突零写入证据 | schema proposal / revision modules |
| P5 真实入口、工具与安全接通 | 源码关闭需走真实 `/wiki` 命令、Skill 和 sourceId 链路 | 旧命令/Skill 改为领域 API；deferred discovery；统一 lifecycle 和当前版本 file bypass；WikiPane alias 兼容 | E-10/E-11/E-12 的集成、策略 trace 和路径矩阵 | 工具注册、策略规则、命令路由、Skill |
| P6 必要原位迁移与源码关闭 | 只在旧格式确需改写时迁移；源码关闭不依赖外部渠道 | 可选 migration manifest、逐文件恢复、本机 AC 与回退演练 | E-13/E-14；若无待迁移项，E-13 以 dry-run 证明 no-op | 旧 Wiki 根快照、manifest、lifecycle |
| P7 外部验收与发布启用 | 外部渠道和打包环境证据须先于启用 | 真机/IM 验收、候选包文件系统验收、启用 lifecycle | E-15/E-16/E-17 签署记录 | 候选包、隔离 Wiki fixture、release gate |

E 编号 DAG 只由执行计划维护；本表为阶段归属说明：P0=E-00/E-01，P1=E-02/E-03，P2=E-05/E-06，P3=E-07，P4=E-08/E-09，P5=E-10/E-11/E-12，P6=E-13/E-14，P7=E-15/E-16/E-17。E-13 有待迁移项时执行，且迁移前需用户确认 E-05 报告；无待迁移内容时以只读 dry-run 通过，不产生写入。

### 2.11 排除方案

| 本期选项 | 排除方案 | 原因 |
| --- | --- | --- |
| 以 SCHEMA 内严格 JSON 描述动态类别 | 编译期 TypeScript enum | 新类别不应等待构建和发版 |
| 以 pageId/sourceId 访问领域对象 | Agent 接收 llm-wiki 路径并由路径推导身份 | 路径不是授权凭据，rename/move 会破坏身份 |
| 主进程协调外部文件编辑 | 后台 watcher 实时同步 | 需求明确首版不运行 watcher；避免持续 IO 和失效事件风暴 |
| 活动文件 + `.wiki-service/` journal 分阶段提交 | 声称单次操作可跨多个文件原子提交 | 现有文件存储不提供跨文件事务；按文件 hash 与 journal 恢复 |
| 服务生成 Markdown index/log 视图 | Agent 持续维护手写区块 | 已由 D-04 否决；知识说明迁移为普通页面 |
| 现有确认与 Policy Engine | Wiki 自己接受模型提供的 allow/confirmed 字段 | 无法证明同一用户确认了相同内容 |
| 单主父级 + 关系链接 | 多父级路径/复制页面 | D-02 已决定保持单导航父级 |

## 第 3 层：验收规格【机｜人工可跳过】

### 3.1 错误路径与安全边界

- 未初始化：wiki_not_initialized，不创建工作目录同名文件。
- Schema 缺失/无效：保留诊断和最近有效只读版本；所有依赖分类写入拒绝。
- 分类停用/未知、schemaVersion 过期、expectedRevision 冲突：零页面变更，返回可刷新信息。
- 未知与无权 pageId/sourceId 对外同错类，避免对象存在性泄露；lane 策略 trace 内保留实际 decision reason。
- 外部身份重复/marker 损坏、文件版本非 old/new hash、SCHEMA 提案过期/变化：fail closed，不覆盖外部内容。
- restore 任一类别、父级、标题、来源历史冲突：完整收集诊断，零写入；覆盖项必须来自用户明确选择，重新确认时展示最终全文与所有元数据。
- index/log 视图生成失败：保留备份，返回 projection_pending；下一次相关操作先恢复投影。
- raw 删除：source tombstone 和历史快照保留；不伪造当前版本、不自动重跑 Ingest。
- automation 不提供人工确认时拒绝 restore 和 Schema apply；飞书/微信仅在现有远程确认成功并绑定相同 proposal/page revision 时执行。

### 3.2 验收映射

需求 AC-01 至 AC-26 是行为验收唯一真源。实施映射如下，不复制 AC 文本：

| AC | 技术责任/模块 |
| --- | --- |
| AC-01、AC-14 | tool registry、deferred catalog、真实 `memory` 发现工具及 tool loop schema 注入、`memory.wiki_search` / `memory.wiki_open_page` / `memory.wiki_read_page` |
| AC-02、AC-03、AC-17、AC-20 | Schema parser、version coordinator、save final-check、proposal apply |
| AC-04、AC-05 | page validator、expectedRevision、move validator |
| AC-06、AC-07、AC-13、AC-22 | operation journal、event store、projection renderer/recovery |
| AC-08、AC-09、AC-21 | source importer/reconciler/read API、raw file deny |
| AC-10、AC-18 | lane facts、Policy Engine、source attribution，无 project ACL |
| AC-11 | Wiki mount facts + locked domain bypass rule + 普通目录对照 |
| AC-12、AC-19、AC-23、AC-24 | file path alias、page history/restore、确认和 lane matrix |
| AC-15 | proposal binding、确认 receipt、Schema safe-commit 与外部编辑竞态拒绝 |
| AC-16 | migration report/confirmation、备份、只读旧日志、说明页、切换 manifest |
| AC-25 | bootstrap seal/initializer、lifecycle preflight/empty 分流、控制面故障恢复 |
| AC-26 | Wiki domain coordinator、固定锁顺序、全页集/SCHEMA 校验与并发故障注入 |

### 3.3 场景与边界测试

按 invariant 设计专门测试；以下为实现验收要求，不在本轮运行。

- Schema parser：缺区块、重复区块、重复 JSON key/id、未知父级、deprecated、错误格式版本、用户自然语言增加同名分类但结构区块未变。
- 写入协议：创建/更新、同 revision 双写、Schema 变化后写、页面 hash 变化后写、父级自环/后代、标题唯一性、重复 operationId、commit outcome unknown。
- 幂等反例：首次保存 r→r+1 成功后，以完全相同的 requestId/toolUseId、参数及旧 expectedRevision 重试，必须在 revision 校验前回放首次结果。分别重试 prepared、domain_committed、projection_pending；同 invocation 改正文/目标/expectedRevision 必须 idempotency_conflict，且不产生第二 revision/event。
- 外部编辑竞态：复用现有文件工具边界夹具，覆盖读取后修改、permit/identity 捕获后修改、目标原子替换、目标新建抢占；验证 Wiki service 调用既有 helper，变化时拒绝且不覆盖外部版本，重新读取后可重试。沿用 `electron/tools/builtinExecutors.fileState.test.ts`、`electron/safeAtomicWrite.test.ts` 的断言口径，不新增另一套硬链接/归档协议测试。
- crash injection：prepared 前后、文件 helper 返回前后、operation journal 最终确认后、index 替换后、log 替换后、app 重启恢复；按 old/new hash 判定恢复，不检查自定义 inode 归档状态。
- external edit：修改正文/title/category/parent/sourceRefs、改名、移动、删除、marker 缺失/重复；确保快照顺序与 tombstone。
- history restore：类别被删除/弃用、父级被删除/形成环、标题冲突、sourceRevision 缺失、用户覆盖正确和无效、确认期间并发推进。
- schema approval：proposal created → edited externally → approval issued → update rejected; expired proposal; spoofed confirmed input; user denial; second approval binds fresh hash.
- lane matrix：desktop/wechat/feishu/automation × page read/write/source read/schema apply/restore/raw write；同一 lane 的同一操作按项目 A/B 结果一致。
- bypass：read_file/grep/list_directory/write_file/edit_file/copy/move/rename/delete/run_shell 命中 Wiki mount、别名、绝对路径、大小写变体、symlink 逃逸；普通工作目录文件成功。
- projection：index/log 人工修改、删除、backup 写失败、重建失败、重建成功；失败不推进 page revision/schemaVersion。
- migration：无损 dry-run、重复类别、无效 Schema、旧 index 手写说明、旧 log 文本保留、备份 hash 不匹配、磁盘空间不足；每个已改文件后分别注入失败并重启，验证按 manifest 继续，或停止并保留活动/归档/暂存三方现场；migrating 屏障拒绝当前版本旧路由与 Agent 通用文件工具，但旧版应用/外部编辑器仍可写，变化必须触发 conflict 且不得覆盖。
- lifecycle：逐项验证 initializing、legacy、preflight、migrating、domain_ready、domain_enabled、recovery_required 对工具注册、dispatcher、`/wiki`、Skill、Policy facts 和 file IPC 得出同一状态；控制面缺失/篡改不回退 legacy。另验证存量库/空库首次引导、初始化中断续跑、state/seal 损坏恢复，以及旧版写入后新版 reconciler 检测并协调文件变化。

### 3.4 验收环境边界

**当前开发机可本地验收：** parser、migration fixtures、文件存储夹具、并发与 journal 故障注入、Wiki mount/path facts、工具按需加载、确认 receipt fake、project attribution 与 lane policy unit/integration、现有 WikiPane 文件引用映射、构建与类型/i18n 检查。

**需要外部环境复核、但不阻塞源码关闭；全部阻塞发布启用：** 真实飞书/微信账号中的 Wiki 确认与拒绝、automation 实际无确认拒绝、桌面长恢复正文可读性、外部编辑器及旧版应用真实改名/移动/并发写后的新版本协调结果、正式安装包升级、各目标平台数据目录与现有 `safeAtomicWrite` 所需目录写入能力。证据写入执行计划指定的 release acceptance 记录；没有逐项签署证据时必须停在 `domain_ready`，不得标记 `domain_enabled`。

### 3.5 未验证项与实现前技术核查

| 项 | 影响 | 核查方法 | 责任 |
| --- | --- | --- | --- |
| `.wiki-service/` 与现有 Wiki 文件权限/原子写入能力是否满足快照和恢复要求 | 决定历史、journal、manifest 能否安全落在既有 Wiki 根内；不涉及数据库探针 | 复核 Wiki 根解析、目录创建、`safeAtomicWrite`、目录句柄 worker、文件 identity 與权限边界；用临时 Wiki fixture 验证重开后按 hash 恢复，不触碰用户数据 | E-00/E-04/E-13；若既有安全写入链路不满足要求，暂停实现并修订方案，不另引入数据库 |
| 现有 WikiPane 对路径、目录和 markdown 引用的依赖 | 决定旧路径 alias 是只改 fileIpc 还是还需扩展当前映射 | rg/读取 WikiPane、FileTree、Markdown link resolver 和 appIpc handlers，列调用图 | 实现负责人；P0 复核 |
| Wiki 写工具现有确认材料能否展示足够长的整页恢复内容 | 决定 confirmation payload 分页/折叠方式；不得改成仅展示摘要 | 检查 tool confirmation component/render limit，提供超长 fixture | 实现负责人；P0 复核 |

### 3.6 业务词与内部词

| 业务词 | 内部含义 |
| --- | --- |
| Wiki 页面 | 带稳定 pageId、类别、正文、来源和逻辑父级的知识条目 |
| 来源 | raw 下的原始资料及其稳定 sourceId |
| 页面版本 | 同一 pageId 下单调递增的完整 Markdown 与元数据快照 |
| SCHEMA 版本 | 当前有效分类/规则文件的序号与文件 hash |
| 项目来源标注 | 资料最初导入自哪个 workDir；它不授予/限制读写权限 |
| 索引/日志视图 | 从页面元数据和成功操作事件生成的 Markdown 文件 |
| 旁路拒绝 | Agent 不能用通用文件/终端工具操作 Wiki 挂载目标 |

## 附录 A：证据和来源

- 需求真源：[wiki-domain-tools-requirement.md](../../../requirement/knowledge-skills/in-flight/wiki-domain-tools-requirement.md)，尤其 D-01 至 D-06、§4–§13、AC-01–AC-26。
- 当前代码事实：HEAD 28dd3223，复核命令见 §1.3；工作区在本次文档任务开始前已有其他用户改动，本方案未覆盖或清理这些文件。
- 历史规则：LLM Wiki 当前 Skill、Wiki mount/import、安全策略及 MCP 延迟加载的实际源码路径见 F-01 至 F-07。
- D-TP-01 至 D-TP-05 已按负责人选择记录；实施前须按 E-00/E-01 复核代码事实和安全写入签名，若事实变化则先修订方案与 DAG。旧版应用仍可按原代码写原 Wiki 文件，是已明确的兼容事实。

## 附录 B：评审问题核销（2026-10-17）

| 评审项 | 修订位置与计划证据 | 当前状态 |
| --- | --- | --- |
| B-01 幂等查询顺序与调用映射 | §2.5、§2.6；E-07 成功重试、pending 恢复、同键异参测试 | 方案已闭合，待实现证据 |
| B-02 外部编辑器竞态 | D-TP-05；复用 `safeAtomicWrite`、Wiki mutex 与既有文件工具竞态用例；E-04 接入验证 | **已按既有文件写入契约收敛**；Wiki service 不得复制或绕过既有安全写入链路 |
| B-03（首轮）多文件迁移恢复 | §2.9 durable manifest、逐文件 step 与重启算法；E-13 逐文件故障注入 | 方案已闭合，待实现证据 |
| B-04 源码入口与启用状态 | §2.9 lifecycle 状态机；E-10 真实本地命令/Skill/sourceId 路由，E-11 状态统一门控，E-14 本地源码关闭 | 方案已闭合，待实现证据 |
| B-05 SQLite 备份开工证据（已不适用） | 负责人裁决复用现有文件存储后，SQLite 备份探针不再适用；文件权限与安全写入能力由 E-00/E-01/E-13 核验 | 已从门禁移除；不新增数据库备份前置 |
| B-03（本轮）迁移 pending + new_hash 恢复 | §2.9 完整 step/存在性/hash 分支；E-13 在写入后、manifest 更新前强制崩溃 | 方案已闭合，待实现证据 |
| B-07 跨页/SCHEMA 并发约束 | INV-07/09、§2.6 域锁与固定锁顺序；E-07/E-08 交错与随机序列测试 | 方案已闭合，待实现证据 |
| B-08 日志投影循环 | §2.5/2.6/2.8 以 `domain_committed` 为事件提交点，log 消费 domain_committed/completed，completed 仅表示投影完成 | 方案已闭合，待实现证据 |
| B-09 首次初始化路径 | §2.9 bootstrap seal、existing/empty 分流和损坏恢复；E-11/E-13 覆盖初始化入口与中断 | 方案已闭合，待实现证据 |
| B-06 发布前外部验收 | §3.4 外部证据阻塞 domain_enabled；E-15/E-16 为 E-17 的必需前置 | 门禁已闭合；未有签署证据不得启用 |

可执行性补充已纳入执行计划：E-03 负责文件模型与可独立验证的数据访问，不实现生产 operation recovery/projection；后者由 E-07 完成。E-05 只做只读预检和外部文件协调，不代替 E-13 迁移级恢复。每项任务都有独立定向命令；P/E/G 映射唯一；安全事实、策略、permit、executor 分别指向具体模块和测试。

