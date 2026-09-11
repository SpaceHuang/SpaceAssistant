# Skill 安装体积限制重构 与 云端 Skill 安装入口 — 需求细化说明

**文档类型：** 优化需求细化（待评审，未进入技术设计）
**版本：** 1.0（决策已闭环）
**日期：** 2026-09-11
**状态：** Q1–Q8 决策已全部闭环（见 §8）；待评审通过后进入技术设计与实施计划拆解
**关联需求：** [skills-requirement.md](./skills-requirement.md)、[skill-management-ui-requirement.md](./skill-management-ui-requirement.md)
**关联评审：** [skills-requirement-review.md](../review/skills-requirement-review.md)
**本文评审：** [skill-install-size-limit-and-cloud-install-requirement-review.md](../review/skill-install-size-limit-and-cloud-install-requirement-review.md)
**关联代码：** `electron/skills/`、`src/renderer/components/Config/SkillsTab.tsx`、`src/shared/recommendedSkills.ts`

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-09-10 | 首次整理：体积限制口径错位问题 + 云端（GitHub）Skill 安装入口需求 |
| 1.0 | 2026-09-11 | 经评审修正后定稿；Q1–Q8 决策全部闭环（逐条决议见 §8，汇总见 §0.1） |

---

## 0. 结论速览

| 编号 | 问题 | 结论 | 复杂度 | 阶段 |
|------|------|----------|--------|----------|
| 需求一 | 10 MB 目录体积限制守护的其实是「上下文」，但目录体积与上下文占用无关（只有 `SKILL.md` 会被注入），结果只拦住了大型脚本/资源型 Skill；超限 Skill 还会在扫描时被静默隐藏 | **取消 10 MB 目录体积限制**，改为两条硬限制：`SKILL.md` ≤ 100 KB（守护真实注入内容）+ 目录体积 ≤ 512 MB（守护磁盘与解压炸弹）；另修扫描静默跳过与缓存签名性能 | 小 | Phase 1 |
| 需求二 | 底层已具备「从 GitHub 地址下载并安装 Skill」能力，但仅对内置的 5 条推荐项开放，用户无法粘贴任意仓库地址 | 在设置 → Skill 管理区新增「从 GitHub 安装」入口（URL 输入 + 安装），复用现有 `skill:install-from-url` 链路，补齐 URL 归一化、错误码、体积与超时保护、批量安装事务性与来源元数据 | 中 | Phase 1（直接安装）/ Phase 2（探测预览、进度与事务） |
| **缺陷 A** | front matter 解析器是手写行级实现，不支持 YAML 块标量（折叠式与竖线式两种写法）与嵌套映射。实测：内置推荐项 `minimax-docx` 安装失败，提示「Skill 描述不能为空」 | 换用成熟 YAML 解析器，只读顶层字段；`description` 折叠为单行（详见 §4.4 / §5.7） | 小 | Phase 1 |
| **需求三** | 安装到用户级（`<userData>/skills/`）的 Skill，其随附 `references/` / `scripts/` / `assets/` 对 Agent **既不可见也不可读**：提示词不含路径，读类工具被限制在 `workDir` 内 | 采用 **C3**：注入 Skill 目录绝对路径 + 为读类工具增加 `<userData>/skills/**` 只读白名单（写入类工具不放行）（详见 §5.9） | 中 | Phase 2 |

> 两个需求有耦合点：需求二下载的第三方仓库体积不可控，必须与需求一的分层体积模型一起落地，否则等于给磁盘灌入开了一个无上限入口。

### 0.1 决策汇总（Q1–Q8 全部已闭环，2026-09-11）

| 决策 | 结论 | 影响范围 |
|------|------|----------|
| Q1 | 安装体积上限固定 **512 MB 代码常量**，不进设置页 | §3.1（需求一） |
| Q2 | Phase 1 **先做直接安装**，探测预览放 Phase 2 | §5.1/§5.2（需求二） |
| Q3 | 采用 **C3**：注入 Skill 目录路径 + `<userData>/skills/**` 只读白名单（写入类工具不放行） | §5.9（需求三，Phase 2） |
| Q4 | **暂不支持**私有仓库（token）与非 GitHub 主机，Phase 1 给出明确提示 | §5.2/§5.6（需求二） |
| Q5 | Skill 错误文案**一并迁移**到错误码 + `errors` 命名空间 | §5.3 B9/§5.6（需求一、缺陷 A、需求二） |
| Q6 | 来源元数据**写入进 Phase 1**（随安装原子落盘），消费（覆盖框展示来源、检查更新）留 Phase 2 | §5.3「B10 细化」 |
| Q7 | 上下文预算/截断**不纳入本需求**，登记为后续独立的「Skill 上下文预算」优化项 | §2.5、§10.2.3、§10.3.4 |
| Q8 | front matter 解析采用**方案 A**：引入 `yaml` 运行时依赖 | §5.7、§4.4 |

> 8 项决策中 7 项落在 Phase 1/Phase 2 的交付范围，仅 Q7 出圈为独立后续项。技术设计可直接按本表与 §5 各节展开，无需回读决策过程；过程性论证在 §2、§4、§10。

---

## 1. 背景

### 1.1 现状实现索引

| 位置 | 现状 |
|------|------|
| `electron/skills/skillParser.ts:6` | `SKILL_DIR_MAX_BYTES = 10 * 1024 * 1024`（10 MB） |
| `electron/skills/skillParser.ts:20-55` | `parseSimpleYaml()` 为**手写行级解析器**：完全忽略缩进，不支持 YAML 块标量（折叠与竖线写法均不支持），嵌套映射的键会泄漏到顶层（详见 §4.4） |
| `electron/skills/skillParser.ts:105-123` | `validateSkillDirectorySize()` 递归遍历目录，累加**所有文件**的 `size` |
| `electron/skills/skillParser.ts:152-153` | `readSkillFromDirectory()` 在解析 `SKILL.md` 后立即执行体积校验，超限抛错 |
| `electron/skills/skillScanner.ts:20-27` | 扫描用户级 / 项目级目录时 `try { ... } catch { /* skip invalid skills */ }` —— **校验失败即静默跳过** |
| `electron/skills/skillCache.ts:9-21` | `dirSignature()` 每次缓存校验都**同步递归 stat 整个 Skill 目录树** |
| `src/shared/skillPrompt.ts:3-12` | 注入系统提示的内容**只有 `SKILL.md` 正文**（`skill.content`），不含随附文件 |
| `src/shared/skillPrompt.ts:83-88` | `truncateSystemPrompt()` 按 `maxChars` 截断——**但现有调用点均未传 `maxChars`，实际从不生效**（详见 §2.5） |
| `src/shared/domainTypes.ts:304` / `:312` | `SkillsConfig.maxConcurrent` 字段声明与默认值 `5`（单次会话最多并发加载 5 个 Skill） |
| `electron/skills/skillGithubInstall.ts:18/30/72/119/140` | 已实现：URL 解析、Skill 源目录解析、`codeload.github.com` 下载 tar.gz、`tar` 解压、批量安装 |
| `electron/appIpc.ts:2150-2170` | 已注册 IPC `skill:install-from-url` |
| `electron/preload.ts:160` / `src/shared/api.ts:413` | 已向渲染进程暴露 `window.api.skillInstallFromUrl` |
| `src/renderer/components/Config/SkillsTab.tsx:149-215` | 渲染进程**仅**对 `RECOMMENDED_SKILLS` 的 5 条内置推荐项调用该 API；无任何 URL 输入界面 |
| `src/shared/recommendedSkills.ts` | 推荐列表为静态常量（Superpowers、归藏社交卡片、MiniMax ×3） |

### 1.2 现状行为复现

**场景 A（需求一）：** 用户准备安装一个含 `scripts/`（Python/Node 脚本）、`assets/`（模板、字体）的社区 Skill，目录总体积 30 MB。点击「安装本地 Skill」→ 选择目录 → 报错「Skill 目录总体积超过 10 MB 限制」，安装被拒绝。

**场景 B（需求一）：** 用户已经把同一个 Skill 手动复制进 `<userData>/skills/`。打开设置页 → Skill 列表里**根本看不到它**，也没有任何提示；日志中只有 `skills.load` 的 `skillNames` 少了一项。（`skillScanner` 的 `catch {}` 吞掉了错误。）

**场景 C（需求二）：** 用户想安装 `https://github.com/anthropics/skills` 或任意社区仓库中的某个 Skill。当前 UI 里没有输入框；唯一路径是自行 clone / 下载 zip → 解压 → 再走「安装本地 Skill」选目录。

---

## 2. 问题一：体积限制口径错位（详细分析）

### 2.1 意图与实现的落差

| 维度 | 说明 |
|------|------|
| **设计意图** | 避免过大的 Skill 占据上下文、影响执行效果（限制的守护对象是「上下文」） |
| **实际实现** | 统计 Skill 目录下**所有文件**（含脚本、可执行程序、图片、字体、依赖目录）的字节总和 |
| **真正的上下文入口** | 只有 `SKILL.md` 正文会进入 system prompt（`src/shared/skillPrompt.ts`），且 `SKILL.md` 已有独立的 100 KB 上限（`SKILL_MD_MAX_BYTES`）；注入总量由 `maxConcurrent = 5` 约束，最坏约 500 KB。**注：`truncateSystemPrompt()` 目前不生效**（三个调用点均未传 `maxChars`，详见 §2.5），因此它不是一道真实防线 |

**结论：** 当前 10 MB 目录体积限制**并不能**更有效地守护上下文；它主要拦截的是「体积大的脚本/资源型 Skill」——这类文件根本不会自动进入上下文。

### 2.2 影响面

| 编号 | 影响 | 严重度 | 说明 |
|------|------|--------|------|
| P1 | 大型脚本型 Skill 无法安装 | 高 | 直接命中用户诉求；报错信息只说明「超过 10 MB」，不区分文件类型，用户无法规避 |
| P2 | 已存在的超限 Skill 被静默隐藏 | 高 | `skillScanner` 吞异常导致「装了但看不到」，无从排查；也无法在 UI 中删除/定位 |
| P3 | 用户被迫裁剪 Skill 内容 | 中 | 常见规避手段是删掉示例、资源、脚本，削弱 Skill 本身能力 |
| P4 | 体积统计口径与实际风险不匹配 | 中 | 10 MB 文本内容对一个 100 KB `SKILL.md` 的注入行为没有任何影响，属于误报 |
| P5 | 扫描/缓存性能随目录膨胀而退化 | 中 | `dirSignature()` 在每次 `getCachedSkills()`（即每轮对话路由）时**同步**递归 stat 全树；若放开大目录且含 `node_modules`，将出现主进程卡顿（见 §3.5） |

### 2.3 上下文占用与目录体积无关（证据链）

1. `buildSystemPromptFromSkills()` 只拼接 `skill.content`，即 `SKILL.md` 中 front matter 之后的正文（`src/shared/skillPrompt.ts:3-12`）。
2. `SKILL.md` 本身有 100 KB 硬上限（`electron/skills/skillParser.ts:5,139`）。
3. 单轮注入的 Skill 数量上限 5（`maxConcurrent`），因此最坏情况约 500 KB 注入量。
4. 随附目录（`references/`、`scripts/`、`assets/`）的内容**不会**被自动读取；只有 Agent 通过工具主动读取时才占用上下文（当前工具又被限制在工作目录内，见 §4.3）。

> 上述第 2、3 条是「上下文已被守住」的**全部**依据：`SKILL.md` 100 KB × 并发 5 ≈ 最坏 500 KB。被误认为第三道防线的 `truncateSystemPrompt()` 实际从不生效，已单独记为既有无保护点（§2.5）。

### 2.4 但目录体积仍需保留一条硬上限

目录体积仍有真实的安全与稳定性意义：

- **磁盘占用**：用户级 Skill 目录位于 `userData`，无限制会持续膨胀。
- **解压炸弹 / 恶意仓库**：云端安装会下载并解压第三方 tar.gz，缺少上限时可用小体积归档膨胀出数十 GB。
- **主进程内存**：现状下载阶段用 `await resp.arrayBuffer()` 把归档整包读入内存（见 §4.2 G6），单文件即可撑爆主进程——这条与目录体积无关，但同属「体积无上限」的后果，必须与 L2 一起处理。
- **安装/复制耗时**：`copyDirRecursive()`（`electron/skills/skillInstall.ts`）为递归同步复制，超大目录会长时间阻塞主进程。
- **扫描与缓存成本**：见 §3.5。

因此本需求的方向不是「把限制调大」，也不是「一条都不留」，而是**纠正语义**：删掉口径错误、守护不到任何行为的 10 MB 文本/目录预算，只保留一条守护磁盘的安装硬上限。

### 2.5 本次评审暴露的既有无保护点：`prepare-turn` 未启用截断

| 项 | 事实 |
|----|------|
| 能力定义 | `truncateSystemPrompt(system, maxChars)`（`src/shared/skillPrompt.ts:83-88`）、`skillManager.buildSystemPrompt(skills, maxChars?)`（`electron/skills/skillManager.ts:129-133`）均支持截断 |
| 实际调用 | `electron/appIpc.ts:884`（`chat:prepare-turn`）、`:2064`、`:2125` 三处调用**均未传第二参数**，因此 `maxChars` 为 `undefined`，截断逻辑从未执行 |
| 当前实际上限 | 只有「`SKILL.md` ≤ 100 KB」× 「并发 ≤ 5」，最坏约 500 KB 注入量；无字符级截断 |
| 与本需求的关系 | **既有缺口，不是本需求引入**，但在本次体积讨论中被暴露（曾被视为「上下文兜底」） |
| 风险等级 | 中低：典型 Skill 的 `SKILL.md` 仅数 KB，但最坏情况（5 × 100 KB ≈ 12.5 万 token）对 20 万窗口的模型有实际溢出风险（量化见 §10.2.1）；此外一旦放宽 `SKILL.md` 上限或调高 `maxConcurrent`，缺少截断层会立刻变成实际问题 |

**处理结论（决议 Q7，2026-09-11）：** **不纳入本需求**。理由是它属于运行时注入模型与性能优化，与「安装 / 解析」链路无耦合，混进功能重构会让验收边界模糊。登记为后续独立的「Skill 上下文预算」优化项；详细设计参照 §10.2.3，并推荐先对标 §10.3.4 的 Codex 做法。

---

## 3. 需求一：体积限制重构

### 3.1 限制模型

**模型只保留两条硬限制：**

| 层级 | 常量 | 阈值 | 统计对象 | 超限行为 | 守护目标 |
|------|------------------|----------|----------|----------|----------|
| L1 注入内容上限 | `SKILL_MD_MAX_BYTES` | 100 KB（不变） | `SKILL.md` | **拒绝**（解析失败） | 真正会进入 system prompt 的内容 |
| L2 安装体积上限 | `SKILL_DIR_HARD_MAX_BYTES` | **512 MB（固定值，已决议 Q1）** | 目录内全部普通文件（`lstat`，不跟随符号链接） | **拒绝**（安装与扫描均生效） | 磁盘占用、解压炸弹、复制耗时 |

> **L2 取值决议（Q1，2026-09-11）：** 512 MB **固定为代码常量**，不暴露到设置页、不随用户配置变化。理由：这是一个安全兜底而非产品可调策略，暴露给用户只会增加配置面与「调大后出事故」的可能性；若未来出现确需更高阈值的真实案例，再按案例上调常量即可（改动成本仅一处常量 + 文案）。

**为什么不保留任何形式的「文本体积预算 / 超限告警」：**

1. Skill 目录内**唯一**会被读入上下文的文件是 `SKILL.md` 本身：`electron/skills/skillParser.ts:143` 是全模块唯一的 `readFileSync`；`references/`、`scripts/`、`assets/` 不会被任何代码读取。
2. `directoryPath` 除 `exportSkill`（复制导出）外无任何消费方，不存在「把整个目录拼进 prompt」的隐藏路径。
3. 因此「文本类文件总和 ≤ N」守护不到任何真实行为：低于阈值无收益，超过阈值也无害。若引入，还要维护扩展名黑白名单、区分二进制与文本、渲染体积徽标、新增 i18n 文案与测试——**成本真实、收益为零**。
4. 即便 Agent 将来按需读取参考文档（需求三，§5.9），单次读取仍受 `read_file` 自身的 `READ_FILE_MAX_CHARS` 限制，与目录总体积无关。

**结论：** 只要 `SKILL.md` 100 KB 上限还在，上下文就已被守住；目录侧只需要一条「别把磁盘灌满」的硬上限。

**替代方案（供对比，不推荐）：**

| 方案 | 做法 | 评价 |
|------|------|------|
| 方案 B | 仅把 10 MB 调大（如 200 MB），口径不变 | 改动最小，但「目录体积守护上下文」的语义依然错误，只是把阈值抬高 |
| 方案 C | 完全删除目录体积限制，只保留 `SKILL.md` 100 KB | 上下文守护成立，但失去磁盘/解压炸弹防护，与需求二叠加后风险放大 |

### 3.2 统计口径规则（细化）

1. **遍历范围**：从 Skill 根目录递归，统计所有普通文件字节总和。
2. **计数语义**：使用 `lstat`，符号链接不跟随、不计入；目录本身不计数。
3. **不按扩展名区分**：二进制、媒体、脚本、文本一视同仁——它们对磁盘的占用是一样的（这是 L2 唯一要守护的东西）。
4. **提前终止**：累加过程中一旦超过 L2 上限立即返回失败，避免对大目录做无谓遍历。
5. **实现方式**：保留单一函数 `computeSkillDirSize(dirPath, limitBytes)`，返回 `{ ok, totalBytes, exceeded }`；`SKILL.md` 的体积仍由 `readSkillFromDirectory` 单独校验（L1）。
6. **可选展示**：`SkillDefinition` 可增加只读字段 `totalBytes`，在已安装列表右侧以次要文字显示（如 `32.4 MB`），**不带阈值、不带告警色**，仅作信息展示。

### 3.3 文案与错误信息

| 场景 | 现有文案 | 建议文案 |
|------|----------|----------|
| L1 超限 | `SKILL.md 文件体积超过 100 KB 限制` | 保持不变 |
| L2 超限 | `Skill 目录总体积超过 10 MB 限制` | `Skill 目录体积 {size} 超过 {limit} 安装上限，请确认来源后重试` |

> 现有错误文案为硬编码中文（`electron/skills/skillParser.ts`）。**已决议（Q5）：本次一并迁移到错误码 + `errors` 命名空间**（错误码清单见 §5.3 B9，落地文件见 §6）。

### 3.4 修复「静默跳过」

**现状问题：** `electron/skills/skillScanner.ts:25-27` 的 `catch {}` 使任何解析失败（含体积超限、front matter 损坏、名称不合法）都表现为「该 Skill 不存在」。

**需求：**

1. 扫描结果除有效 Skill 外，额外收集 `skipped: Array<{ dirName: string; scope: SkillScope; reason: string }>`。
2. 主进程写入日志事件（如 `skills.scan.skipped`），字段包含目录名、作用域、原因。
3. 渲染进程在 Skill 管理区展示可折叠提示：「有 N 个 Skill 目录未加载」→ 展开显示目录名 + 原因 + 「打开目录」入口。
4. 至少保证：因**体积**超限被跳过时可被用户看见并自愈（精简后重新扫描即恢复）。

### 3.5 缓存签名性能（必须一并处理）

**现状：** `electron/skills/skillCache.ts:9-21` 的 `dirSignature()` 同步递归 stat 整个 Skill 目录树；该函数在每次 `getCachedSkills()` 时执行，而 `getCachedSkills()` 位于 `skillManager.match()/route()` 的调用路径上（每轮对话都会触发）。

**风险：** 放开体积上限后，一个含 `node_modules` 的 Skill 会让每条消息都产生数万次 `statSync`，主进程明显卡顿。

**建议：**

| 措施 | 说明 |
|------|------|
| 跳过无意义目录 | `dirSignature()` 跳过 `.git`、`node_modules`、`__pycache__`、`.venv`/`venv`、`dist`、`build`、`.next`、`target` 等依赖/构建目录。这是**扫描性能的本地常量**，与 §3.2 的体积统计口径无关——体积统计仍计全部文件 |
| 限制遍历 | 只对顶层子目录取 mtime（Skill 目录只有一层）或设置最大遍历条目数（如 5000），超出则退化为「目录 mtime + 计数」 |
| 异步化（可选） | 若仍偏重，可改为异步 stat 并加节流 |

**验收：** 含 10000 个文件的 Skill 目录存在时，连续 10 轮对话的主进程无明显卡顿；`dirSignature` 单次耗时 < 20 ms（本地 SSD 参考值）。

> 注意：跳过这些目录意味着 `node_modules` 内部变化不会触发 Skill 缓存失效。对 Skill 而言这是期望行为（变更 `SKILL.md` 或 Skill 自身文件仍会失效）。

### 3.6 兼容性与迁移

| 项 | 处理 |
|----|------|
| 已安装的超限 Skill | 新口径下自动恢复可见；无需迁移脚本 |
| 常量重命名 | `SKILL_DIR_MAX_BYTES`（10 MB）→ `SKILL_DIR_HARD_MAX_BYTES`（512 MB）；`validateSkillDirectorySize` 重构为 `computeSkillDirSize(dirPath, limitBytes)` |
| 测试更新 | `electron/skills/skillParser.test.ts` 现有用例不含体积断言，需新增（见 §7） |
| 需求文档更新 | 同步修订 `docs/requirement/skills-requirement.md` §4.3 与 §7.2.3 的校验表 |

### 3.7 需求一验收标准

- [ ] 含 30 MB `scripts/` + `assets/` 的 Skill 可成功安装，安装后出现在已安装列表
- [ ] 该 Skill 的 `SKILL.md` 正文正常进入 system prompt，随附脚本不进入
- [ ] 目录总体积 600 MB（> L2 = 512 MB）时安装被拒绝，提示包含实际上限与当前体积
- [ ] 目录体积 40 MB（含 15 MB 纯文本参考文档）的 Skill 安装成功，**界面不出现任何体积告警**
- [ ] 安装后 Skill 列表中不显示「体积较大」「上下文占用高」之类徽标或提示
- [ ] 手动放入超限 Skill 后不刷新即被隐藏的问题消失；若被跳过，UI 显示原因
- [ ] 含 10000 个文件的目录不影响对话响应（§3.5 验收项）
- [ ] `SKILL.md` > 100 KB 仍被拒绝（L1 行为不变）

---

## 4. 问题二：缺少云端 Skill 安装入口（详细分析）

### 4.1 已有底层能力

| 能力 | 位置 | 状态 |
|------|------|------|
| 解析 GitHub URL → `{ owner, repo, branch, subPath }` | `skillGithubInstall.ts:18-27` | ✅ 已实现 |
| 从 `codeload.github.com` 下载 tar.gz 并解压指定成员 | `skillGithubInstall.ts:72-118`、`119-138` | ✅ 已实现（`main` → `master` 回退） |
| 解析仓库内 Skill 目录（单目录 / `installAll` 批量） | `skillGithubInstall.ts:30-53` | ✅ 已实现 |
| 复制到用户级目录（临时目录 + 原子重命名 + 覆盖） | `skillInstall.ts:40-60`、`62-96` | ✅ 已实现 |
| IPC `skill:install-from-url` | `appIpc.ts:2150` | ✅ 已实现 |
| 渲染进程 API | `preload.ts:160`、`api.ts:413` | ✅ 已实现 |
| UI 入口 | `SkillsTab.tsx:196-215` | ⚠️ 仅限 `RECOMMENDED_SKILLS` 静态列表 |

**结论：** 需求二主要是「暴露既有能力 + 补齐边界」，而非从零实现。

### 4.2 现有能力的缺口

| 编号 | 缺口 | 影响 |
|------|------|------|
| G1 | 无任意 URL 输入界面 | 用户无法安装推荐列表之外的 Skill |
| G2 | URL 解析过窄：不支持 `?query`/`#hash`、末尾 `.git` 之外的变体、`blob/`、SSH 形式、非 GitHub 主机 | 用户从浏览器地址栏复制的 URL（常带 `?tab=readme-ov-file`）会直接报「无效的 GitHub 地址」 |
| G3 | 分支名含 `/` 不支持（正则 `[^/]+`） | `feature/foo` 类分支无法安装 |
| G4 | 无「探测预览」：仓库根无 `SKILL.md` 且未指定 `subPath` 时，直接报「所选路径不是有效的 Skill 目录」 | 多 Skill 仓库（如 `anthropics/skills`）用户不知该填什么 |
| G5 | 无下载/解压/安装进度，无超时 | 大仓库时界面无反馈，用户以为卡死 |
| G6 | 无归档与解压的体积/内存/超时保护：`downloadGithubArchive`（`skillGithubInstall.ts:90`）用 `await resp.arrayBuffer()` **把整个归档读入内存**，无 `AbortSignal` 超时、无大小上限；解压同样无上限 | 三重风险：① 磁盘被灌满（与需求一 L2 耦合）；② **内存炸弹**——单个超大归档即可让主进程 OOM 崩溃；③ 网络挂起时永久等待，界面卡死无反馈 |
| G7 | 批量安装无事务：逐个 `installSkillToUserDir`，中途失败会留下部分结果 | `installAll` 场景可能出现「装了一半」且提示失败 |
| G8 | 错误为中文硬编码字符串 | 英文环境显示中文；UI 无法按错误类型差异化处理（如「未找到 Skill」引导用户改用 `installAll`） |
| G9 | 无来源元数据记录 | 无法实现后续「检查更新 / 重新安装」，用户也无从知道 Skill 来自哪个仓库 |
| G10 | 覆盖确认框不展示来源信息 | 覆盖**不是静默**的：主进程在目标已存在且未传 `overwrite` 时直接报错（`skillInstall.ts:79-81`），前端已有确认弹窗（`SkillsTab.tsx:161-171`）。真实问题是确认框只显示「已存在」错误文本，用户无法判断同名 Skill 是否来自同一仓库、更无法察觉「来源不同但同名」的误覆盖。**Phase 1 先写入 `.skill-source.json` 把来源记录下来（B10），确认框的来源展示在 Phase 2 消费** |

### 4.3 关联缺口：Skill 随附文件对 Agent 不可读（**已决议纳入**，Q3 = C3）

**问题：** 安装到用户级目录的 Skill，其随附文件对 Agent **不可读**。

- 注入系统提示的内容只有 `SKILL.md` 正文，且提示中**不含 Skill 目录路径**（`src/shared/skillPrompt.ts`）。
- `read_file`、`list_directory`、`grep` 等文件工具均被限制在 `workDir` 内（`electron/pathSecurity.ts:50` `resolveSafeWorkDirPath`；越界返回点见 `electron/tools/builtinExecutors.ts:187`（`read_file`）与 `:376`（`list_directory`），错误文案为「路径超出工作目录范围」）。
- 因此 `<userData>/skills/<name>/references/*.md`、`scripts/*.py` 既不会被自动注入，也无法被工具读取；只剩 `run_shell` 使用绝对路径（依赖用户确认）这条窄路。

**后果：** 即使需求一放开了体积限制，大型脚本型 Skill 的脚本/参考文档仍难以被 Agent 真正使用，优化效果会打折扣。

**决议与理由（Q3 = C3，2026-09-11）：** 采纳「注入 Skill 目录路径 + 读类工具只读白名单」，完整硬约束、实现要点与验收标准见 **§5.9**。关键论据是现状存在「能执行、不能读」的倒挂——`run_shell` 的命令串不做路径校验（`shellExecPlan.ts:30-37`），模型一旦知道绝对路径就能执行这些第三方脚本，而读取同样文件却被硬拒绝；把访问挪到「整条命令 + 确认卡兜底」的通道并不比只读白名单更安全。未采纳的备选（C4 脚本执行授权、C5 项目级安装、平台级全盘可读）及其理由见 §10.1.3。

### 4.4 附带缺陷（实测发现）：front matter 解析器不支持 YAML 块标量

**现象：** 安装 `https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-docx`（产品自带推荐项之一）**稳定失败**，提示「Skill 描述不能为空」。用户无法通过更换网络、清理目录或重试绕过。

**上游 front matter（2026-09-11 取自 `raw.githubusercontent.com`）：**

```yaml
---
name: minimax-docx
license: MIT
metadata:
  version: "1.0.0"
  category: document-processing
  author: MiniMaxAI
  sources:
    - "ECMA-376 Office Open XML File Formats"
description: >
  Professional DOCX document creation, editing, and formatting using OpenXML SDK (.NET).
  Three pipelines: (A) create new documents from scratch, ...
  MUST use this skill whenever the user wants to produce, modify, or format a Word document ...
triggers:
  - Word
  - docx
---
```

**复现（已用真实 `readSkillFromDirectory()` 验证，非推断）：** 将上述 front matter 写入临时目录并调用 `readSkillFromDirectory(dir, 'user')`，稳定抛出 `Skill 描述不能为空`；同时 `parseFrontMatter()` 的返回值为 `description: []`。

**根因（`electron/skills/skillParser.ts:20-55`）：** `parseSimpleYaml()` 是自研的逐行解析器，没有缩进感知、没有标量语义：

1. `description: >` 命中 `valueRaw === '|' || valueRaw === '>'` 分支 → `result.description = []`，并把 `currentArrayKey` 设为 `description`（该分支本意是「下面跟着 `- item` 形式的数组」）；
2. 块标量正文既不是 `- item`，也不满足 `^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$`（多数行不含冒号）→ **整段被丢弃**；
3. `validateSkillMeta()` 执行 `String([]).trim()` → 空串 → 抛出「Skill 描述不能为空」。

**影响面：**

| 维度 | 说明 |
|------|------|
| 直接命中产品自带推荐位 | `RECOMMENDED_SKILLS` 中的 `minimax-docx` 今天装不上。`pptx-generator` 使用单行引号写法，不受影响（已核实）；`minimax-xlsx` 未取到（拉取超时），需在实现阶段一并验证 |
| 生态兼容性 | 折叠式与竖线式块标量是 Claude Code / Codex Skill 的主流写法（本机已安装的 72 个 `SKILL.md` 中已有 1 个在用，如 `lark-whiteboard`）。需求二开放任意 URL 后，这类仓库会大面积失败，且失败原因对用户完全不可理解 |
| 与 §3.4 叠加 | 手动放入这类 Skill 同样解析失败，而扫描静默吞异常 → 用户只看到「Skill 不见了」，无法自诊断 |
| 嵌套映射同样不安全 | 缩进被完全忽略：`metadata:` 下的 `version` / `author` 会被当作**顶层**键；实测 `metadata.name` 会**覆盖**真正的顶层 `name`，存在伪造名称的隐患 |

**结论：** 属于既有缺陷，但它正好卡在本次两条需求的必经路径上（内置推荐安装 + 任意 GitHub URL 安装），建议**纳入 Phase 1**，与体积重构同批交付：改动集中在 `skillParser.ts`，与 §3 的工作本就同文件。

**修复方案见 §5.7。**

---

## 5. 配套细化设计（需求二 / 缺陷 A / 需求三 C3）

### 5.1 入口与交互

**入口位置（拟定）：** 设置 → Skill → 「Skill 管理」区块工具栏，在「安装本地 Skill」「打开目录」之外新增一个「从 GitHub 安装」按钮（图标拟用 `link` / `github`，`Tooltip` 文案「粘贴 GitHub 地址安装」）。「已安装」与「推荐」两个 Tab 均可见。

**弹窗（Modal）字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| GitHub 地址 | Input（单行） | 是 | 支持 `https://github.com/{owner}/{repo}` 与 `.../tree/{branch}/{subPath}`；粘贴后自动去空格、去 `?query`/`#hash`、去末尾 `/` |
| 解析预览 | 只读文本 | — | 展示 `owner/repo · 分支 {branch} · 路径 {subPath 或 仓库根目录}`；无法解析时内联红色提示 |
| 检测到的 Skill | 列表（可多选） | — | Phase 2 引入；展示 `name` + `description` + 子路径，默认全选 |
| 安装目录下全部 Skill | Checkbox | — | 等价于现有 `installAll`；未探测时作为显式选项暴露，探测后由选择列表替代 |
| 信任提示 | 静态提示 | — | 「第三方 Skill 的说明会进入对话上下文，并可能包含需要执行的脚本，请仅安装可信来源」+ GitHub 源码链接 |

**按钮：** 「检测」（Phase 2）、「安装」（主按钮，加载中显示 loading 并可取消）、「取消」。

### 5.2 流程

**Phase 1（最小可用）：**

```
打开弹窗 → 粘贴 URL → 前端格式校验
    → 点击「安装」
    → 主进程：归一化 URL → 校验域名白名单
    → 下载 tar.gz（流式落盘 + 内存/磁盘上限 + AbortSignal 超时）
    → 解压（仅提取所需成员）
    → 解析 Skill 源目录（单目录 / installAll）
    → 逐个校验（L1 注入上限 + L2 体积上限）+ 冲突检测
    → 原子复制到 <userData>/skills/
    → 清理临时目录 → 刷新列表 + 高亮 + 成功提示
```

**Phase 2 增加：** 步骤「检测」独立成一个 IPC，返回候选 Skill 列表；安装按用户选择执行；期间通过事件推送进度（下载中 / 解压中 / 安装第 n/m 个）。

**失败与冲突处理：**

| 情况 | 处理 |
|------|------|
| URL 无法解析 | 内联提示，不发起网络请求 |
| 仓库不存在 / 私有 | 提示「仓库不存在或无访问权限（私有仓库暂不支持）」 |
| 网络失败 / 超时 | 提示可重试，保留输入内容 |
| 仓库内未找到 Skill | 提示「该仓库/目录下未找到包含 SKILL.md 的 Skill」，并引导勾选「安装目录下全部 Skill」或填写子路径 |
| 同名已存在 | 复用现有确认弹窗；Phase 2 可在确认框中展示「现有来源 vs 新来源」 |
| 批量安装部分失败 | 提示已成功 n 个 / 失败 m 个及原因；Phase 2 支持全部回滚 |

### 5.3 后端增强清单

| # | 项 | 位置 | 说明 |
|---|----|------|------|
| B1 | URL 归一化 | `skillGithubInstall.ts:parseGithubSkillUrl` | 去 query/hash、末尾 `/`、`.git`、`www.`；支持 `blob/` 时给出「请提供目录地址」的明确提示；分支名允许含 `/`（改用「取 `tree/` 后第一段为分支」的解析策略或显式提示不支持） |
| B2 | 域名白名单 | 同上 | 仅允许 `github.com`（下载域名固定 `codeload.github.com`）；非白名单域名返回 `SKILL_URL_UNSUPPORTED_HOST` |
| B3 | 下载保护 | `downloadGithubArchive` | **替换**现状的 `await resp.arrayBuffer()`（`skillGithubInstall.ts:90`，整包读入内存）：改为 `resp.body` 流式写入临时文件，边写边累计字节数，超限（复用 L2 上限 512 MB）立即 `abort()`；挂 `AbortSignal` 超时（如 120 s）；失败时清理已落盘文件。**内存峰值应与归档大小无关** |
| B4 | 解压保护（**新增**，非保持） | `extractTarGz` | 现状（`skillGithubInstall.ts:119-134`）仅把 `members` 传给系统 tar，代码层**没有任何**路径逃逸或符号链接防护，实际只依赖 bsdtar/GNU tar 的默认行为。需**新增**：① 保留 members 白名单缩小暴露面；② 解压前用 `tar -tvzf` 列出条目（`-v` 才能看到类型标志），拒绝绝对路径、`..` 段、以及**符号链接（`l`）/硬链接（`h`）条目**——tar 内 symlink 可指向归档外，属必须覆盖的逃逸路径；③ 解压后校验落盘结果仍位于目标目录内（`realpath` 包含性检查）——②③ 互补，不依赖 `tar` 自身实现差异；④ 再统计实际字节数并二次校验 L2；⑤ 覆盖上述场景的单元测试 |
| B5 | 体积校验 | 复用 §3.2 | 每个待安装 Skill 执行 L1（`SKILL.md` ≤ 100 KB）与 L2（目录 ≤ 512 MB）校验，超限即拒绝 |
| B6 | 探测接口（Phase 2） | 新增 IPC `skill:probe-github-url` | 入参 `{ sourceUrl }`，出参 `{ ok: true, repo: {...}, candidates: [{ name, description, subPath, totalBytes }] }`（`totalBytes` 用于展示体积与预判是否超 L2，不做阈值告警） |
| B7 | 批量事务（Phase 2） | `installSkillsFromGithub` | 先全部下载/校验到临时区，再原子搬移；任一失败则回滚已搬移项 |
| B8 | 进度事件（Phase 2） | 新增 `skill-install-progress` 事件 | 阶段 + 百分比/计数，渲染进程订阅 |
| B9 | 错误码化 | `skillParser` / `skillGithubInstall` | 错误码清单：`SKILL_URL_INVALID`、`SKILL_URL_UNSUPPORTED_HOST`、`SKILL_REPO_NOT_FOUND`、`SKILL_NETWORK_FAILED`、`SKILL_ARCHIVE_TOO_LARGE`、`SKILL_TAR_UNAVAILABLE`、`SKILL_PATH_NOT_FOUND`、`SKILL_NOT_FOUND_IN_REPO`、`SKILL_NAME_CONFLICT`、`SKILL_MD_TOO_LARGE`、`SKILL_DIR_TOO_LARGE`、`SKILL_FRONT_MATTER_INVALID` |
| B10 | 来源元数据（**写入 Phase 1** / 消费 Phase 2） | `installSkillToUserDir` | URL 安装时在临时目录阶段写入 `.skill-source.json`，随 `renameSync` 一起原子落盘；字段与阶段划分见下方「B10 细化」（体积可忽略，正常计入 L2） |
| B11 | 审计日志 | `agentLogger` | 记录 `skills.install.github` 事件：owner/repo/ref/subPath/结果/耗时（经 `sanitizeForLog` 脱敏，不记录完整 URL 中的潜在敏感参数） |

**B10 细化：`.skill-source.json` 与阶段划分（决议 Q6，2026-09-11）**

**为什么写入要提前到 Phase 1：** 来源信息**只在安装那一刻存在**，事后无法补齐。若 Phase 1 开放任意 URL 安装却不记录来源，那么这一期间安装的所有 Skill 都将永久缺少溯源数据，Phase 2 的「检查更新」对它们无据可依；而覆盖确认框恰恰在 Phase 1 最痛（G10：同名不同源时用户无法判断）。写入的边际成本只是「往临时目录多写一个小文件」。

**Phase 1（写入）：**

```json
{
  "schemaVersion": 1,
  "sourceType": "github",
  "sourceUrl": "https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-docx",
  "owner": "MiniMax-AI",
  "repo": "skills",
  "ref": "main",
  "subPath": "skills/minimax-docx",
  "installedAt": "2026-09-11T13:05:00.000Z",
  "appVersion": "0.1.7"
}
```

| 项 | 规定 |
|----|------|
| 写入时机 | `installSkillToUserDir()` 内：`copyDirRecursive` → 写 `.skill-source.json` 到 `tmpDir` → `renameSync`。与 Skill 一起原子生效，不会出现「装了但没有来源」的中间态 |
| 参数传递 | 该函数新增可选 `source?: SkillSourceMetadata`；由 `installSkillsFromGithub()` 传入。**本地目录安装不传**，因此不产生该文件（保持原有语义） |
| 字段边界 | Phase 1 **不含** `commitSha`（`codeload` 下载 tar.gz 拿不到 commit SHA，需额外调 GitHub API）与 `contentHash`（需额外整目录遍历；若将来要做，可与 §3.2 的体积遍历合并一次完成） |
| 导出行为 | 导出 Skill 时会一并带出该文件（`copyDirRecursive` 全量复制）。内容仅为公开 GitHub 地址，无敏感性，Phase 1 不做剥离处理 |
| 解析影响 | 它是 dotfile，不在 `SKILL.md` 扫描范围内（`skillScanner` 只识别含 `SKILL.md` 的子目录），不影响 Skill 识别与注入 |

**Phase 2（消费）：** 覆盖确认框展示「现有来源 vs 新来源」（解决 G10）；「检查更新 / 重新安装」基于 `owner/repo/ref/subPath` 拉取上游对比。届时如需 `commitSha` 再引入 GitHub API 调用。

### 5.4 安全与信任

| 风险 | 对策 |
|------|------|
| 第三方内容进入 system prompt（提示注入） | 弹窗信任提示；安装后系统提示中可标注 Skill 来源（可选） |
| Skill 携带脚本被 Agent 调用 | 保持现状：安装过程**不执行任何脚本**；脚本执行仍走 `run_shell` 的用户确认链路 |
| 归档路径逃逸 | B4：tar 仅提取指定成员 + 条目预检拒绝绝对路径 / `..` / 符号链接 + 解压后 `realpath` 包含性校验 + 单测覆盖 |
| 磁盘灌满 | B3/B4/B5 的体积上限与超时 |
| 内存炸弹（现状 `arrayBuffer()` 整包读入） | B3：改为流式落盘，内存峰值与归档大小解耦 |
| 覆盖他人来源的同名 Skill | 冲突确认框中展示来源信息（Phase 2，B10） |
| 私有仓库凭据 | 本需求**不支持** token（见 §5.6 Phase 3 与 §8 Q4） |

### 5.5 i18n 文案 key（`config` 命名空间 `skills.*`）

| Key | 含义 |
|-----|------|
| `skills.installFromUrl` / `skills.installFromUrlAria` | 工具栏按钮与 aria |
| `skills.urlModalTitle` | 弹窗标题「从 GitHub 安装 Skill」 |
| `skills.urlLabel` / `skills.urlPlaceholder` | 地址输入框 |
| `skills.urlParsedPreview` | 解析预览（owner/repo/分支/路径） |
| `skills.urlInvalid` / `skills.urlUnsupportedHost` | 格式与域名错误 |
| `skills.urlProbe` / `skills.urlProbeLoading` | 检测按钮与加载 |
| `skills.urlProbeFound` / `skills.urlProbeNone` | 检测结果 |
| `skills.urlInstallAll` / `skills.urlInstallAllHint` | 全部安装选项 |
| `skills.urlTrustWarning` | 信任提示 |
| `skills.urlInstalling` / `skills.urlProgress` | 安装中与进度 |
| `skills.urlPartialFailure` | 部分失败说明 |
| `skills.urlRepoNotFound` / `skills.urlNetworkFailed` | 仓库与网络错误 |
| `skills.scanSkippedTitle` / `skills.scanSkippedReason` | 未加载 Skill 提示（对应 §3.4） |

> **阶段标注：** 表中 `skills.urlProbe*`、`skills.urlProgress`、`skills.urlPartialFailure` 随 Phase 2 的探测与进度能力落地，其余为 Phase 1。

> 新增 key 后需执行 `npm run i18n:generate-types`，并在提交前运行 `npm run i18n:check`（zh-CN 为 key 真源，需同步 en-US）。

### 5.6 阶段划分

| 阶段 | 范围 | 交付判据 |
|------|------|----------|
| **Phase 1** | 需求一完整落地 + 缺陷 A 修复（§5.7 front matter 解析）+ 需求二最小可用（URL 输入弹窗、直接安装、`installAll` 选项、**错误码化与文案迁移（Q5）**、下载流式化 + 解压条目预检 + 体积/超时保护、冲突覆盖复用）+ **来源元数据写入（B10 写入部分）** | 用户可粘贴任意 GitHub Skill 地址完成安装；大型脚本型 Skill 可安装；内置推荐项 `minimax-docx` 可安装；每个 URL 安装的 Skill 都带 `.skill-source.json`。**已知限制：** ① 脚本/参考文档型 Skill 此时仍不可被 Agent 读取（需求三在 Phase 2 补齐）；② 来源信息已记录但尚未在 UI 展示（消费在 Phase 2） |
| **Phase 2** | **需求三（C3 只读访问，§5.9）** + 探测预览与多选安装、进度与取消、批量安装事务/回滚、**来源元数据消费（覆盖框展示来源、检查更新）** | 多 Skill 仓库可交互选择；失败不留半成品；脚本型 Skill 端到端可用（可读随附文件）；同名不同源可辨识 |
| **Phase 3（可选）** | 检查更新的自动升级流程（拉取上游后的一键更新）、私有仓库 token、非 GitHub 主机（Gitee / 自建 GitLab）、Skill 目录内的脚本执行授权（未采纳的 C4） | 视用户诉求单独立项 |

### 5.7 配套修复：front matter 解析（对应 §4.4 缺陷 A）

**方案对比（已决议采用 A）：**

| 方案 | 做法 | 评价 |
|------|------|------|
| **A（✅ 已采纳，2026-09-11）** | 引入成熟 YAML 解析器（`yaml`）解析 front matter，再映射为 `SkillMeta` | 一次性解决块标量、嵌套映射、引号转义、多行字符串；`yaml` 为纯 JS、无原生依赖，与 Electron 打包（`npmRebuild: false`）兼容；需把解析异常转为明确错误码 |
| B（未采纳） | 在 `parseSimpleYaml()` 内特判折叠加竖线两种块标量，按缩进拼接后续行 | 改动小、零新依赖；但嵌套键泄漏（`metadata.name` 覆盖 `name`）等隐患仍在，后续还得补 |
| C（未采纳） | 仅把错误提示改得更明确 | 内置推荐位仍然装不上、任意 URL 安装大面积失败 |

**依赖与打包（方案 A 决议项）：**

| 项 | 结论 |
|----|------|
| 依赖声明 | 新增 `yaml` 到 `dependencies`（**不是** `devDependencies`） |
| 打包验证 | 已核实 `release/win-unpacked/resources/app.asar`（262 MB）头部含完整 `node_modules` 依赖树，说明 electron-builder 会打包生产依赖；`build.files` 虽只列了 `dist*` / `resources/tray` / `package.json`，但生产依赖由 electron-builder 单独解析并入包（现有 `@anthropic-ai/sdk`、`@browserbasehq/stagehand` 等即如此）。新增 `yaml` 走同一路径，无需改 `build` 配置 |
| 影响范围 | 仅主进程 `electron/skills/skillParser.ts` 使用，不进渲染进程产物，不增加前端包体 |
| 版本选择 | 取 `yaml` 当前稳定 2.x；纯 JS、无原生绑定，不影响 `npmRebuild: false` |
| 验证方式 | 实现阶段执行一次 `npm run pack:win` 并确认打包后 Skill 安装功能正常（避免只跑 `dev` 漏检） |

**方案 A 的语义约定（随决议生效）：**

1. **只读顶层字段**：仅取顶层 `name` / `description` / `triggers` / `version` / `author`；`metadata` 等嵌套结构不参与 `SkillMeta` 映射，杜绝覆盖。
2. **`description` 归一化**：块标量解析后折叠为**单行**（换行 → 空格、压缩连续空白），因为该字段用于路由提示与列表展示；同时保留完整描述内容，不做截断。
3. **`triggers` 兼容**：数组与单值两种写法都接受（现状已兼容，保持）。
4. **解析失败可诊断**：非法 YAML / 缺 front matter 走错误码（`SKILL_FRONT_MATTER_INVALID`），而不是复用「描述不能为空」这类误导性文案。当 `description` 键存在但解析结果为空时，提示应为「SKILL.md 的 description 为空或无法解析（若使用块标量写法，请检查缩进）」，便于用户自查。
5. **`name` 校验不变**：小写字母、数字、连字符，1–64 字符的规则与错误文案保持现状。
6. **不改变解析产物**：`readSkillFromDirectory()` 返回的 `content` 仍是 front matter 之后的正文，注入行为不受影响。

**验收标准：**

- [ ] `minimax-docx` 可从推荐 Tab 一键安装成功，安装后列表中描述为**单行非空**文本
- [ ] 折叠式块标量、竖线式块标量、单行引号、单行无引号四种 `description` 写法均能正确解析
- [ ] `metadata.name` 不再覆盖顶层 `name`（回归测试固化）
- [ ] 块标量正文中的缩进、空行、尾随空行按 YAML 语义正确处理
- [ ] 非法 YAML 与缺失 front matter 返回明确错误码与可读提示
- [ ] `electron/skills/skillParser.test.ts` 既有用例（名称格式、triggers 可选等）全部保持通过

### 5.8 需求二验收标准

**可自动化测试（单测 / 集成）：**

- [ ] `parseGithubSkillUrl` 覆盖：带 `?tab=readme-ov-file`、末尾 `/`、`.git`、`/tree/main/a/b`、非 GitHub 域名、`blob/` 路径
- [ ] `resolveSkillSourceDirs` 覆盖：根目录含 `SKILL.md`、`subPath` 命中、`installAll` 批量、无 Skill 时的错误
- [ ] 体积/内存/超时保护：伪造超大归档时中断并报 `SKILL_ARCHIVE_TOO_LARGE`；下载过程内存峰值与归档大小解耦（不受 `arrayBuffer()` 整包读入影响）
- [ ] 归档条目预检：伪造含绝对路径、`..` 段、符号链接条目的归档，均被拒绝且不产生目标目录外的落盘文件
- [ ] 批量安装失败回滚（Phase 2）
- [ ] 错误码 → 文案的映射（渲染层）
- [ ] URL 安装后的 Skill 目录内含 `.skill-source.json`（字段见 §5.3 B10），**本地目录安装不产生该文件**（Phase 1）

**需真实网络：**

- [ ] 安装 `https://github.com/obra/superpowers`（`subPath: skills`，14 个 Skill）成功
- [ ] 安装 `https://github.com/MiniMax-AI/skills/tree/main/skills/minimax-docx`（内置推荐项，缺陷 A 回归）成功，描述显示为单行文本
- [ ] 安装含 `scripts/` 且体积 30–100 MB 的社区仓库成功
- [ ] 超大仓库（> 512 MB）被拒绝且提示可读
- [ ] 不存在的仓库 / 私有仓库返回明确提示

**需真机 UI 验证：**

- [ ] 弹窗交互、解析预览、加载态、取消、成功提示与列表高亮
- [ ] 长耗时安装期间界面可响应（主进程未阻塞）
- [ ] 中文/英文两种语言下无硬编码文案

### 5.9 需求三：Skill 目录只读访问（Q3 = C3，已决议）

**目标：** 让 Agent 能**看到并使用**已安装 Skill 的随附文件（`references/`、`scripts/`、`assets/`），使需求一/需求二的「装得下」真正转化为「用得上」。

**范围与边界（硬约束；决策背景与选项对比见 §10.1）：**

| 项 | 规定 |
|----|------|
| 可读范围 | 仅 `<userData>/skills/**`（用户级）。项目级 `<workDir>/.space-skills/` 本就在 `workDir` 内，无需改动 |
| 生效工具 | 仅 `read_file` / `list_directory` / `grep` |
| 禁止工具 | `write_file` / `edit_file` 及任何写入语义**一律不放行**（白名单只授予读） |
| 路径校验 | 白名单是「额外的允许根」，仍需 `realpath` 包含性校验，防目录内 symlink 逃逸到外部 |
| 不自动执行 | 本需求不授予任何脚本执行权限；执行仍走 `run_shell` 既有确认链路（对应未采纳的 C4） |

**实现要点：**

1. **路径注入**：`buildSystemPromptFromSkills()`（`src/shared/skillPrompt.ts:3-12`）在 Skill 片段中附带其 `directoryPath`，例如：

```
--- Skill: minimax-docx (v1.0.0) ---
[Skill 目录（只读）] <userData>/skills/minimax-docx
{SKILL.md 正文}
```

2. **指令补充**：在 Skill 提示中加入两条使用规则（对齐 §10.3.3 的 Codex 做法）：
   - `SKILL.md` 中的相对路径（如 `scripts/setup.sh`）**相对于该 Skill 目录解析**；
   - 若存在 `scripts/` / `assets/`，优先运行或复用，而不是重新手写大段代码。

3. **读白名单**：`electron/pathSecurity.ts` 的路径解析支持「额外只读根」；`resolveSafeWorkDirPath()` 增加可选参数或在调用侧统一改为「多根解析」。三个读类执行器（`electron/tools/builtinExecutors.ts:185/374/1063` 附近）接入。

4. **上下文来源**：`ToolExecutionContext` 已含 `userDataDir`（`electron/tools/runShellPlan.ts` 用到），Skill 根可直接由 `getUserSkillsDir(userDataDir)`（`electron/skills/skillPaths.ts`）推导，无需新增 IPC 或全局状态。

5. **与激活状态的关系（待实现时确认）**：白名单是「目录级」的——只要用户安装了该 Skill，其目录即可读，不要求本轮已激活。这样模型才能按需查阅，与 §10.3.2 的「渐进式披露」一致；若担忧安全面，可实现为「仅对本地已安装且未被禁用的 Skill 目录生效」。

**非目标：**

- 不授予 Skill 目录的写权限；
- 不在本需求内实现脚本执行授权（C4 建议单独立项）；
- 不改变 `workDir` 作为默认读根的既有行为（白名单是追加，不是替换）。

**验收标准：**

- [ ] 安装 `minimax-docx` 后，Agent 能读取 `<userData>/skills/minimax-docx/SKILL.md` 与 `references/*`，并在回复中引用其内容
- [ ] Agent 能通过 `list_directory` 列出 Skill 目录与其 `scripts/` 子目录
- [ ] `read_file` / `list_directory` / `grep` 对 `<userData>/skills/**` 生效，`workDir` 内行为完全不变
- [ ] `write_file` / `edit_file` 指向 `<userData>/skills/**` 时**仍然被拒绝**
- [ ] Skill 目录内指向外部的 symlink 被拒绝（`realpath` 越界）
- [ ] 提示词中相对路径按 Skill 目录解析（用 `scripts/xxx` 场景做端到端验证）
- [ ] 边界回归测试：目录逃逸、symlink 逃逸、Windows 大小写与分隔符、与 `workDir` 白名单叠加

---

## 6. 影响文件清单

| 文件 | 变更摘要 |
|------|----------|
| `electron/skills/skillParser.ts` | 体积模型重构：`SKILL_DIR_MAX_BYTES`(10 MB) → `SKILL_DIR_HARD_MAX_BYTES`(512 MB)、`computeSkillDirSize`、错误码 |
| `electron/skills/skillParser.ts`（缺陷 A） | front matter 改用 `yaml` 解析器（Q8 已决议方案 A），只读顶层字段、`description` 折叠单行、解析失败错误码 |
| `package.json`（缺陷 A） | `dependencies` 新增 `yaml`（2.x，纯 JS）；无需调整 `build.files` |
| `src/shared/errorCodes.ts`（Q5） | 新增 Skill 相关错误码：`SKILL_URL_INVALID`、`SKILL_REPO_NOT_FOUND`、`SKILL_NETWORK_FAILED`、`SKILL_ARCHIVE_TOO_LARGE`、`SKILL_TAR_UNAVAILABLE`、`SKILL_PATH_NOT_FOUND`、`SKILL_NOT_FOUND_IN_REPO`、`SKILL_NAME_CONFLICT`、`SKILL_MD_TOO_LARGE`、`SKILL_DIR_TOO_LARGE`、`SKILL_FRONT_MATTER_INVALID` |
| `src/renderer/i18n/resources/{zh-CN,en-US}/errors.json`（Q5） | 上述错误码的 zh-CN / en-US 文案（错误码为 key，与既有 `API_KEY_NOT_CONFIGURED` 等同构） |
| `electron/skills/skillScanner.ts` | 返回跳过项与原因，不再静默吞异常 |
| `electron/skills/skillCache.ts` | `dirSignature` 跳过依赖/构建目录 + 遍历上限 |
| `electron/skills/skillInstall.ts` | L2 校验、复制体积保护；**来源元数据写入（Phase 1：`installSkillToUserDir` 新增可选 `source` 参数，写入 `tmpDir` 后随 `renameSync` 原子落盘）** |
| `electron/skills/skillGithubInstall.ts` | URL 归一化、域名白名单、下载/解压保护、探测接口（Phase 2）、批量事务（Phase 2） |
| `electron/skills/skillManager.ts` | `probeFromUrl`（Phase 2）、`installFromUrl` 扩展 |
| `electron/appIpc.ts` | 新增 `skill:probe-github-url`（Phase 2）、进度事件、错误码返回 |
| `electron/preload.ts` / `src/shared/api.ts` | 新增 `skillProbeFromUrl` 等 API 类型 |
| `src/renderer/components/Config/SkillsTab.tsx` | 「从 GitHub 安装」入口 + 弹窗、跳过项（未加载 Skill）提示 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/config.json` | 新增 key（表 §5.5） |
| `src/shared/domainTypes.ts` | `SkillDefinition.totalBytes`（可选，仅作列表展示） |
| `src/shared/skillPrompt.ts`（需求三） | Skill 片段附带目录路径 + 相对路径解析/脚本复用两条使用规则 |
| `electron/pathSecurity.ts`（需求三） | 路径解析支持「额外只读根」（多根白名单） |
| `electron/tools/builtinExecutors.ts`（需求三） | `read_file` / `list_directory` / `grep` 接入只读白名单；写入类执行器保持不变 |
| `electron/tools/*.test.ts`（需求三） | 新增白名单边界回归测试（逃逸、symlink、大小写/分隔符、与 workDir 叠加） |
| `docs/requirement/skills-requirement.md` | 同步修订 §4.3、§7.2.3 |
| `docs/requirement/skill-management-ui-requirement.md` | 新增「任意 GitHub 地址安装」章节 |

---

## 7. 测试策略

| 层 | 测试 | 说明 |
|----|------|------|
| 单元（electron） | `electron/skills/skillParser.test.ts` | 新增：脚本目录 30 MB 安装成功；`SKILL.md` 101 KB 拒绝；600 MB 目录拒绝；符号链接不跟随 |
| 单元（electron） | `electron/skills/skillParser.test.ts`（缺陷 A） | 新增：折叠式/竖线式块标量 `description` 解析；`metadata.name` 不覆盖顶层 `name`；单行引号与无引号写法；非法 YAML 错误码；`minimax-docx` 真实 front matter 快照用例（回归固化） |
| 单元（electron） | `electron/skills/skillGithubInstall.test.ts` | URL 归一化与解析边界、目录解析、流式下载体积上限、解压条目预检（`..`/绝对路径/符号链接）、超时、错误码 |
| 单元（electron） | 新增 `skillInstallTransaction.test.ts`（Phase 2） | 批量安装中途失败回滚 |
| 单元（electron） | 新增 `electron/skills/skillInstall.test.ts`（B10，Phase 1） | URL 安装后 `.skill-source.json` 字段正确；本地安装不产生该文件；写元数据失败时不残留半成品 Skill |
| 单元（renderer） | 新增 `SkillsTab.test.tsx`（可选，当前无该测试文件） | URL 校验、探测结果渲染、错误码映射 |
| 手工 / 真机 | 见 §5.8 | 网络、UI 交互、性能 |

> 按仓库测试纪律：开发过程中只跑定向测试（`npm exec vitest run <file...>`），全量 `npm test` 仅在阶段收尾与提交前执行。

---

## 8. 决策记录（Q1–Q8 已全部闭环）

> 编号保持稳定（评审文件按 Q1–Q6 引用，不回退重排）。当前状态：**Q1–Q8 全部已决议（2026-09-11）**，汇总见 §0.1。

| # | 问题 | 选项 | 建议 |
|---|------|------|------|
| ~~Q1~~ | ~~安装硬上限阈值取多少？是否做成设置项？~~ | — | **已决议（2026-09-11）：512 MB 固定代码常量，不进设置页。** 见 §3.1 取值说明 |
| ~~Q2~~ | ~~需求二 Phase 1 是否必须包含「探测预览」？~~ | — | **已决议（2026-09-11）：先做直接安装（Phase 1），探测预览放 Phase 2。** 前提约束：Phase 1 的错误提示必须能引导用户到正确子路径（如「未找到 Skill，可勾选『安装目录下全部 Skill』或改写为子目录地址」） |
| ~~Q3~~ | ~~是否让 Agent 只读访问用户级 Skill 目录？~~ | — | **已决议（2026-09-11）：采用 C3（注入路径 + 只读白名单），作为需求三纳入 Phase 2。** 硬约束与验收见 §5.9，选项对比见 §10.1.3，Codex 对标见 §10.3.3 |
| ~~Q4~~ | ~~是否支持私有仓库（GitHub token）与非 GitHub 主机？~~ | — | **已决议（2026-09-11）：暂不支持，Phase 1 给出明确提示**（「仓库不存在或无访问权限（私有仓库暂不支持）」）；列入 Phase 3 备选 |
| ~~Q5~~ | ~~是否顺带把 Skill 相关错误文案迁移到错误码 + `errors` 命名空间？~~ | — | **已决议（2026-09-11）：一并做。** 否则英文环境显示中文；落地方式见 §5.3 B9 与 §6 影响文件 |
| ~~Q6~~ | ~~是否记录安装来源元数据（`.skill-source.json`）？~~ | — | **已决议（2026-09-11）：拆分阶段 —— 写入提前到 Phase 1（随安装原子落盘），消费（覆盖框展示来源、检查更新）留 Phase 2。** 理由：来源信息只在安装那一刻存在，事后无法补齐。字段与实现位置见 §5.3「B10 细化」 |
| ~~Q7~~ | ~~是否补上 `chat:prepare-turn` 的 `maxChars` 截断？~~ | — | **已决议（2026-09-11）：不纳入本需求，登记为后续独立的「Skill 上下文预算」优化项。** 属运行时注入模型与性能优化，不放进功能重构（详见 §2.5、§10.2.3、§10.3.4） |
| ~~Q8~~ | ~~front matter 解析采用哪种方案？~~ | — | **已决议（2026-09-11）：方案 A —— 引入 `yaml` 运行时依赖**，语义约定与打包验证见 §5.7 |

---

## 9. 需求边界与非目标

- 不实现 Skill 市场、评分、搜索、分页与远程推荐配置（沿用 `skill-management-ui-requirement.md` §1.3 的非目标）。
- 不改变 Skill 匹配、路由、斜杠命令等运行时行为（体积口径与提示注入除外）。
- 不在安装过程中执行任何第三方脚本或安装依赖。
- 不在本需求内支持项目级作用域安装（沿用现状：本地与云端安装均固定用户级）。
- 不授予 Skill 目录的写权限，也不在 Skill 层新增脚本执行授权（未采纳 C4；脚本执行仍走 `run_shell` 既有确认链路）。
- 不采用 C5（云端安装落到项目级 `.space-skills/`）—— 已通过 Q3 决议排除。
- 不做 Skill 上下文预算/截断（Q7 已出圈为后续独立优化项）。
- 不引入 Skill 内容签名/沙箱机制（如有需要另行立项）。

---

## 10. 附录：Q3 / Q7 展开分析与 Codex 对标调研

### 10.1 Q3 — Agent 只读访问用户级 Skill 目录（已采纳 C3）

#### 10.1.1 现状是「三重断链」，不是单点缺失

| 环节 | 现状 | 代码位置 |
|------|------|----------|
| ① 模型不知道 Skill 在哪 | 注入内容只有 `--- Skill: name (v1.0.0) ---` + 正文，**没有任何路径信息** | `src/shared/skillPrompt.ts:3-12` |
| ② 读类工具拒绝访问 | `read_file` / `list_directory` / `grep` 均以 `workDir` 为根做 `realpath` 包含性校验，越界直接返回「路径超出工作目录范围」 | `pathSecurity.ts:50`；`builtinExecutors.ts:187`（`read_file`）、`:376`（`list_directory`）、`:1063`（`grep`） |
| ③ 唯一可用通道很窄 | `run_shell` 的 `cwd` 固定为 `workDir`，但命令串不做路径校验，理论上能用绝对路径执行——前提是①成立、且 shell 规则/确认流程放行、且该工具未被用户关闭 | `shellExecPlan.ts:30-37`；`src/shared/skillPrompt.ts:buildAvailableToolsHint`（含「run_shell 当前未启用」分支） |

因此要让 Agent 真正用上随附文件，**①与②需要同时解决**：只补①（注入路径），Agent 知道了路径却读不到文件，只能把命令甩给用户；只补②（放开白名单），Agent 依然不知道去哪儿读。（②的替代方案见 §10.1.3 的 C5——安装到项目级可绕开工具层改动。）

**关键不对称（决定本项是否值得做）：** 当前 `run_shell` 只固定 `cwd`，对命令串中的路径**不做校验**（`shellExecPlan.ts:30-37`），仅在确认卡片上提示「路径安全警示」（`ShellConfirmCard.tsx`，i18n `confirm.shell.n`）。也就是说，一旦①成立（模型知道绝对路径），它完全可以用 `bash <绝对路径>/scripts/setup.sh` 去**执行**这些脚本，而**读取**同样这些文件却被硬拒绝。这个「能执行、不能读」的倒挂本身就是不合理的：不加白名单并不会更安全，只是把第三方文件访问挪到了一个更粗粒度（整条命令、靠确认卡兜底）的通道上。

#### 10.1.2 现实案例

`minimax-docx` 的 `SKILL.md` 正文直接要求执行附带脚本：

```
**First time:** `bash scripts/setup.sh` (or `powershell scripts/setup.ps1` on Windows ...)
**First operation in session:** `scripts/env_check.sh` — do not proceed if `NOT READY`.
```

安装后这些脚本位于 `<userData>/skills/minimax-docx/scripts/`。Agent 既不知道这个绝对路径，也无法读取该目录，只能退化为「口述步骤让用户自己在终端执行」——这与「安装即获得能力」的产品预期相去甚远。需求二开放任意 GitHub URL 后，带脚本的 Skill 会越来越多，这个缺口会被持续放大。

#### 10.1.3 选项

| 选项 | 做法 | 收益 | 成本 | 风险 |
|------|------|------|------|------|
| C1 不纳入 | 保持现状 | 无改动 | 0 | 脚本/参考文档型 Skill 装完即废；需求一放开体积的意义被削弱 |
| C2 只注入路径 | Skill 提示里附带 `<userData>/skills/<name>/` 绝对路径 | Agent 可引导用户在终端执行；可用 `run_shell` 绝对路径（需确认） | 极低（一行提示） | 读类工具仍不可用，Agent 看不到 `references/`；提示词被污染风险极低 |
| **C3 注入路径 + 只读白名单（✅ 已采纳，2026-09-11）** | 在 C2 基础上，允许 `read_file` / `list_directory` / `grep` 读取 `<userData>/skills/**`；写入类工具一律不放行 | 参考文档、脚本可读可理解；`run_shell` 执行脚本时路径也已知 | 中（`pathSecurity` 需支持多根白名单并覆盖全部读类工具；补边界测试） | 扩大 Agent 可读范围，属安全边界变更，已确认采纳 |
| C4 C3 + 允许在 Skill 目录执行脚本（未采纳） | 追加 `run_script` / `run_shell` 在 Skill 目录下的执行授权 | 端到端可用 | 高 | 第三方脚本获得直接执行通道，需与确认/信任体系整体设计，**建议单独立项** |
| C5 安装即落到项目级（`.space-skills/`）（未采纳） | GitHub 安装时支持选择「项目级」目标；该目录位于 `workDir` 内，现有工具无需任何改动即可读 | **零安全边界变更、零工具改动**；同时天然支持团队共享（可提交 git） | 中（需要放开作用域选择，与 `skill-management-ui-requirement.md` §1.3 既有非目标冲突） | 技能变成项目级：每个项目都要装一遍，不适合 docx/pptx 这类"装一次全局可用"的通用技能 |

> **为什么选白名单而不是别的：** C3 的「白名单」不是概念上必须，而是「在保持现有 workDir 读模型的前提下改动最小的一条路」。若接受改变作用域语义，C5 可完全绕开 Q3（项目级目录本就在 `workDir` 内，今天就能被 `read_file` 读到）；若接受把读权限放到平台级（Codex 的做法），则是取消 workDir 限制而不是加白名单——那是比 C3 **更大**的安全面变更，不是更小。

> **对标参考（详见 §10.3.3）：** Codex 面对**同构问题**（Skill 位于会话工作目录之外的 `CODEX_HOME/skills/`，且带 `scripts/` / `references/` / `assets/`），其决策是「把 `SKILL.md` 的**绝对路径**交给模型 + 指令要求相对路径按该目录解析 + 交给常规文件/Shell 工具」，**不在 Skill 层另设读白名单**——因为它的沙箱默认「全盘可读、写受限」。SpaceAssistant 的读工具是 workDir 白名单，因此要做就要一次做到 **C3**：只注入路径（C2）在 Codex 的语境下等于「告诉模型路径却不给读权限」，不是它采用的设计。

#### 10.1.4 C3 的安全约束

**硬约束以 §5.9「范围与边界」表为准，本节只记录其决策背景：**

- C3 是「允许读取 `workDir` 之外」的**首个先例**。现有 `wiki` 只读区（`isUnderWikiRaw`）是 `workDir` **内部**的只读约束，不能当作先例引用；因此该决议（Q3，2026-09-11）本质上是一次安全边界扩展，实现时需按 §5.9 逐条守住约束并补齐边界回归测试。
- 「默认放开、可关闭」的取舍（是否做成设置项、是否限定为「已激活 Skill 的目录」）已在 §5.9 实现要点第 5 条登记为待实现时确认项。

---

### 10.2 Q7 — Skill 注入缺少预算与截断（已出圈为独立优化项）

#### 10.2.1 现状的真实上限

| 项 | 事实 |
|----|------|
| 单文件上限 | `SKILL.md` ≤ 100 KB（`skillParser.ts:5,139`），注意单位是**字节** |
| 单轮并发上限 | `maxConcurrent = 5`（`domainTypes.ts:304,312`） |
| 理论最坏注入量 | 5 × 100 KB ≈ **500 KB**；英文（1 字节/字符）约 50 万字符 ≈ 12.5 万 token；中文（UTF-8 3 字节/字）约 16 万字符 ≈ 10 万 token 量级 |
| 典型实际情况 | 常见 Skill 的 `SKILL.md` 在 3–15 KB，5 个约 4–19K token，压力不大 |
| 截断兜底 | `truncateSystemPrompt()` 存在但**三个调用点都没传 `maxChars`**，从不生效（`appIpc.ts:884/2064/2125`） |
| 模型上下文 | 产品内置模型 `maximumContext` 为 20 万–100 万 token（`domainTypes.ts:805-814`），最小的是 `claude-haiku-4-5`（20 万） |
| 关键事实 | `maximumContext` **仅用于上下文占用估算与展示**（`contextUsageEstimate.ts`），未参与任何请求侧预算控制；历史消息按 `contextBoundarySequence` 截断（`claudeStreamHandlers.ts:60`），也不是按 token 预算 |

**结论：** 风险不是「每天都爆」，而是「唯一没有预算保护的输入通道」。工具结果有 `MAX_TOOL_RESULT_CONTENT_CHARS` 与 `oversizedToolResult` 压缩兜底，历史有 boundary 机制，唯独 Skill 注入是"给了多少就塞多少"。一旦用户装了 5 个文档型大 Skill（尤其是 `alwaysLoad`），叠加历史与图片后，对 20 万窗口的模型是有实际溢出风险的。

#### 10.2.2 现有 `truncateSystemPrompt()` 的语义问题

它是**字符串截断**：把拼接好的整段 system prompt 从头部切到 `maxChars`，末尾补一句「Skill 内容已截断以适配上下文窗口」。问题在于：

- 拼接顺序中的最后一个 Skill 会被**从中间切断**，留下半截规则；
- 该 prompt 的开头写的是「请严格遵循」，半截规则比「完全不加载该 Skill」更容易误导模型；
- 因此它只适合做**最后一道防线**，不适合作为唯一策略。

#### 10.2.3 供后续优化项参考的设计建议

| # | 设计点 | 建议 |
|---|--------|------|
| 1 | 预算来源 | 由路由命中的模型 `maximumContext` 推导（如取 5%–10%），并设硬上限（如 10 万字符），避免魔法常量 |
| 2 | 丢弃粒度 | **按 Skill 整体丢弃**（保留 project > user 与匹配顺序），而不是切字符串 |
| 3 | 优先级 | `alwaysLoad`（用户显式要求）> 手动激活 > LLM/关键词匹配命中 |
| 4 | 兜底 | 保留 `truncateSystemPrompt()` 作为最后防线，处理"单个 Skill 本身就超预算"的极端情况 |
| 5 | 可见性 | 被丢弃的 Skill 必须可见：复用现有 `[Skill]` 提示通道（`formatSkillRouteHint`，渲染为 `SkillHintRow`），显示「部分 Skill 因上下文预算未加载」 |
| 6 | 回归测试 | 覆盖「5 个各 100 KB」「单个超预算」「alwaysLoad 优先保留」三类边界 |

#### 10.2.4 决议：拆为独立优化项

**已决议（Q7，2026-09-11）：不纳入本需求**，作为后续独立的「Skill 上下文预算」优化项推进。理由：

1. 它改的是 `chat:prepare-turn` 的运行时分发路径，属于**运行时行为变更**，与本需求的「安装 / 解析」链路无耦合；混做会让 Phase 1 的验收边界模糊（「装不装得上」与「注入了多少」是两类验收）。
2. 需要产品决策：丢弃粒度（整体 vs 局部）、预算取值、可见性文案，都需要单独拍板。
3. 现状实际暴露面有限（典型 Skill 只有几 KB），因此**不阻塞** Phase 1 交付。

本节其余内容作为该后续优化项的设计输入保留。

---

### 10.3 对标调研：Codex 如何实现 Skill（含 Q3 同类问题的决策）

**调研对象：** `F:\Develop\codex\codex-rs\skills`（核心 crate）与 `F:\Develop\codex\codex-rs\ext\skills`（扩展层）。

#### 10.3.1 目录、安装与扫描

| 维度 | Codex 做法 | 代码位置 |
|------|-----------|----------|
| 存放位置 | `CODEX_HOME/skills/`（用户/插件），内置样例编译进二进制后落到 `CODEX_HOME/skills/.system` | `lib.rs:install_system_skills` |
| 增量安装 | 用「目录内容指纹 + marker 文件」判断是否需要重写，避免每次启动都全量落盘 | `lib.rs:embedded_system_skills_fingerprint` |
| Skill 结构 | `SKILL.md` + `references/` + `scripts/` + `assets/` + 可选 `agents/openai.yaml` | `src/assets/samples/*` |
| 界面元数据 | `agents/openai.yaml` 提供 `display_name` / `short_description` / `icon_small|large` / `brand_color` / `default_prompt`，图标路径强制限定在 `assets/` 内 | `interface.rs` |
| 扫描边界 | `MAX_SCAN_DEPTH = 6`、`MAX_SKILLS_DIRS_PER_ROOT = 2000`；**没有任何 Skill 目录体积上限** | `loader/mod.rs:31-32` |

> 对照结论：Codex 用「深度 + 数量」限制扫描成本，而不用「目录体积」限制——这与我们在 §3.1 决定取消 10 MB 目录体积限制、只保留 1 条磁盘安全上限的判断一致（参考实现并未用目录体积守护上下文）。

#### 10.3.2 注入策略：常驻「目录（catalog）」+ 选中 Skill 注入正文

1. **常驻上下文的是一份 catalog**：每个 Skill 一行「名称 + 描述 + 短路径/来源定位符」，另附 `### Skill roots` 别名表（短路径 → 绝对根目录）。catalog 的引导语明确说「每个条目包含名称、描述，以及可用 `### Skill roots` 展开为绝对路径的短路径」。
2. **只有被选中的 Skill 才注入正文**，片段结构为：

```
<skill>
<name>{name}</name>
<path>{SKILL.md 的绝对路径}</path>
{SKILL.md 正文}
</skill>
```

3. **把「渐进式披露（progressive disclosure）」写进指令**：先完整读 `SKILL.md` 再动手；只按 `SKILL.md` 的路由说明读必需的引用文件；明确禁止加载无关的 `references/`、`scripts/`、`assets/`。

代码位置：`catalog_prompt.rs`（catalog 文案与别名说明）、`fragments.rs`（`<skill>` 片段渲染）、`host_prompt.rs`（读取选中 Skill 正文）。

#### 10.3.3 Q3 同类问题：Codex 怎么让 Agent 用上 Skill 目录里的脚本与参考文件

Codex 面对的问题与我们**完全同构**：Skill 位于 `CODEX_HOME/skills/`，在会话工作目录**之外**，且同样带 `scripts/`、`references/`、`assets/`。它的决策可以概括为一句话：

> **把绝对路径交给模型，然后用模型的常规文件/Shell 工具去读写，不在 Skill 层另设读白名单。**

三处落点：

| # | 落点 | 具体做法 |
|---|------|----------|
| ① | 路径进上下文 | 选中 Skill 的片段里带 `<path>`（`SKILL.md` 绝对路径） |
| ② | 相对路径解析规则写进指令 | 「当 `SKILL.md` 引用相对路径（如 `scripts/foo.py`）时，**先相对于该 `SKILL.md` 所在目录解析**」；「若存在 `scripts/`，**优先运行或修改脚本**，而不是重新手写大段代码」；「若存在 `assets/` 或模板，复用而不是重建」 |
| ③ | 工具层不额外设白名单 | 宿主 Skill 直接走模型的文件/Shell 工具；沙箱策略约束的是**写**（`SandboxMode: read-only / workspace-write / danger-full-access`），读权限由文件系统策略决定并存在 `has_full_disk_read_access()` 这一概念，仅对敏感路径加 deny 规则。因此"暴露路径"就足以让模型读到 Skill 目录 |

对**非宿主**来源（executor / orchestrator / custom，例如远端执行环境里的包），另设 `skills.read` 工具：入参 `package` + `resource`（完整 `skill://` 标识），返回内容外还回传 `skill_root`（该 Skill 的绝对目录）用于定位随附脚本，并通过 `next_cursor` 支持分页。

**对我们的直接启示：**

- 我们与 Codex 的唯一关键差异在**工具层**：Codex 的读能力是平台默认「全盘可读 + 敏感路径 deny」，而 SpaceAssistant 的 `read_file` / `list_directory` / `grep` 是 **workDir 白名单**。因此我们不能只做 C2（只注入路径），C2 在 Codex 语境下等于「告诉模型路径却不给读权限」，Codex 自己不会这么设计；**要做就应该一次做到 C3（注入路径 + 读白名单）**。
- Codex 的 catalog 常驻机制同时解决了两件事：模型能发现未匹配的 Skill、并可按需读取其 `SKILL.md`，从而不必一次性注入所有正文——这也正是 §10.2 提到的 Q7 的正解方向。

#### 10.3.4 上下文预算：Codex 对应的做法（对应 Q7）

| 机制 | 数值 / 行为 | 代码位置 |
|------|-------------|----------|
| 主 prompt 内正文截断 | `MAX_SKILL_PROMPT_BYTES = 8_000`（8 KB）；截断时产生**显式 warning**「Skill `X` exceeded the main prompt context limit and was truncated.」 | `render.rs:19,1176`、`host_prompt.rs` |
| `skills.read` 单次响应上限 | `MAX_SKILL_RESPONSE_BYTES = 512 KB`，超长通过 `next_cursor` 分页继续读 | `tools/mod.rs:56`、`tools/read.rs` |
| 单个资源上限 | `MAX_SKILL_RESOURCE_CONTENT_BYTES = 1 MB` | `provider.rs:30` |
| 载入失败 | 不中断会话，转成 warning 收集后返回 | `host_prompt.rs` |

**结论：** Codex 把「Skill 内容进入上下文」当作**受预算约束的读取事件**来处理（catalog 常驻 + 选中才注入 + 分页/截断 + 显式告警），而不是一次性拼接。这与 §10.2.3 给 Q7 的设计方向一致，也进一步说明它适合作为一个**独立的注入模型优化**来做——不是加一个 `maxChars` 那么简单。这与「Q7 不放进本次功能重构」的决议一致。

#### 10.3.5 其他可借鉴点（均不在本需求范围内）

| 项 | Codex 做法 | 参考价值 |
|----|-----------|----------|
| Catalog 常驻 | 全量 Skill 的 name + description + locator 常驻上下文 | 让模型按需发现与读取，而不是靠路由命中才可见（与 Q7 一并考虑） |
| 同名 Skill | `build_skill_name_counts` 生成 qualified name | 我们目前同名时项目级静默覆盖 |
| 隐式调用策略 | `SkillPolicy.allow_implicit_invocation` / `products` 门控 | 对应我们的 `disabled` / `autoDetect` |
| 界面元数据 | `agents/openai.yaml`（图标、品牌色、默认提示词） | 我们的推荐列表仍是静态常量 `RECOMMENDED_SKILLS` |
| 内置 Skill 分发 | 编译进二进制 + 指纹增量落盘 | 我们的 bundled Skill 是代码里的字符串常量 |

---

*本文档为需求细化草案，评审通过后再拆解为技术设计与实施计划。与 [skills-requirement.md](./skills-requirement.md)、[skill-management-ui-requirement.md](./skill-management-ui-requirement.md) 冲突时，以评审通过后的新版本为准。*
