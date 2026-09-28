# GitHub Skill 安装：多层级目录结构发现 — 改进需求

**文档类型：** 优化需求细化（待复审，未进入技术设计）
**版本：** 1.4
**日期：** 2026-09-12
**状态：** v1.0/v1.3 评审的 **3 项阻断问题（B-1、B-2、B-3）**与 **7 项必须修正项（M-1~M-7）**均已闭环；评审建议项（S-1~S-4）已纳入；**Q1–Q12 决策已全部闭环**（Q9–Q11 于 v1.2、Q1/Q2 于 v1.3、Q12 于 v1.4）；**无遗留待确认项**，待复审确认后进入技术设计
**关联需求：** [skills-requirement.md](./skills-requirement.md)、[skill-management-ui-requirement.md](./skill-management-ui-requirement.md)、[skill-install-size-limit-and-cloud-install-requirement.md](./skill-install-size-limit-and-cloud-install-requirement.md)
**关联评审：** [skill-github-nested-directory-discovery-requirement-review.md](../review/skill-github-nested-directory-discovery-requirement-review.md)、[skill-github-nested-directory-discovery-requirement-review-v1.3.md](../review/skill-github-nested-directory-discovery-requirement-review-v1.3.md)、[skill-github-nested-directory-discovery-requirement-review-v1.3-r2.md](../review/skill-github-nested-directory-discovery-requirement-review-v1.3-r2.md)
**关联代码：** `electron/skills/skillGithubInstall.ts`、`electron/skills/skillInstall.ts`、`electron/skills/skillParser.ts`、`electron/skills/skillManager.ts`、`electron/appIpc.ts`、`electron/preload.ts`、`src/shared/api.ts`、`src/shared/errorCodes.ts`、`src/shared/domainTypes.ts`、`src/shared/recommendedSkills.ts`、`src/renderer/components/Config/SkillsTab.tsx`、`src/renderer/utils/planGithubInstall.ts`（新增）、`src/renderer/utils/formatUserFacingError.ts`、`src/renderer/i18n/resources/{zh-CN,en-US}/{config,errors}.json`

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-09-12 | 首次整理：GitHub 安装的 Skill 目录发现深度不足，导致插件市场型仓库「装不上」或「静默装错」 |
| 1.1 | 2026-09-12 | 按评审修订：**B-1** 新增候选校验降级策略（§5.6）与同名冲突降级策略（§5.7）；**B-2** 补齐截断标志与接口契约（§5.3、§5.5、§5.10）；**M-1** 统一决策编号为单一体系（§0.1 与 §11 对齐）；**M-2** 明确容器预检结果复用（§5.2、§5.3）；**M-3** 理清主进程文案与 i18n 映射分工（§5.9）；**M-4** 收敛缺陷 A 的影响论断（§5.8）；纳入 S-1~S-4 |
| 1.2 | 2026-09-12 | **Q9–Q11 决策闭环（三项均采纳方案 A）**：探测结果保留 `invalid` 候选并展示原因（Q9）；同名覆盖采用「默认不勾 + 一键全选覆盖」而非逐个选择（Q10）；探测接收 `userDataPath` 以预判同名（Q11）。补充两个边角：覆盖对象 N > 1 时二次确认、候选全部同名时的零选择提示（§5.7、§5.11） |
| 1.3 | 2026-09-12 | **Q1、Q2 决策闭环**：搜索深度定为 **3 层**（自搜索根起算，覆盖 `plugins/<plugin>/skills/<name>/`）；容器优先采用**严格不回落**（容器有命中时不再扫描容器外目录，以排除 `template/` 类根目录散落物）。至此 Q1–Q11 全部闭环，无遗留待确认项 |
| 1.4 | 2026-09-12 | **B-3 阻断项闭环（Q12）**：核实 UI 安装主流程为「逐候选循环 + 首个失败即 `return` + 从不传 `overwrite` + 零勾选退化为 `installAll=true` 整仓安装」的现状事实（`SkillsTab.tsx:229-242`），并据此把安装入口改为**批量入参 `subPaths: string[]`**（一次下载解压 + 批量逐候选降级），使 §5.6/§5.7 的 `skipped`/`overwritten` 语义对 UI 主流程真实生效；补齐三条 UI 链路契约（零勾选拦截、勾选同名 ⇒ 本次 `overwrite: true`、候选与 URL 绑定）；**M-5** 明确安装侧 `status` 现算（探测状态仅供 UI）；**M-6** 明确探测预判仅为 UI 提示并新增覆盖回执；**M-7** 拆分 A12；新增 A23/A24 与批量 fixture |

---

## 0. 结论速览

| 编号 | 问题 | 结论 | 复杂度 | 阶段 |
|------|------|----------|--------|----------|
| 需求一 | `resolveSkillSourceDirs` 只检查「给定目录本身」和「直接子目录」两层，主流**插件市场型仓库**（Skill 位于 `skills/<name>/`、`plugins/<plugin>/skills/<name>/`）一律发现不了，报 `SKILL_NOT_FOUND_IN_REPO` | 把发现逻辑升级为**容器优先 + 有界广度优先搜索**：优先在约定容器 `skills/` 内发现，容器缺失或无命中则回落到有界 BFS；命中即剪枝（不再下探 Skill 子树） | 中 | Phase 1 |
| 缺陷 A | 同一次发现的**多个** Skill 共用同一份来源元数据，`.skill-source.json` 的 `subPath` 写入的是 URL 里的路径而非各自实际路径。`installAll` 场景下 14 个 Skill 会全部记为 `subPath: "skills"` | 元数据改为写入**解析后的实际相对路径**（`path.relative(extractedRepoRoot, sourceDir)`）；影响面限定为「来源链接指向仓库首页而非 Skill 目录」+「阻断未来的更新检查能力」（详见 §5.8） | 小 | Phase 1 |
| **缺陷 B（更严重）** | 直接子目录扫描会产生**假阳性**：`anthropics/skills` 根目录下唯一含 `SKILL.md` 的直接子目录是 `template/`，探测返回的唯一候选就是 `template`。用户一键装到的是**模板骨架**，19 个真实 Skill 一个都没装，且**全程无任何提示** | 容器优先规则消除该假阳性（`skills/` 容器存在时只在容器内发现）；同时 UI 候选列表补充相对路径次级信息，避免用户误选同名候选 | 小 | Phase 1 |
| **B-1（评审阻断项）** | 发现放大到 14–28 个候选后，`validateSkillSourceDir` 是 `map()` 整体执行，**任一候选非法即炸掉整个探测 / 安装**；同类问题也存在于同名冲突检查（`SKILL_NAME_CONFLICT` 整体抛错）。等于把「假阴性」换成了「整仓不可用」 | 定义**逐候选降级**：非法候选跳过并在结果中标记原因，同名候选不阻断其余候选；仅当**全部候选都不可用时**才抛错；显式 `subPath` 精确安装路径保持整体抛错（详见 §5.6、§5.7） | 中 | Phase 1 |
| **B-2（评审阻断项）** | §5.3 伪代码只 `return results`，无法区分「恰好 100 个」与「被截断在 100 个」；截断标志要到达 UI 必须改动 IPC 契约，而 v1.0 的文件清单漏了 `electron/preload.ts` 与 `src/shared/api.ts` | 定义 `DiscoveryResult` 返回值结构，用「发现第 N+1 个候选才置位」判定截断；补齐接口契约变更清单（详见 §5.3、§5.5、§5.10） | 小 | Phase 1 |
| **B-3（评审阻断项）** | 降级与覆盖语义只按 `installAll` 批量路径设计，而 UI 主流程是**逐候选循环安装**（N 次 IPC、传显式 `subPath`、首个失败即 `return`、从不传 `overwrite`）。§5.6 的「显式 `subPath` 整体抛错」恰好命中主流程，`invalid`/`name-conflict` 降级**永不生效**，A18/A21 无法达成；且零勾选会经 `[undefined]` 兜底退化为 `installAll=true` **整仓安装**（与用户意图相反）；逐候选循环还会造成 N 次仓库下载/解压 | `skillInstallFromUrl` 新增**批量入参 `subPaths: string[]`**：一次下载解压 + 批量逐候选降级，`skipped`/`overwritten` 语义对主流程真实生效，同时消除 N 次重复下载；UI 主流程改为单次批量调用，并补齐「零勾选拦截」「勾选同名 ⇒ 本次 `overwrite: true`」「候选与 URL 绑定」三条链路契约（详见 §5.6、§5.7、§5.10、§5.11、§11 Q12） | 中 | Phase 1 |
| 需求二 | 容器优先会**主动放弃**容器外的 Skill（如 `plugins/<plugin>/skills/<name>/`），这是一处有意的取舍，需要可解释的出口 | 文档化该取舍；出口是「粘贴更深层的目录 URL」（现有能力，不变） | — | Phase 1 |
| 需求三 | 根 URL 安装会**整树解压 + 整树遍历**。仓库越大，探测越慢，且整树仍需满足 512 MB 限制 | Phase 1 保持整树解压（行为不变）；Phase 2 用**解压前已有的 `tar -tvzf` 清单**预扫 SKILL.md 路径，实现「免解压探测 + 精准解压」，同时解除整树体积对探测的干扰；并入 S-1 的探测结果缓存（详见 §5.12） | 中 | Phase 2 |

> 需求一是本需求的主线；缺陷 A、缺陷 B、B-1、B-2、B-3 是同一处改动必然触达的连带修正，建议一并落地。

### 0.1 决策汇总

**编号体系与 §11 完全一致，以 §11 为唯一权威。** 本表仅摘录结论，展开论证见 §11。**Q1–Q12 已全部闭环。**

| 决策 | 结论 | 影响范围 |
|------|------|----------|
| Q1 | **（已定）**`MAX_DISCOVERY_DEPTH = 3`（自搜索根起算的目录层级） | §5.3 |
| Q2 | **（已定）容器优先且严格不回落**：`base/skills/` 有命中时只在容器内发现，不再扫描容器外目录 | §5.2、§5.3 |
| Q3 | 忽略所有以 `.` 开头的目录，另加依赖/构建产物黑名单 | §5.4 |
| Q4 | `MAX_CANDIDATES = 100`、`MAX_VISITED_DIRS = 2000`；触顶**截断并显式提示**，不静默丢弃 | §5.5 |
| Q5 | 命中即剪枝：目录含 `SKILL.md` 后不再下探其子树 | §5.4 |
| Q6 | 来源元数据修正纳入 Phase 1（缺陷 A） | §5.8 |
| Q7 | 候选默认**全选**（沿用现状，但仅对 `status === 'ok'` 候选生效） | §5.5、§5.11 |
| Q8 | 不改动 `parseGithubSkillUrl` 的 URL 语义，不改动 `buildGithubArchiveExtractMembers` 的选择性解压行为 | §7 |
| Q9 | **（方案 A，已定）候选校验失败降级**：非法候选跳过、**保留在探测结果中**并标记原因，不阻断其余候选；全部不可用才抛错；显式 `subPath` 路径除外 | §5.6 |
| Q10 | **（方案 A，已定）同名冲突降级**：同名候选不阻断其余候选、**默认不勾选**；覆盖走「一键全选 + 覆盖重装」，**不做逐个选择** | §5.7 |
| Q11 | **（方案 A，已定）探测结果契约扩展**：候选带 `status`/`reason`，结果带 `truncated`/`visitedTruncated`；探测**接收 `userDataPath`** 以预判同名 | §5.10 |
| Q12 | **（方案乙，已定）安装入口改为批量**：`skillInstallFromUrl` 新增 `subPaths: string[]`（保留 `subPath` 供推荐位/深链精确安装），UI 主流程单次批量调用；覆盖语义收敛为「本次调用级 `overwrite` 布尔」 | §5.6、§5.7、§5.10、§5.11 |

---

## 1. 背景

### 1.1 现状实现索引

| 位置 | 现状 |
|------|------|
| `electron/skills/skillGithubInstall.ts:21` | `parseGithubSkillUrl()` — 解析 `github.com/<owner>/<repo>[/tree/<branch>[/<subPath>]]`，默认分支 `main`，拒绝 `blob` 地址与 `..` 路径 |
| `electron/skills/skillGithubInstall.ts:35` | **`resolveSkillSourceDirs()` — 本需求的瓶颈**：先判 `base/SKILL.md`，`installAll` 时再看 `base` 的**直接子目录**，两者皆无则抛 `SKILL_NOT_FOUND_IN_REPO` |
| `electron/skills/skillGithubInstall.ts:70` | `buildGithubArchiveExtractMembers()` — 有 `subPath` 时只解压 `root/<subPath>` 子树，否则解压整个 `root` |
| `electron/skills/skillGithubInstall.ts:145` | `validateExtractedTree()` — 解压后校验目录越界（realpath 逃逸）与整树 ≤ 512 MB |
| `electron/skills/skillGithubInstall.ts:162` | `validateTarListing()` — 解析 `tar -tvzf` 清单，拒绝绝对路径 / `..` / 符号链接 / 硬链接 |
| `electron/skills/skillGithubInstall.ts:203` | `installSkillsFromGithub()` — 下载 → 解压 → 发现 → 校验 → 落盘；来源元数据统一写入 `subPath` |
| `electron/skills/skillGithubInstall.ts:228` | **`sourceDirs.map((dir) => validateSkillSourceDir(dir))` — B-1 问题点（安装侧）**：任一候选非法即整体抛错 |
| `electron/skills/skillGithubInstall.ts:229-231` | 同名冲突检查：`conflicts.length > 0` 即整体抛 `SKILL_NAME_CONFLICT`（B-1 同族问题） |
| `electron/skills/skillGithubInstall.ts:262` | `probeGithubSkillUrl()` — 探测预览，内部同样调用 `resolveSkillSourceDirs(root, subPath, true)`，**与安装路径共享同一处瓶颈** |
| `electron/skills/skillGithubInstall.ts:270-272` | **`dirs.map(validateSkillSourceDir)` — B-1 问题点（探测侧）**：任一候选非法即整体抛错 |
| `electron/skills/skillParser.ts:6-8` | `SKILL_MD_MAX_BYTES = 100 KB`、`SKILL_DIR_HARD_MAX_BYTES = 512 MB`、`NAME_PATTERN = /^[a-z][a-z0-9-]*$/` |
| `electron/skills/skillParser.ts:15/144/150/152/158/188` | 校验错误以**裸中文文案**抛出（无错误码前缀），详见 §5.9 |
| `electron/skills/skillInstall.ts:93` | 同名冲突抛裸文案「用户级目录下已存在 Skill「X」」（无错误码），UI 侧靠 `includes('已存在')` 字符串匹配识别 |
| `src/shared/api.ts:411` | `skillProbeFromUrl` 的返回类型**内联**在此（B-2 遗漏点） |
| `electron/preload.ts:158` | `skillProbeFromUrl` 通道（B-2 遗漏点） |
| `electron/appIpc.ts:2170` | `skill:install-from-url` 的返回类型**内联**在此（B-2 遗漏点） |
| `src/renderer/components/Config/SkillsTab.tsx:250` | `onProbeGithub()` — 探测后把**全部**候选的 `subPath` 置为已选 |
| **`src/renderer/components/Config/SkillsTab.tsx:229-242`** | **`onInstallGithub()` — UI 安装主流程是「逐候选循环」**：对每个已选候选各发一次 `skillInstallFromUrl`（N 个候选 = N 次仓库下载 + 解压）；`:237` **首个失败即 `return`**（fail-fast，其余已勾选候选不再安装）；`:236` **从不传 `overwrite`** |
| `src/renderer/components/Config/SkillsTab.tsx:236` | `skillInstallFromUrl({ subPath, installAll: !subPath })` — 有 `subPath` 走精确安装（`installAll=false`），无 `subPath` 走「安装全部」 |
| `src/renderer/components/Config/SkillsTab.tsx:233` | `const paths = githubSelectedPaths.length ? githubSelectedPaths : [undefined]` — **零勾选经 `[undefined]` 兜底退化为 `installAll: true` 整仓安装**（本需求必须显式处理的边界，见 §5.7） |
| `src/renderer/components/Config/SkillsTab.tsx:160-170` | 推荐位专用 `installFromUrl(entry, overwrite = false)` — **只有推荐位路径会传 `overwrite`**，GitHub 弹窗路径不传 |
| `src/renderer/components/Config/SkillsTab.tsx:112-117、:373-377` | 候选状态与 URL 状态彼此独立：修改 `githubUrl` **不会清空** `githubCandidates`，候选未与探测时的 URL 绑定 |
| `electron/appIpc.ts:2165-2185` | `skill:install-from-url` 入参只有**单个** `subPath`，返回 `{ ok, skills }`，无 `skipped` / `overwritten` 通道（B-3 的契约缺口） |
| `src/renderer/utils/formatUserFacingError.ts:16-22` | 渲染端按 `CODE:` / `CODE\|` 前缀解析错误码，并**丢弃**前缀后的自由文本（除非 i18n 用 `{{code}}` 插值），详见 §5.9 |

### 1.2 什么是「插件市场型」Skill 仓库

本需求针对的不是「一个仓库 = 一个 Skill」的简单形态（如 `guizang-social-card-skill`，根目录直接放 `SKILL.md`），而是**面向多个 AI 客户端分发、同时挂载多份插件清单**的仓库：

```
repo-root/
├── .agents/plugins/marketplace.json     # Codex 市场清单
├── .claude-plugin/                      # Claude Code 清单
│   ├── marketplace.json
│   └── plugin.json
├── .codex-plugin/plugin.json            # Codex 插件清单（含 "skills": "./skills/"）
├── .factory-plugin/                     # Factory 清单
├── skills/                              # ← 真实 Skill 容器
│   └── <skill-name>/
│       ├── SKILL.md
│       ├── references/
│       ├── scripts/
│       └── assets/
├── commands/                            # 客户端斜杠命令
└── prompts/                             # 客户端提示词模板
```

**特征：**
1. 根目录**没有** `SKILL.md`——根目录是「分发工程」，不是 Skill 本体
2. Skill 统一收在 `skills/` 容器下，与 `commands/`、`prompts/`、`docs/` 并列
3. 随仓库携带多份客户端专属清单（`.codex-plugin` / `.claude-plugin` / `.factory-plugin` …）
4. Skill 目录本体往往带 `references/`、`scripts/`、`assets/`，体积远大于单个 `SKILL.md`

这是当前 Skill 生态的**主流分发形态**（Anthropic 官方 `anthropics/skills`、`obra/superpowers`、`MiniMax-AI/skills`、`cathrynlavery/diagram-design` 均为该形态，见 §4）。SpaceAssistant 目前对这种形态**既不支持、也不解释**。

---

## 2. 问题定义

### 2.1 缺陷一：假阴性——仓库明明有 Skill，却报「未找到」

`resolveSkillSourceDirs()` 的查找深度只有两层：

```ts
// electron/skills/skillGithubInstall.ts:35（现状）
if (fs.existsSync(path.join(base, 'SKILL.md'))) return [base]        // 第 1 层：base 自身
if (installAll) {
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => path.join(base, ent.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'SKILL.md')))        // 第 2 层：直接子目录
  ...
}
throw new Error('SKILL_NOT_FOUND_IN_REPO: 目录下未找到可安装的 Skill')
```

对 §1.2 的目录结构：根目录无 `SKILL.md`（第 1 层落空），直接子目录是 `.agents/`、`.claude-plugin/`、`.codex-plugin/`、`.factory-plugin/`、`.github/`、`commands/`、`docs/`、`prompts/`、`scripts/`、`skills/`，**没有一个是 Skill 目录**（`skills/` 自己不含 `SKILL.md`，第 2 层落空）→ 抛错。

真实 Skill 位于 `skills/<name>/SKILL.md`，比当前实现期望的**深一层**。

用户在 UI 上看到的就是：

> 目录下未找到可安装的 Skill

而仓库里其实躺着完整的 Skill。用户无法自行判断这是「仓库不支持」还是「我们没找对地方」——文案没有给出任何线索。

### 2.2 缺陷二：假阳性——静默装错（比报错更危险）

当根目录下**恰好有一个**直接子目录含 `SKILL.md` 时，第 2 层会命中它并**只**返回它。`anthropics/skills` 正是这种情况：

- 根目录直接子目录：`.claude-plugin/`、`skills/`、`spec/`、`template/`
- 其中唯一含 `SKILL.md` 的是 **`template/`**（仓库自带的 Skill 模板骨架）
- 19 个真实 Skill 全部位于 `skills/<name>/`，深度 3，**全部漏掉**

结果是：探测返回「检测到 1 个 Skill」→ 用户点安装 → 装进来一个 `template` 骨架。**没有报错、没有警告**，用户很可能到用的时候才发现装错了东西。

这类缺陷的危害高于假阴性：假阴性至少是显式失败，假阳性是**静默的错误交付**。

### 2.3 缺陷三：候选放大后的「整仓不可用」（评审 B-1）

探测与安装都对发现结果做整体 `map(validateSkillSourceDir)`：

```ts
// 安装侧 electron/skills/skillGithubInstall.ts:228
const validated = sourceDirs.map((sourceDir) => ({ sourceDir, meta: validateSkillSourceDir(sourceDir).meta }))
// 探测侧 electron/skills/skillGithubInstall.ts:270-272
candidates: dirs.map((dir) => { const skill = validateSkillSourceDir(dir); ... })
```

**任一候选校验失败（`SKILL.md` 超 100 KB、front matter 非法、名称不合规）会抛错并炸掉整个探测 / 安装**，而不是淘汰该候选。

现状下候选量只有 1–2 个，该风险极低；本方案把候选量放大到 14–28 个量级后，**仓库里只要有一个坏 Skill 目录，用户对该仓库的探测与安装将整体失败，且错误指向单个 Skill、用户无法自救**。这会把缺陷一要修复的「假阴性」换成一种新的「整仓不可用」。

**同族问题：** `:229-231` 的同名冲突检查同样是整体语义——

```ts
const conflicts = validated.filter(({ meta }) => fs.existsSync(path.join(getUserSkillsDir(userDataPath), meta.name)))
if (conflicts.length > 0) throw new Error(`SKILL_NAME_CONFLICT: 用户级目录下已存在 Skill「${conflicts[0]!.meta.name}」`)
```

22 个候选里有 1 个名字已存在 → 其余 21 个全部装不上。且用户唯一的选择是「全部覆盖」（`overwrite=true`）或「全部放弃」，无法只装新的。

> **重要修正（相对 v1.0）：** v1.0 §3 曾论述「发现阶段可以宽松（多给候选），校验阶段自然会淘汰非法目录」——该论述**在现行代码上不成立**：现行代码里「淘汰」的实际语义是「整体抛错」。本版把该论述变为可实现的契约（§5.6、§5.7）。

### 2.4 实测证据

以下结果由**当前 `dist-electron` 编译产物**直接调用 `probeGithubSkillUrl()` 得到（2026-09-12）：

| 仓库 | 仓库内实际 SKILL.md 数量 | 当前探测结果 | 判定 |
|------|--------------------------|--------------|------|
| `cathrynlavery/diagram-design` | 1（`skills/diagram-design/SKILL.md`） | **FAIL** `SKILL_NOT_FOUND_IN_REPO` | 假阴性 |
| `MiniMax-AI/skills` | 23（最大深度 5） | **FAIL** `SKILL_NOT_FOUND_IN_REPO` | 假阴性 |
| `anthropics/skills` | 20 | **1 个候选：`template`** | **假阳性（静默装错）** |
| `obra/superpowers` | 14（`skills/<name>/`，深度 3） | 通过（推荐位已带 `subPath: 'skills'`） | 需显式子路径 |
| `anthropics/skills`（显式 URL） | 19（`skills/` 容器） | 需手写 `.../tree/main/skills` 才能绕过 | 依赖用户已知结构 |
| `cathrynlavery/diagram-design`（显式 URL） | 1 | 通过（`.../tree/main/skills/diagram-design`） | 依赖用户已知结构 |

> **关键结论：** 唯一「能用」的路径是**用户已经知道 Skill 埋在哪儿**，并手工把 `/tree/<branch>/<subPath>` 拼进 URL。这等于把仓库结构知识转嫁给了用户，与「粘贴仓库地址即可安装」的产品意图相悖。

### 2.5 影响面

| 维度 | 影响 |
|------|------|
| 可安装性 | 所有插件市场型仓库（当前 Skill 生态的主流形态）**无法通过根地址安装** |
| 正确性 | 特定结构下会**静默安装错误对象**（缺陷 B） |
| 鲁棒性 | 候选放大后，**单个坏候选或单个同名候选会阻断整仓**（缺陷三 / B-1） |
| 推荐位维护成本 | 每个推荐项都要人工确认并硬编码 `subPath`（`src/shared/recommendedSkills.ts`），新增推荐位必须先探仓库结构 |
| 首次体验 | 用户最自然的操作（复制仓库首页地址 → 粘贴 → 安装）在主流仓库上**直接失败** |
| 可解释性 | 失败文案不区分「仓库确实没有 Skill」与「我们没有找到」，无法自助排查 |

---

## 3. 现状机制拆解

端到端链路（`installSkillsFromGithub` 与 `probeGithubSkillUrl` 共用前四步）：

| 步骤 | 实现 | 本需求是否改动 |
|------|------|----------------|
| ① URL 解析 | `parseGithubSkillUrl`（:21） | 否（Q8） |
| ② 下载归档 | `downloadGithubArchive`（:77）— `codeload.github.com/<owner>/<repo>/tar.gz/<ref>`，`main` 失败回落 `master`，120s 超时，> 512 MB 中止 | 否 |
| ③ 校验 + 选择性解压 | `validateTarListing`（:162）→ `extractTarGz`（:172）→ `validateExtractedTree`（:145） | 否（Phase 1）；Phase 2 复用清单做预扫 |
| ④ **目录发现** | **`resolveSkillSourceDirs`（:35）** | **是（核心）** |
| ⑤ **逐候选校验** | **`validateSkillSourceDir`（探测 :270 / 安装 :228）** | **是（B-1：改为逐候选降级）** |
| ⑥ 同名冲突检查 | `skillGithubInstall.ts:229-231` | 是（B-1 同族：改为逐候选降级） |
| ⑦ 落盘 | `installSkillToUserDir` + 写入 `.skill-source.json` | 是（缺陷 A，仅元数据字段取值） |

**值得注意的实现事实（对方案选择有直接影响）：**

- **③ 的解压范围**：`buildGithubArchiveExtractMembers` 在**无** `subPath` 时返回 `[root]`，即**已经解压整棵仓库树**；有 `subPath` 时只解压该子树。因此「在整树内做有界 BFS」**不需要改动解压逻辑**，Phase 1 的**发现侧**改动面可以严格收敛在步骤 ④–⑥（B-3 另需改安装侧入参与 UI 链路，见 ⑤′ 与 §5.6、§5.11）。
- **② 已经产出完整文件清单**：`extractTarGz` 先跑 `tar -tvzf` 拿到全部成员的 verbose 清单并做安全校验，清单字符串已在内存中。这为 Phase 2 的「免解压预扫」提供了现成输入——但 Phase 1 不依赖它。
- **④ 与 ⑤ 的职责边界**：发现只负责「哪些目录是 Skill 根」，真正合法性由 `validateSkillSourceDir` 判定。因此发现阶段**应当宽松**（多给候选）——但这要求 ⑤ 必须是**逐候选降级**语义，而非现行的整体抛错语义（见 §2.3 与 §5.6）。这是 B-1 的根因。
- **⑦ 的契约事实**：`installSkillsFromGithub` 当前返回 `SkillDefinition[]`，**没有承载「哪些候选被跳过」的能力**；`probeGithubSkillUrl` 返回 `{ repo, candidates }` 同样没有截断位。两者都是 B-2 要扩展的契约点（见 §5.10）。
- **`GithubSkillCandidate.subPath` 已是相对仓库根的真实路径**（`probeGithubSkillUrl` 里 `path.relative(root, dir)`），所以 UI 安装时会把**精确子路径**回传，落到 `resolveSkillSourceDirs(root, subPath, false)` 的第 1 层命中分支——**已发现路径的安装链路本身是通的**，缺的只是「发现」这一步。
- **⑤′ UI 安装入口的调用形态（B-3 根因，v1.4 新增）**：`SkillsTab.tsx:229-242` 是**逐候选循环**——每个已选候选独立调用一次 `skillInstallFromUrl`，且因总是回传显式 `subPath`，`installAll` 恒为 `false`。也就是说 UI 主流程在 §5.6 的语义里**恰好落进「显式单目标整体抛错」的例外分支**：`invalid` / `name-conflict` 的逐候选降级在 UI 路径上永远不生效，只在「不探测、直接点安装」的 `installAll: true` 路径上生效；再叠加 `:237` 的 fail-fast 与「不传 `overwrite`」，`skipped` 与同名覆盖两条设计都失去落点。**因此本需求必须同时给出 UI 链路的行为契约**（v1.4 的处置：把批量语义下沉到 IPC，见 §5.6「安装模式划分」与 §11 Q12）。
- **⑤′ 连带现状缺陷（v1.4 新增）**：逐候选循环使候选量与下载次数成正比（14 个候选 ≈ 14 次归档下载 + 解压）；且候选列表未与 URL 绑定（改 URL 不清空候选，旧 `subPath` 会被用于新 URL，本需求候选量放大后必须一并修正，见 §5.11）。

---

## 4. 真实仓库结构调研

对四个代表性仓库用 GitHub Trees API 全量拉取，统计 `SKILL.md` 的分布（`<repo>/<path>` 的路径段数即层级数）：

| 仓库 | 仓库体积* | SKILL.md 层级分布 |
|------|-----------|-------------------|
| `anthropics/skills` | 4.59 MB | 层级 2 × 1（`template/SKILL.md`）；层级 3 × 19（`skills/<name>/SKILL.md`） |
| `obra/superpowers` | 4.69 MB | 层级 3 × 14（`skills/<name>/SKILL.md`） |
| `MiniMax-AI/skills` | 7.50 MB | 层级 3 × 22（`skills/<name>/SKILL.md`）；层级 4 × 1（`.claude/skills/pr-review/SKILL.md`）；层级 5 × 5（`plugins/pptx-plugin/skills/<name>/SKILL.md`） |
| `cathrynlavery/diagram-design` | 11.83 MB | 层级 3 × 1（`skills/diagram-design/SKILL.md`） |

\* GitHub API `size` 字段，含 `.git`；codeload 归档不含 `.git`，实际下载量更小。

**归纳出的三条经验规律：**

1. **容器 `skills/` 是强约定。** 四个仓库**全部**在根目录提供 `skills/`，真实 Skill 绝大多数是它的直接子目录（层级 3）。这是当前生态里最稳定的结构信号。
2. **层级 4 通常是客户端专属叠加层。** `MiniMax-AI/skills` 里层级 4 的唯一命中是 `.claude/skills/pr-review/SKILL.md`——这是该仓库面向 Claude Code 的**项目级 Skill**，与主 `skills/` 集合的定位不同。
3. **层级 5 出现在 `plugins/<plugin>/skills/` 形态。** 这是「仓库内再分层成多个插件」，属于插件作用域内的 Skill 集合，而非仓库主集合。

**由此形成的设计判断：**

- 只要**优先锚定 `skills/` 容器**，就能一次性覆盖四个仓库的**主体**（19 / 14 / 22 / 1 个 Skill），且天然排除 `template/` 这类根目录散落物（消除缺陷 B）。
- 深度上限不需要很大：**自搜索根起算 3 层**足以覆盖 `plugins/<plugin>/skills/<name>/`（层级 5 ⇒ 自仓库根 3 层）等已知形态。
- 忽略点目录是安全的：`.claude/`、`.codex/`、`.agents/`、`.github/` 等承载的是**清单与配置**，不是 Skill 内容。

---

## 5. 改进方案

### 5.1 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. 容器优先 + 有界 BFS** | 若 `base/skills/` 存在且有命中，只在该容器内做有界 BFS；否则回落到 `base` 的有界 BFS | 一次覆盖四个仓库主体；天然排除 `template/`（消除缺陷 B）；结果可预测、数量可控（1/14/19/22） | 主动放弃容器外的 Skill（`.claude/skills/*`、`plugins/<p>/skills/*`） | **推荐** |
| B. 纯有界 BFS（无容器优先） | 直接在 `base` 内做有界 BFS | 实现最简单；覆盖最全 | `anthropics/skills` 会把 `template` 当作候选一起列出（缺陷 B 只被「可见化」、未被消除）；`MiniMax-AI/skills` 一次给出 28 个候选，含 5 个插件作用域 Skill，选择负担大 | 备选 |
| C. 解析插件清单（`plugin.json` 的 `skills` 字段 / `marketplace.json`） | 读 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json` 等，按声明的 `skills` 路径定位 | 最「正统」，能精确还原作者意图 | 每客户端清单格式不一、字段可选（`anthropics/skills` 的 `.claude-plugin/marketplace.json` 只声明 `source: "./"`，不声明 skills）；依赖清单存在；实现面显著大于收益 | 不作为主路径；可作为 Phase 2 的**排序辅助信号** |

**推荐 A**，理由：它以最小的规则量命中「当前生态最稳定的结构信号」（`skills/` 容器），同时**顺带修掉缺陷 B**——这是纯 BFS 做不到的。

### 5.2 判定顺序（M-2 修正：容器预检结果即最终结果，不重复遍历）

```
discoverSkillDirs(root, subPath, installAll) -> DiscoveryResult
  ① base 不存在或不是目录        → SKILL_PATH_NOT_FOUND        （保持现状）
  ② base/SKILL.md 存在           → { dirs: [base], … }         （保持现状：精确命中）
  ③ installAll === false         → SKILL_NOT_FOUND_IN_REPO      （保持现状）
  ④ 若 isDir(base/skills):
       r = boundedBfs(base/skills)          ← 容器内 BFS，全局只跑这一次
       若 r.dirs.length > 0  → return r     ← 直接复用为结果，不再回落、不再重跑
  ⑤ r = boundedBfs(base, { exclude: [base/skills] })   ← 容器不存在 / 容器内 0 命中才走到这里
  ⑥ r.dirs 为空                  → SKILL_NOT_FOUND_IN_REPO
  ⑦ return r
```

**M-2 的明确契约（避免实现歧义）：**

- ④ 的 `boundedBfs(base/skills)` 是**唯一一次**容器内遍历，其返回值**直接作为最终结果**，⑤ 不得重跑。
- ⑤ 仅在「容器不存在」或「容器内 0 命中」时执行；执行时把容器目录加入 `exclude`，因为它已被证明不含 Skill，重复遍历无意义。
- 因此实现上只应存在**至多两次** `boundedBfs` 调用，且二者互斥（④ 命中则不发生 ⑤）。
- v1.0 中「预检 + 正式 BFS」的表述作废，统一为上述「一次调用 + 结果复用」。

**要点：**

- ②③ 保持原样，**单 Skill 仓库与显式子路径的行为完全不变**（向后兼容）。
- ④ 的「有命中 → 不回落」是 Q2 的决策落地，也是消除缺陷 B 的关键：`anthropics/skills` 一旦锚定 `skills/`，`template/` 自然不在候选内。
- ⑤ 的 `exclude` 是 M-2 引入的优化，不改变候选集合（容器内已确认为空），只消除重复遍历。

### 5.3 有界 BFS 与返回值结构（B-2 修正）

```ts
type DiscoveryResult = {
  dirs: string[]
  truncated: boolean          // true = 候选数达到 MAX_CANDIDATES 被截断
  visitedTruncated: boolean   // true = 目录访问数达到 MAX_VISITED_DIRS 被截断
}
```

```
常量：
  MAX_DISCOVERY_DEPTH = 3
  MAX_CANDIDATES      = 100
  MAX_VISITED_DIRS    = 2000

boundedBfs(searchRoot, { exclude = [] }) -> DiscoveryResult:
  dirs = []; truncated = false; visitedTruncated = false; visited = 0
  queue = [(searchRoot, 0)]; cursor = 0        // 用游标代替 shift()，见 S-3
  while cursor < queue.length:
    (dir, depth) = queue[cursor++]
    visited += 1
    if visited > MAX_VISITED_DIRS: visitedTruncated = true; break
    for child in 排序后的直接子目录(dir):        // 排序保证结果稳定可复现
      if child ∈ exclude: continue
      if 忽略目录(child): continue              // §5.4 R1
      if exists(child/SKILL.md):
        dirs.push(child)
        if dirs.length > MAX_CANDIDATES:        // ← B-2：发现第 N+1 个才置位
          dirs.pop(); truncated = true
          return { dirs, truncated, visitedTruncated }
        continue                                // §5.4 R2 命中即剪枝
      if depth + 1 < MAX_DISCOVERY_DEPTH:
        queue.push((child, depth + 1))
  return { dirs, truncated, visitedTruncated }
```

**B-2 的明确契约：**

- 截断判定**必须是「发现第 `MAX_CANDIDATES + 1` 个候选」才置位**，而不是「达到上限就返回」。这样「恰好 100 个且遍历自然结束」→ `truncated = false`；「超过 100 个」→ `truncated = true`。二者可区分。
- `MAX_VISITED_DIRS` 触顶同样置位 `visitedTruncated`，不静默 `break`。
- 两个标志都必须**一路传递到 UI**（`probe` → `appIpc` → `preload` → `api.ts` → `SkillsTab`，链路见 §5.10），否则 A12 无法验收。
- `dirs` 在返回前完成排序（见 §5.5）。

**深度语义**（务必按此对齐，避免实现歧义）：`MAX_DISCOVERY_DEPTH = 3` 表示从 `searchRoot` 向下最多进入 3 层目录，即 `searchRoot/a/b/c/SKILL.md` 是可达的最深形态。对照 §4：

| 形态 | 自 searchRoot 起算 | 是否覆盖 |
|------|--------------------|----------|
| `skills/<name>/SKILL.md`（searchRoot = `skills/`） | 1 层 | ✅ |
| `plugins/<plugin>/skills/<name>/SKILL.md`（searchRoot = 仓库根） | 3 层 | ✅ |
| 再深一层（如 `packages/x/skills/<name>/`） | 4 层 | ❌（按 §5.2 ④ 的出口，用户粘贴更深 URL） |

### 5.4 忽略目录与剪枝规则

**R1 忽略目录（不进入、不作为候选）：**

| 类别 | 目录名 |
|------|--------|
| 版本控制 / CI | `.git`、`.github`、`.gitlab`、`.gitea` |
| 客户端专属清单与配置 | `.agents`、`.claude`、`.codex`、`.cursor`、`.factory-plugin`、`.cursor-plugin`、`.devin-plugin`、`.kimi-plugin`、`.hermes-plugin`、`.opencode`、`.pi` |
| 依赖与构建产物 | `node_modules`、`vendor`、`dist`、`build`、`out`、`__pycache__`、`.venv`、`venv`、`target` |

> **通用规则：忽略所有以 `.` 开头的目录**，上表为显式列举（便于评审与测试断言）。理由：点目录承载的是清单/配置/元数据，不是 Skill 内容；且可避免同一 Skill 的客户端副本被当成多个候选。

**R2 命中即剪枝（Q5）：** 目录含 `SKILL.md` 后不再下探其子树。

理由有二：
1. **贴合语义**——Skill 目录的子树（`references/`、`scripts/`、`assets/`、`examples/`）属于该 Skill 的内部资源，不是独立 Skill。
2. **必要的防御**——Skill 目录的 `assets/` / `examples/` 里夹带示例或骨架 `SKILL.md` 的仓库并不少见（`anthropics/skills` 就在仓库根部提供 `template/SKILL.md` 作为骨架模板，见 §4）。不剪枝会把这些并非独立 Skill 的骨架/示例一并列成候选。

**R3 容器优先不回落（Q2）：** `skills/` 容器内有命中时，不再扫描容器外的其他目录。这是刻意取舍，出口见 §5.2 ④ 与 §11 Q2。

**R4 容器名大小写（S-2）：** 只匹配字面 `skills/`。在大小写不敏感的文件系统（Windows / macOS 默认）上 `existsSync('skills')` 对目录 `Skills/` 也会命中，在大小写敏感的 Linux 上不会——**跨平台行为不一致**。本需求按「字面 `skills/`，跟随宿主文件系统语义」处理，不做大小写归一化（归一化需 `readdir` 全量比对，收益低）。此为已知取舍，需在实现中保持一致并记录于代码注释。

### 5.5 排序与截断

**排序：** 层级升序 → 同层级按相对路径字典序。保证：
- 同一仓库多次探测结果**完全一致**（候选列表不抖动，用户勾选状态可预期）
- 主体 Skill（层级浅）排在插件作用域 Skill 之前

**截断（Q4 + B-2）：**
- `MAX_CANDIDATES = 100`：达到上限即停止并置 `truncated = true`（判定语义见 §5.3），**向 UI 传递标志**，不是静默丢弃
- `MAX_VISITED_DIRS = 2000`：BFS 时间兜底，置 `visitedTruncated = true`

**默认全选范围（Q7）：** 沿用「探测后默认全选」的交互（`SkillsTab.tsx:250`），但**只作用于 `status === 'ok'` 的候选**（§5.6）。`invalid` 候选不默认勾选且不可勾选；`name-conflict` 候选默认不勾选（勾选即表示要覆盖）。容器优先后候选量已收敛到 1–22 量级，全选符合「我想把这个仓库的 Skill 都装上」的主要意图。

---

### 5.6 候选校验降级策略（B-1 核心，新增）

**现状问题**（§2.3）：探测与安装对候选整体 `map(validateSkillSourceDir)`，任一失败即整体抛错。

**目标语义：** 发现阶段宽松、校验阶段**逐候选淘汰**——这要求校验从「整体抛错」改为「逐候选降级」。

**安装模式划分（B-3 修正，v1.4 核心补充）：** 降级语义必须按**调用形态**分别定义，否则会出现「设计的降级路径根本没有调用方」的空转（B-3 的实质问题）。

| 模式 | 入参形态 | 使用方 | 降级语义 |
|------|----------|--------|----------|
| **整仓安装** | `installAll: true`，无 `subPath` / `subPaths` | UI 未探测、直接点安装 | 批量降级（先发现全部候选，再逐候选校验） |
| **批量多选** | `subPaths: string[]`（长度 ≥ 1） | **UI 探测后勾选安装（主流程）** | **批量降级**：逐候选独立校验，聚合 `skipped` |
| **精确单目标** | `subPath: string`（显式单值）+ `installAll: false` | 推荐位、深链 URL、用户手写深地址 | **维持现状整体抛错**（A19 回归项） |

**模式判定优先级：** `subPaths` 非空 → 批量多选（忽略 `installAll`）；否则 `subPath` 非空 → 精确单目标；否则 `installAll === true` → 整仓安装；其余 → 与现状一致地抛 `SKILL_NOT_FOUND_IN_REPO`（`installAll` 视为 false）。

**批量多选的实现要点：**

- **不跑有界 BFS**：探测结果里的 `subPath` 已是相对仓库根的真实目录路径（§3），安装侧对每个 `subPath` 直接定位 `<extractedRepoRoot>/<subPath>` 并独立校验；定位失败计入该候选的 `skipped`（`SKILL_PATH_NOT_FOUND`），不中断其余候选。
- **单次下载 + 单次解压**：解压成员维持 `[root]`（与现状 `installAll` 路径一致，不改 Q8 的 `buildGithubArchiveExtractMembers` 行为）；这是本方案消除「N 个候选 = N 次下载」的关键。
- **入参安全校验**（新增 IPC 入参，不经过 `parseGithubSkillUrl`）：每个元素必须为非空、相对路径、不含 `..` 段、不含绝对路径/盘符；数组去重后长度 ≤ `MAX_CANDIDATES`。**不合法的请求整体拒绝**（抛 `SKILL_URL_INVALID`），不静默丢弃——客户端可控入参的静默丢弃会掩盖实现缺陷（见 §6）。
- `onProgress` 的 `total` 取**去重后**的候选数，`completed` 按实际处理数递增。

**设计：**

```ts
type CandidateStatus = 'ok' | 'invalid' | 'name-conflict'
type GithubSkillCandidate = {
  name: string
  description: string
  subPath: string
  totalBytes: number
  status: CandidateStatus
  reason?: string            // status !== 'ok' 时的原因（错误码 + 说明）
}
```

**探测侧（`probeGithubSkillUrl`）：**

- 对每个发现的目录调用 `validateSkillSourceDir`，**捕获异常**：
  - 成功 → `status: 'ok'`，填入 `name` / `description`
  - 失败 → `status: 'invalid'`，`name` 取目录名作为占位，`description` 留空，`reason` 为捕获到的错误消息（错误码 + 说明）
- **探测永不因单个候选非法而失败**；只有「发现 0 个候选」才抛 `SKILL_NOT_FOUND_IN_REPO`
- 若发现的候选**全部**为 `invalid`：探测仍正常返回（让用户看到「有 N 个目录但都不可用」及原因），由安装侧决定是否报错（见下）

**安装侧（`installSkillsFromGithub`）：**

- **只安装现算校验通过的候选**（`status === 'ok'`）。见下方 M-5 澄清：安装侧**不消费**探测返回的 `status`。
- `invalid` 候选计入 `skipped: SkippedCandidate[]`（`{ subPath, name?, reason }`），**不阻断其余候选**，不落盘
- **全部候选为 `invalid`** → 抛新增错误码 `SKILL_NO_INSTALLABLE_CANDIDATE`（见 §5.9）
- **全部候选为 `name-conflict`（`overwrite === false`）** → **不抛错**，返回 `ok: true` + `installed: []` + `skipped`，由 UI 给出提示与「覆盖同名并重装」入口（§5.7 零选择边角）。理由：这是用户在弹窗里「不勾选同名项」的**预期结果**，不是错误；用错误码表达会与 `SKILL_NAME_CONFLICT` 的语义重复且文案失真。
- 返回值扩展为 `{ installed: SkillDefinition[]; skipped: SkippedCandidate[]; overwritten: string[] }`（契约见 §5.10）。`overwritten` 为本次实际被覆盖（`fs.rmSync` 既有目录后重装）的 Skill 名称清单，供 UI 显式回执——覆盖不可逆，必须可回溯（§5.7）。
- **事务性保持**：`invalid` 候选不产生落盘，因此不影响既有的「失败回滚已落盘目标」逻辑（`:235-254`）；回滚仍按 `createdTargets` 执行

> **M-5 澄清（`status` 的归属）：** 安装侧**独立完成定位与校验**，`status` 是安装时**现算**结果；探测返回的 `status` / `reason` 只用于 UI 展示与勾选控制，**不作为安装请求的入参**（`subPaths` 只携带路径）。这样既消除「探测结果要不要随安装请求回传」的歧义，也让 M-6 的 TOCTOU 窗口由安装侧现算兜底。

**精确单目标路径例外（v1.4 重新界定）：**

- 当 `subPath` 非空、`subPaths` 为空且 `installAll === false`（推荐位 / 深链精确指向一个 Skill），**维持现状整体抛错**。
- 理由：此时用户明确指向单个对象，静默跳过会掩盖真正的失败；且该路径走 §5.2 ② 命中分支，本来就不涉及多候选。
- **v1.3 的表述缺陷（B-3）**：v1.3 写作「用户在 UI 上精确指向一个 Skill」，而 UI 主流程当时**恰好**用逐候选 `subPath` 调用，导致该例外覆盖了主流程。v1.4 把「UI 勾选安装」迁移到批量模式，此例外才真正只作用于推荐位/深链。

**与 v1.0 §3 论述的关系：** v1.0 称「校验阶段自然会淘汰非法目录」，本版将其落实为上述 `invalid` 语义，该论述自此成立。

### 5.7 同名冲突降级策略（B-1 同族问题，新增）

**现状问题**（§2.3 末）：`:229-231` 只要存在任一同名就整体抛 `SKILL_NAME_CONFLICT`，用户只能「全部覆盖」或「全部放弃」。

**设计：**

- `overwrite === false` 时，`status === 'ok'` 但用户级目录已存在同名 → 标记 `status: 'name-conflict'`，`reason` 为 `SKILL_NAME_CONFLICT`
- 该候选**不阻断**其余候选的安装，计入 `skipped`
- `overwrite === true` 时，同名候选正常覆盖（现状语义不变）
- **探测阶段即预判冲突**：`probeGithubSkillUrl` 需要拿到 `userDataPath`，在候选上直接给出 `name-conflict` 状态，让用户在点击安装前就看到「N 个同名将被跳过」（决策 Q11）。**M-6 澄清：探测状态仅为 UI 提示**——探测预判到用户点安装之间存在 TOCTOU 窗口（期间用户可能在别处装/删同名 Skill），**安装时一律以现算为准**；预判过期只会导致「勾了却被跳过」或「未勾却被覆盖」两种小概率偏差，前者由 `skipped` 如实呈现，后者由 `overwritten` 回执暴露（见下）
- **UI 出口**：跳过列表提供「覆盖同名并重装」按钮 → 以 `overwrite: true` 重跑一次安装（复用现有 `confirmOverwrite` 交互的位置，但不再依赖 `includes('已存在')` 字符串匹配，改用 `SKILL_NAME_CONFLICT` 错误码 / `name-conflict` 状态，见 §5.9）

**覆盖粒度（Q10 决策：方案 A）：**

- 采用「**默认不勾 + 一键全选覆盖**」，**不做逐个选择**。理由：`overwrite` 仍保持 `boolean` 语义，IPC 契约、回滚逻辑与测试成本不变档；逐个选择只为「本次只更新其中若干个」这一低频场景服务，而当前没有版本比对能力（不知道哪些变了），该场景本身难以成立。
- 两种主流意图由勾选状态即可表达：**只装新的**（默认，冲突的不勾）与**全部换成仓库版**（全选后覆盖重装）。

**批量链路上的 `overwrite` 传参规则（B-3 修正，v1.4 新增）：**

- **本次 `overwrite` = 所选候选中存在 `status === 'name-conflict'` 的候选。** 即「勾选同名候选」这一动作本身就表达「我要覆盖」，无需新增字段、也不必把 `overwrite` 升格为名单（Q10 边界不变）。
- 「一键全选覆盖」= 勾选全部 `name-conflict` 候选后按上一行规则发起**同一次**批量调用；UI 不再需要第二条安装代码路径。
- **TOCTOU 后果与可回溯性**（与 §5.6 的 M-5 澄清呼应）：若某候选探测时是 `ok`、安装时已变成同名，本次 `overwrite: true` 会顺带覆盖它。这是「覆盖」这一用户选择的合理外延（窗口小），但**必须可回溯**：安装结果返回 `overwritten: string[]`，UI 在有覆盖时显式提示「已覆盖 N 个：…」。

**两个必须处理的边角：**

| 边角 | 现象 | 处理 |
|------|------|------|
| **零选择** | 候选全部为 `name-conflict` 且默认不勾 → 点安装什么都不做；**且现行 `:233` 的 `[undefined]` 兜底会把这种情况变成 `installAll: true` 整仓安装（与用户意图完全相反）** | **探测后零勾选 ⇒ 不发起任何 IPC 调用**，直接提示（如「未勾选任何 Skill；全部 N 个均为同名，如需覆盖请全选后重试」），**严禁退化为 `installAll: true`**；探测摘要显示 `可安装 0 个 / 同名 N 个`。防御性：若仍收到「全部同名」的批量请求，安装侧返回 `ok: true` + `installed: []` + `skipped`（§5.6），由 UI 提示而非抛错 |
| **批量破坏** | `overwrite: true` 会 `fs.rmSync` 既有目录，一次覆盖 N 个是大范围破坏性操作 | 覆盖对象 **N > 1** 时弹出二次确认，明确列出「将覆盖 N 个已存在的 Skill」及名称清单；`N = 1` 时可沿用现有单条确认 |

**顺带修正（§5.9 详述）：** `electron/skills/skillInstall.ts:93` 抛的是裸文案「用户级目录下已存在 Skill「X」」，UI 侧靠 `res.error.includes('已存在')` 识别。该字符串匹配脆弱（文案一改即失效），本版一并改为错误码。

### 5.8 来源元数据修正（缺陷 A，M-4 论断收敛）

现状（`installSkillsFromGithub:238-248`）：无论发现出几个 Skill，**来源元数据里的 `subPath` 都写 URL 解析出来的那一个**：

```ts
subPath,                                   // ← 所有 Skill 共用同一个值
```

**问题：** 以 `subPath = 'skills'`、`installAll = true` 安装 `superpowers` 时，14 个 Skill 的 `.skill-source.json` **全部**记录 `subPath: "skills"`，而 `skills` 本身不是 Skill 目录（不含 `SKILL.md`）。

**修正：**

```ts
const resolvedSubPath = path.relative(extractedRepoRoot, sourceDir).split(path.sep).join('/')
// 元数据 subPath 用 resolvedSubPath；sourceUrl 末段也拼接 resolvedSubPath，保证链接直达
```

- **M-4 收敛后的影响论断（已核实）**：当前代码中 `SkillDefinition.source` 的**唯一活跃消费方**是 `src/renderer/components/Config/SkillsTab.tsx:424` —— 把 `source.sourceUrl` 渲染为「GitHub」外链。
  - 因此本缺陷**当前的实际表现**是：该链接指向仓库首页（`https://github.com/<owner>/<repo>`），而非该 Skill 所在目录——**是链接精度问题，不是功能失败**。
  - **目前不存在**「按来源重新安装」或「检查更新」的实现（已全仓检索确认：除上述外链外无其他 `source` 消费方）。
  - 除 `sourceUrl` 外，`subPath` 字段当前**无任何消费方**。
- **仍需在 Phase 1 修正的理由**（不夸大）：它是既有语义错误（记录的值与实际位置不符）；一旦未来实现「检查更新 / 重装」，错误值会直接导致定位失败；且修正成本仅为数行。**本需求不声称它当前会导致既有功能失败。**
- 单 Skill 精确安装场景下 `resolvedSubPath` 与原 `subPath` **取值相同**，无行为变化。

> v1.0 曾表述为「任何按来源重新安装 / 检查更新的消费逻辑都会失败或装错」，该论断在「消费方已存在」这一点上不成立，本版已按事实收敛。

### 5.9 错误码与文案（M-3 修正）

**M-3 的核心：主进程文案与渲染端 i18n 的分工必须说清。**

已核实（`src/renderer/utils/formatUserFacingError.ts:16-22` + `errorTranslator.ts`）：

```
主进程 throw new Error('<CODE>: <suffix>')
  → IPC 原样返回 error 字符串
  → 渲染端 formatUserFacingError() 按首个分隔符切分
  → 命中已知错误码 → translateError({ code, params: { code: <suffix> } })
                   → i18n.t('<CODE>', { ns: 'errors', code: <suffix> })
```

**由此得出三条确定结论：**

1. **用户可见文案只由 `errors.json` 决定**。主进程 `<suffix>` 里的中文**不会**被展示，除非 `errors.json` 的该条目使用 `{{code}}` 占位符把它插值进去。
2. **需要动态内容的文案，可以用 `{{code}}` 插值**——这是现成机制，无需新增字段。例如 `SKILL_NOT_FOUND_IN_REPO` 可写成 `"未在仓库中发现可安装的 Skill（{{code}}）"`，主进程抛出实际搜索范围作为 `<suffix>`。
3. **`<suffix>` 中不得出现 `|`**。`formatUserFacingError` 的 `const separator = pipe > 0 ? pipe : colon` 让 `|` **优先于** `:`，一旦 suffix 含 `|`，切分出的「错误码」就不是合法码，整条消息将**退化为不翻译的原始字符串**。当前 `skillGithubInstall.ts` 的文案不含 `|`，需在实现中保持。

**文案修订（M-3：不再断言「已检查 X 和 Y」，改为与容器优先语义一致的保守表述）：**

| 场景 | 现状 | 改进 |
|------|------|------|
| 发现 0 个候选 | `SKILL_NOT_FOUND_IN_REPO` → 「目录下未找到可安装的 Skill」 | `errors.json` 改为包含 `{{code}}` 的表述，如：「未在仓库中发现可安装的 Skill（{{code}}）」。主进程传入**实际搜索范围的客观描述**，例如「已查找：`skills/` 目录；未回落到仓库其他位置」或「已查找：仓库根目录下 3 层子目录」——**按实际执行路径生成，不做统一断言**（容器优先不回落时确实没查其他位置） |
| 候选全部非法 | 无 | **新增** `SKILL_NO_INSTALLABLE_CANDIDATE` → 「发现的 N 个 Skill 目录均无法安装」 |
| 候选被截断 | 无 | **新增提示级文案**（非错误码，走 `config.json` → `skills.*`），说明「结果已截断，仅显示前 100 个」 |
| `skillParser.ts:152` 的 100 KB 检查 | 裸文案「SKILL.md 文件体积超过 100 KB 限制」 | **改用已定义但未被抛出的** `SKILL_MD_TOO_LARGE`（`errorCodes.ts:37` 与 `errors.json` 均已存在，代码却抛裸文案） |
| `skillInstall.ts:93` 同名冲突 | 裸文案「用户级目录下已存在 Skill「X」」 | **改用** `SKILL_NAME_CONFLICT`，消除 UI 侧 `includes('已存在')` 字符串匹配 |
| 其余校验错误（`skillParser.ts:15/144/150/158/188` 等裸文案） | 无错误码 | 因 B-1 的 `reason` 需要展示给用户，**至少为会出现在 `skipped.reason` 中的分支补齐错误码**：缺少 front matter、缺少必填字段、名称不合法、描述为空、目录不含 `SKILL.md`、`SKILL.md` 不可读 |

**错误码总账：**

- **新增 1 个**：`SKILL_NO_INSTALLABLE_CANDIDATE`
- **补用 2 个**（已定义未使用）：`SKILL_MD_TOO_LARGE`、`SKILL_NAME_CONFLICT`
- **补齐若干**：`skillParser` 中会进入 `skipped.reason` 的裸文案分支

> v1.0 曾写「不新增错误码」，本版因 B-1 的降级策略需要显式区分「全部不可用」，改为新增 1 个。

**明确「不新增错误码」的两种情形（避免实现时误加，v1.4 补充）：**

- 「候选全部为 `name-conflict`」：返回 `ok: true` + `installed: []` + `skipped`，由 UI 文字提示（§5.7 零选择边角）。它是用户「不勾选同名项」的预期结果，用错误码表达会与 `SKILL_NAME_CONFLICT` 语义重复且文案失真。
- 「候选被截断」：提示级文案走 `config.json` → `skills.*`，不占错误码（Q4）。

### 5.10 接口契约变更清单（B-2、B-3 补齐）

| 位置 | 变更 |
|------|------|
| `electron/skills/skillGithubInstall.ts` | 新增 `DiscoveryResult`；`GithubSkillCandidate` 增加 `status` / `reason`；`probeGithubSkillUrl` 返回 `candidates`（含状态）+ `truncated` / `visitedTruncated`，并接收 `userDataPath`；**`installSkillsFromGithub` 的 `options` 增加 `subPaths?: string[]`（B-3），返回值由 `SkillDefinition[]` 改为 `{ installed, skipped, overwritten }`**；`resolveSkillSourceDirs` 由「返回 `string[]`」改为「返回 `DiscoveryResult`」（调用方同步） |
| `electron/skills/skillParser.ts` | 补齐错误码（§5.9）。`validateSkillSourceDir` 无需改签名（调用方用 try/catch 捕获） |
| `electron/skills/skillManager.ts` | `probeFromUrl` 由 `ctx` 取 `userDataPath` 传给探测（**保持对外签名不变**）；`installFromUrl` 的 `options` 增加 `subPaths`，返回值透传 `{ installed, skipped, overwritten }` |
| `electron/appIpc.ts` | `skill:probe-github-url`（:2061）返回类型补新字段；`skill:install-from-url`（**实际位于 :2165-2185**）**入参增加 `subPaths?: string[]`**、返回类型由 `{ ok, skills }` 改为 `{ ok, skills, skipped, overwritten }` |
| `electron/preload.ts` | `skillProbeFromUrl`（:158）、`skillInstallFromUrl`（:168）通道类型同步 —— **v1.0 遗漏** |
| `src/shared/api.ts` | `skillProbeFromUrl`（:411）补新字段；`skillInstallFromUrl`（:417）**入参补 `subPaths?: string[]`**、返回补 `skipped` / `overwritten` —— **v1.0 遗漏** |
| `src/shared/domainTypes.ts` | 把 `GithubSkillCandidate` / `CandidateStatus` / `SkippedCandidate` / `GithubInstallResult`（`{ installed, skipped, overwritten }`）提升为共享类型（主进程与渲染进程同源），避免多处内联类型各写一遍 |
| `src/shared/errorCodes.ts` | 新增 `SKILL_NO_INSTALLABLE_CANDIDATE` |
| `src/renderer/i18n/resources/{zh-CN,en-US}/errors.json` | 修订 `SKILL_NOT_FOUND_IN_REPO`（引入 `{{code}}`）；新增 `SKILL_NO_INSTALLABLE_CANDIDATE`；补齐 §5.9 的错误码条目 |
| `src/renderer/i18n/resources/{zh-CN,en-US}/config.json` | `skills.*` 新增截断提示、跳过原因展示、覆盖重装等文案 |
| `src/renderer/components/Config/SkillsTab.tsx` | `onInstallGithub` 由逐候选循环改为**单次批量调用 `subPaths`**；候选列表状态标签与相对路径、跳过/覆盖结果提示、覆盖重装入口、截断提示、候选与 URL 绑定（见 §5.11） |
| `src/renderer/utils/planGithubInstall.ts`（**新增**） | 抽出纯函数：`(input: { url; probedUrl; candidates; selectedPaths }) => { mode: 'batch' \| 'whole-repo'; subPaths?; overwrite } \| { mode: 'blocked'; reason: 'no-selection' \| 'stale-probe' }`。使 A21/A24 可在单测中判定（`SkillsTab` 现无测试文件） |

### 5.11 UI 影响

改动集中在 `SkillsTab.tsx` 的 GitHub 安装弹窗（交互 :368-377）+ 安装逻辑（:229-242，B-3 的主改造点）+ 安装结果提示：

| 项 | 现状 | 改进 |
|----|------|------|
| 候选列表 | `Checkbox.Group` + 名称 + 描述 | 补充**相对路径次级信息**（`c.subPath`，等宽字体、次要色）；新增**状态标签**：`ok` 可勾选、`invalid` 不可勾选（Tooltip 展示 `reason`）、`name-conflict` 默认不勾选并可勾选（表示要覆盖） |
| 全选行为 | 探测后默认全选 | 改为**只默认全选 `status === 'ok'`** 的候选（Q7） |
| 候选数量 | 「检测到 {{count}} 个 Skill」 | 保持；截断时改用新增的截断提示文案 |
| 探测结果概览 | 无 | 新增一行摘要：`可安装 N 个 / 不可用 X 个 / 同名 Y 个`，M>0 时提供原因展开入口（Q9：`invalid` 候选**保留在列表中**，置灰 + Tooltip 展示 `reason`，默认不勾且不可勾选） |
| 安装调用方式（**B-3 核心**） | `for (const subPath of paths) { await skillInstallFromUrl({ subPath, installAll: !subPath }) }`，**N 次下载 + 首错即 `return`**（`:229-242`） | 改为**单次批量调用** `skillInstallFromUrl({ sourceUrl, subPaths })`；结果不再 fail-fast，按 `{ installed, skipped, overwritten }` 聚合展示（§5.6） |
| `overwrite` 传参 | 弹窗路径**从不传**（永远 `false`） | 本次调用 `overwrite` = 所选候选中存在 `status === 'name-conflict'` 的候选；「一键全选覆盖」= 全选同名项后走同一规则（§5.7） |
| 零勾选拦截（Q10 边角） | `githubSelectedPaths.length === 0` → `[undefined]` ⇒ **`installAll: true` 整仓安装** | 探测后零勾选 ⇒ **不发起 IPC 调用**并提示（「未勾选任何 Skill…」）；**禁止 `[undefined]` 兜底**；未探测（候选为空）时才允许 `installAll: true` 整仓安装，且按钮需说明「将安装仓库中发现的全部 Skill」（§5.7） |
| 候选与 URL 绑定（**B-3 连带**） | 改 `githubUrl` 不清空候选，旧 `subPath` 会被用于新 URL | `githubUrl` 变化即清空 `githubCandidates` 与 `githubSelectedPaths`（或标记候选失效需重新探测）；安装请求以**探测时的 URL** 为准，二者不一致时拦截（`stale-probe`）。判据落在纯函数 `planGithubInstall` 中以便单测 |
| 安装结果 | 成功 toast | 存在 `skipped` 时补充提示与「覆盖同名并重装」入口（一键全选同名项 + 触发同一次批量调用，Q10）；`overwritten.length > 0` 时提示「已覆盖 N 个：…」；`installed` 为空且 `skipped` 全部为 `name-conflict` 时给 warning 而非成功 toast（§5.7） |
| 批量覆盖确认（Q10 边角） | 单条 `confirmOverwrite` | 覆盖对象 **N > 1** 时弹二次确认，列出将覆盖的 N 个名称清单（见 §5.7） |
| 安装进度 | `skillInstallOnProgress` 已显示 `completed/total` | 保持（候选变多时该进度更有价值） |

> 不改弹窗整体结构；安装按钮的 `disabled` 条件（`!githubUrl.trim()`）不变，零勾选提示在 `onInstallGithub` 内先行判定。

### 5.12 阶段划分

**Phase 1（本需求主线，独立可交付）**

1. `resolveSkillSourceDirs` → `discoverSkillDirs`：容器优先（含 §5.2 ④ 结果复用与 ⑤ exclude）+ 有界 BFS + 忽略目录 + 命中剪枝 + 排序/截断（含 `DiscoveryResult` 三字段）
2. **B-1**：逐候选校验降级（§5.6）+ 同名冲突降级（§5.7）
3. **B-2**：截断标志贯通探测 → IPC → UI（§5.3、§5.10）
4. **B-3**：`skill:install-from-url` 批量入参 `subPaths`（含入参安全校验）+ 返回 `{ installed, skipped, overwritten }`（§5.6）；UI 主流程改单次批量调用与三条链路契约（零勾选拦截、勾选同名 ⇒ `overwrite`、候选与 URL 绑定）（§5.7、§5.11）。该项**同时消除主流程的 N 次重复下载**
5. 缺陷 A：来源元数据写入实际相对路径（§5.8）
6. 错误码补齐与文案修订（§5.9）+ i18n 生成与校验
7. UI 改造（§5.11）
8. 单元测试（§9）——含主进程批量路径 fixture 与渲染端纯函数 `planGithubInstall` 的单测

**Phase 2（性能优化，可独立评估）**

1. **免解压预扫**：复用 `extractTarGz` 已产出的 `tar -tvzf` 清单，直接解析出所有 `*/SKILL.md` 路径 → 在**不落地解压**的前提下完成候选发现
2. **精准解压**：安装时只解压命中的 Skill 目录（复用现有 `buildGithubArchiveExtractMembers` 机制），`validateExtractedTree` 的整树 512 MB 约束随之只作用于被解压的子树
3. **S-1 探测结果缓存 / 归档复用**：现状「探测一次 → 确认安装 → 再下载解压一次」，候选放大后体感更明显。方案：按 `(owner, repo, ref)` 缓存归档或探测结果并设短 TTL，安装命中缓存时跳过重新下载。**注：B-3 已把「N 个候选 = N 次下载」收敛为 1 次，S-1 的收益收窄为「探测 → 安装」之间的第二次下载**（单仓库仍会下载两遍）
4. 可选：用 `plugin.json` / `marketplace.json` 的声明路径作为**候选排序的前置信号**（方案 C 的有限采纳）

> Phase 1 完成后，Phase 2 的收益主要是性能与体积鲁棒性，**不影响功能可用性**。S-3（队列游标替代 `shift()`）已在 §5.3 伪代码中直接落地，不单列阶段。

---

## 6. 边界与安全

| 项 | 处理 |
|----|------|
| 路径越界 | `parseGithubSkillUrl` 已拒绝含 `..` 的 `subPath`；BFS 结果全部来自 `fs` 遍历的**真实子目录**，且 `validateExtractedTree` 已做 realpath 逃逸校验；落盘前 `installSkillToUserDir` 再经 `assertInsideDir` 与 `NAME_PATTERN` 双重约束 |
| 符号链接 | `validateTarListing` 已在解压前拒绝归档中的符号链接与硬链接，BFS 不会遇到链接目录 |
| 候选爆炸 | `MAX_CANDIDATES` + `MAX_VISITED_DIRS` 双上限；触顶截断并提示（Q4、B-2） |
| **`subPaths` 入参校验（B-3 新增 IPC 入参）** | `subPaths` **不经过 `parseGithubSkillUrl`**，因此安装侧必须独立校验：元素非空、相对路径、无 `..` 段、无绝对路径/盘符、去重后长度 ≤ `MAX_CANDIDATES`；**不合法的请求整体拒绝**（`SKILL_URL_INVALID`），不做静默丢弃。落盘前仍经 `assertInsideDir` + `NAME_PATTERN` 双重约束；`subPaths` 与 `subPath` 同时传入时以 `subPaths` 为准并记录一条告警日志（不静默） |
| **非法候选** | 逐候选降级（B-1）：`invalid` 候选不落盘、不阻断其余候选；全部不可用才报 `SKILL_NO_INSTALLABLE_CANDIDATE` |
| **同名候选** | 逐候选降级（B-1）：`name-conflict` 不落盘、不阻断；覆盖需用户显式选择 `overwrite: true` |
| 部分失败回滚 | 保持现状：按 `createdTargets` 回滚本次已落盘目标；`invalid` / `name-conflict` 候选不产生落盘，天然不参与回滚 |
| 恶意仓库 | 发现阶段只读目录结构、不执行任何仓库内代码；Skill 合法性仍由 `validateSkillSourceDir` 判定（`SKILL.md` ≤ 100 KB、目录 ≤ 512 MB、front matter 合法、名称合规） |
| 探测耗时 | BFS 为纯 `readdir` 遍历，上限内可忽略；主要耗时仍是归档下载与解压（Phase 2 优化目标） |
| 安装耗时（B-3） | 批量模式下候选数与下载/解压次数**解耦**：无论勾选几个候选均为 1 次下载 + 1 次解压（改造前为 N 次，见 §1.1） |
| 隐私 | 不引入任何新的网络请求；仍只访问 `codeload.github.com` |

**安全上没有任何放松**：本需求只改变「哪些目录被识别为 Skill 根」与「失败的粒度」，所有既有的体积、路径、front matter 校验**逐条保留**。

---

## 7. 兼容性

| 场景 | 影响 |
|------|------|
| 单 Skill 仓库（根 `SKILL.md`，如 `guizang-social-card-skill`） | **无变化**（§5.2 ② 先行命中） |
| 推荐位的显式 `subPath`（如 `MiniMax-AI/skills/tree/main/skills/pptx-generator`） | **无变化**（② 命中） |
| 推荐位的容器 `subPath: 'skills'`（`obra/superpowers`） | 行为等价：原为「直接子目录」，新为「容器内有界 BFS」，14 个结果集相同；仅**来源元数据**被修正（§5.8，属修复） |
| **显式 `subPath` 精确安装遇非法候选** | **无变化**：仍整体抛错（§5.6 的例外分支，回归项 A19） |
| `installAll` 路径遇非法/同名候选 | **行为变更**：由「整体失败」改为「跳过 + 提示 + 其余照装」（B-1，这是本需求期望的行为改进） |
| `skill:install-from-url` 入参（B-3） | **兼容扩展**：新增 `subPaths?: string[]`；`subPath` / `installAll` 的语义不变（推荐位仍走 `subPath`，A19 不受影响）。二者同时传入时以 `subPaths` 为准并留痕（§6） |
| GitHub 弹窗的安装链路（B-3） | **行为变更**：由「N 次逐候选调用 + 首错中断 + 零勾选兜底整仓」改为「1 次批量调用 + 逐候选降级 + 零勾选拦截 + 候选与 URL 绑定」。其中「零勾选兜底整仓」属**缺陷修复**（原行为与用户意图相反） |
| UI 主流程的下载次数（B-3） | **行为变更（改进）**：14 个候选由 14 次仓库下载/解压降为 1 次 |
| `probeGithubSkillUrl` / `installSkillsFromGithub` 返回结构 | **破坏性变更**（新增字段）→ 必须同步 `appIpc` / `preload` / `api.ts`（§5.10）。仓内为唯一调用方，无外部消费者 |
| 用户已安装 Skill 的 `.skill-source.json` | 历史数据保留原值，**不做迁移**；新安装使用修正后的值 |
| `parseGithubSkillUrl` / `buildGithubArchiveExtractMembers` 契约（Q8） | **不变**，既有单测（`skillGithubInstall.test.ts`）应全部保持通过 |
| `resolveSkillSourceDirs` 签名 | **变更**：返回 `string[]` → `DiscoveryResult`。该函数已被导出并在单测中直接使用（`skillGithubInstall.test.ts`），单测需同步修正；仓内无其他调用方 |
| 现有 `.space-skills/` 与 `<userData>/skills/` 布局 | 不变 |

---

## 8. 验收标准

| # | 验收项 | 判定方式 |
|---|--------|----------|
| A1 | 粘贴 `https://github.com/cathrynlavery/diagram-design`（根地址）→ 探测返回 **1** 个候选 `diagram-design`（`subPath = skills/diagram-design`），可成功安装 | 手工 + 单测 |
| A2 | 粘贴 `https://github.com/obra/superpowers`（根地址）→ 探测返回 **14** 个候选，与推荐位 `subPath: 'skills'` 的结果集**完全一致** | 单测（用 fixture 目录树） |
| A3 | **缺陷 B 回归**：`anthropics/skills` 结构（`template/SKILL.md` + `skills/<19>`）→ 探测结果**不含** `template`，仅含 19 个 `skills/*` | 单测（必须） |
| A4 | `MiniMax-AI/skills` 结构 → 探测返回 **22** 个候选（`skills/*`），不含 `.claude/skills/*` 与 `plugins/pptx-plugin/skills/*` | 单测（必须） |
| A5 | 单 Skill 仓库（根 `SKILL.md`）→ 行为与现状**逐位一致** | 单测 |
| A6 | 显式 `subPath` 直达 Skill 目录 → 行为与现状一致 | 单测 |
| A7 | **缺陷 A 回归**：一次安装 14 个 Skill 后，各自 `.skill-source.json` 的 `subPath` 为**各自的相对路径**（如 `skills/brainstorming`），且 `sourceUrl` 直达该目录 | 单测（必须） |
| A8 | 忽略目录生效：`.claude/skills/x/SKILL.md`、`node_modules/y/SKILL.md` 不被发现 | 单测 |
| A9 | 剪枝生效：Skill 内 `assets/example-skill/SKILL.md` 不被发现，且结果中不出现嵌套候选 | 单测 |
| A10 | 深度上限：`searchRoot/a/b/c/d/SKILL.md`（4 层）不被发现；3 层内被发现 | 单测 |
| A11 | 排序稳定：同一目录树多次探测结果顺序**完全一致** | 单测（连续两次比较） |
| **A12a** | **（B-2 重写 / M-7 拆分）** 截断判定：候选**恰好 100 个** → `truncated === false`；候选 **101 个** → 返回 100 个且 `truncated === true`；`MAX_VISITED_DIRS` 触顶 → `visitedTruncated === true` | 单测 |
| **A12b** | **（M-7 拆分）** 标志贯通：单测断言 `probeGithubSkillUrl` 返回值含两个标志且 `appIpc` 原样透传（不丢字段）；**手工**验收 UI 截断提示文案可见 | 单测（透传）+ 手工（UI 提示） |
| A13 | 无 Skill 的仓库 → 仍报 `SKILL_NOT_FOUND_IN_REPO`，**文案为新版**，且包含**与实际执行路径一致**的搜索范围描述（容器优先不回落时不得声称检查了仓库其他位置） | 单测 + 手工 |
| A14 | `npm exec vitest run electron/skills/skillGithubInstall.test.ts` 全绿；`npm run i18n:check` 通过 | CI / 本地 |
| **A15** | **（B-1）** 候选中混入 1 个非法 `SKILL.md`（如 front matter 非法）→ 探测返回该候选 `status: 'invalid'` 且带 `reason`，**探测整体不失败**；其余候选 `status: 'ok'` | 单测（必须） |
| **A16** | **（B-1）** 上条场景下执行安装 → 仅安装 `ok` 候选；`invalid` 候选进入 `skipped` 且**不落盘**；安装整体成功并提示跳过原因。**批量路径（`subPaths`）同样成立**，且不再 fail-fast（B-3） | 单测（必须） |
| **A17** | **（B-1）** 候选**全部非法** → 探测正常返回（全部 `invalid`）；安装抛 `SKILL_NO_INSTALLABLE_CANDIDATE`，文案可读 | 单测（必须） |
| **A18** | **（B-1 + B-3 重写）** 批量路径下候选中有 1 个同名：`installSkillsFromGithub({ subPaths })` 返回 `installed` 含其余候选、`skipped` 含该同名候选（`SKILL_NAME_CONFLICT`）且**其余候选不受影响**（不再 fail-fast）；**勾选该同名候选时**本次调用 `overwrite === true`（由纯函数 `planGithubInstall` 判定），安装后全部装成且 `overwritten` 含被覆盖的 Skill 名称 | 单测 + 手工 |
| **A19** | **（B-1 回归）** 显式 `subPath` 精确安装遇非法候选 → **仍整体抛错**，行为与现状一致 | 单测（必须） |
| **A20** | **（M-2）** 容器内有命中时，容器外目录**不被遍历**（以注入的 `fs.readdirSync` 计数/spy 断言调用范围） | 单测 |
| **A21** | **（Q10 边角 + B-3 重写）** 候选**全部同名**且默认均未勾选 → `planGithubInstall` 返回 `{ mode: 'blocked', reason: 'no-selection' }`，**不发起 IPC 调用**且给出明确提示（不得静默无响应，**也不得退化为 `installAll: true` 整仓安装**）；探测摘要显示 `可安装 0 个 / 同名 N 个`。防御性：强行发起「全部同名」的批量请求时，安装侧返回 `ok: true` + `installed: []` + `skipped`，而非抛错 | 单测（纯函数 + 主进程防御分支）+ 手工 |
| **A22** | **（Q10 边角）** 覆盖对象 **N > 1** → 弹出二次确认并列出 N 个名称清单；`N = 1` → 沿用单条确认 | 单测 + 手工 |
| **A23** | **（B-3 安全）** `subPaths` 入参校验：含 `..`、绝对路径/盘符、空串、超长数组的请求**整体被拒绝**（抛错，不静默丢弃）；重复项只处理一次 | 单测（必须） |
| **A24** | **（B-3 边界）** 候选与 URL 绑定：修改 `githubUrl` 后候选失效，`planGithubInstall` 在候选来源 URL 与当前 URL 不一致时返回 `{ mode: 'blocked', reason: 'stale-probe' }`；UI 不得把旧 `subPath` 用于新 URL | 单测 + 手工 |

---

## 9. 测试用例设计

**测试策略：** 主要用 `mkTmpDir()` 构造本地目录树驱动 `resolveSkillSourceDirs` / `discoverSkillDirs`，**不发网络请求**（沿用现有 `skillGithubInstall.test.ts` 的纯函数测试风格）。真实仓库的端到端验证放在手工验收（§8 A1–A4 已给出精确期望值）。

> **既有单测需同步**：`resolveSkillSourceDirs` 返回值由 `string[]` 变为 `DiscoveryResult`，现有 3 个断言（`resolves single skill directory`、`resolves all skill directories when installAll is true`、`uses coded errors when a requested repository path is missing`）需改为读 `.dirs`。

> **既有单测的其余影响面（v1.4 核实）**：`skillGithubInstall.test.ts` 对 `installSkillsFromGithub` 只有一处「不支持的主机名应抛错」断言（`:58-60`，在返回前即抛错），因此返回值由 `SkillDefinition[]` 改为 `{ installed, skipped, overwritten }` **不会**破坏既有断言；`installSkillsFromGithub` 的批量行为由新增 fixture 覆盖（§9 fixture 表）。

**需要新增的 fixture 目录树：**

| fixture | 结构 | 断言 |
|---------|------|------|
| `plugin-marketplace` | `.codex-plugin/`、`.claude-plugin/`、`commands/`、`docs/` + `skills/alpha/SKILL.md`、`skills/beta/SKILL.md` | 返回 `[skills/alpha, skills/beta]` |
| `nested-template`（缺陷 B） | `template/SKILL.md` + `skills/` × 19 | 返回 19 个，**不含** `template` |
| `plugins-scope` | `skills/a/SKILL.md` + `.claude/skills/b/SKILL.md` + `plugins/p/skills/c/SKILL.md` | 返回 `[skills/a]`（容器优先 + 忽略点目录） |
| `no-container` | `group/one/SKILL.md`、`group/two/SKILL.md`（无 `skills/`） | 返回 2 个（回落 BFS 生效） |
| `prune` | `skills/a/SKILL.md` + `skills/a/assets/example/SKILL.md` | 返回 1 个 |
| `depth-bound` | `a/b/c/SKILL.md`（3 层）+ `a/b/c/d/SKILL.md`（4 层） | 只返回 3 层那个 |
| `ignored` | `node_modules/x/SKILL.md`、`.github/y/SKILL.md` | 返回空 → 抛 `SKILL_NOT_FOUND_IN_REPO` |
| `empty-container` | `skills/README.md`（无 SKILL.md）+ `other/SKILL.md` | 返回 `[other]`（容器空 → 回落，覆盖 §5.2 ④→⑤ 分支） |
| `single-root` | `SKILL.md` | 返回 `[base]`（回归 A5） |
| `stable-order` | 多层多候选 | 连续两次调用结果数组**全等** |
| **`mixed-invalid`（B-1）** | `skills/alpha/SKILL.md`（合法）+ `skills/broken/SKILL.md`（front matter 非法）+ `skills/oversize/SKILL.md`（> 100 KB） | 探测：1 个 `ok` + 2 个 `invalid`（各带 `reason`）；安装：只落盘 `alpha`，`skipped` 长度 2 |
| **`all-invalid`（B-1）** | 容器非空但所有 `SKILL.md` 均非法 | 探测正常返回全部 `invalid`；安装抛 `SKILL_NO_INSTALLABLE_CANDIDATE` |
| **`name-conflict`（B-1）** | `skills/alpha/SKILL.md`（合法，与 userData 中已有同名）+ `skills/beta/SKILL.md`（合法） | `overwrite=false`：`alpha` 为 `name-conflict`，`beta` 正常装；`overwrite=true`：两者均装 |
| **`all-name-conflict`（Q10 边角）** | 容器内**全部**候选均与 userData 同名 | 探测：全部 `name-conflict` 且默认不勾；摘要显示 `可安装 0 个 / 同名 N 个`；安装：给出零选择提示而非静默无响应（对应 A21） |
| **`exact-cap` / `over-cap`（B-2）** | 恰好 100 个候选 / 101 个候选 | 前者 `truncated === false`；后者 100 个且 `truncated === true` |
| **`container-not-rewalked`（M-2）** | 容器有命中 + 容器外另有候选 | 断言容器外候选**不在结果中**，且容器外目录**未被 `readdir`**（spy 计数，对应 A20） |
| **`uppercase-skillmd`（S-4）** | `skills/a/skill.md`（小写文件名） | 不命中（`SKILL.md` 大小写敏感契约）；`Skills/` 容器行为按宿主 FS 语义记录 |
| **`batch-subpaths`（B-3）** | 容器内 3 个合法候选 + 1 个同名候选 + 1 个非法候选，且注入 `downloadGithubArchive` spy | 1 次 `installSkillsFromGithub({ subPaths })` 完成：**下载/解压各只发生 1 次**；`installed` 含合法项、`skipped` 含同名与非法项；`overwrite: true` 时 `overwritten` 含被覆盖名称 |
| **`batch-subpaths-unsafe`（B-3）** | `subPaths` 分别含 `../x`、`/abs`、`''`、重复项、长度 > `MAX_CANDIDATES` | 非法形态**整体抛错**（`SKILL_URL_INVALID`，不静默丢弃）；重复项去重后只处理一次；`subPath` 与 `subPaths` 同时传入 → 以 `subPaths` 为准并留痕 |
| **`batch-partial-path`（B-3）** | `subPaths` 含一个在解压树中**不存在**的路径 | 该候选计入 `skipped`（`SKILL_PATH_NOT_FOUND`），**不中断**其余候选（对应 A18 的「不再 fail-fast」） |

**渲染端纯函数单测（新增，B-3/M-7）：**

> `SkillsTab` 目前**没有测试文件**（`rg -l SkillsTab --glob '*.test.ts*'` 为空），因此 A21/A24 若按「点 UI 按钮」判定则只能手工。为让这两项可自动验收，把「勾选状态 → 安装请求」的判定抽为纯函数 `src/renderer/utils/planGithubInstall.ts`（签名见 §5.10），由 `renderer` 项目（jsdom）的纯函数单测覆盖：

| 场景 | 断言 |
|------|------|
| 候选为空 + 有 URL（未探测） | `{ mode: 'whole-repo' }` |
| 探测后有勾选、全为 `ok` | `{ mode: 'batch', subPaths, overwrite: false }` |
| 勾选含 `name-conflict` 候选 | `overwrite === true`（A18） |
| 探测后零勾选 | `{ mode: 'blocked', reason: 'no-selection' }`（A21；**不得**回落为 `whole-repo`） |
| 候选来源 URL ≠ 当前 URL | `{ mode: 'blocked', reason: 'stale-probe' }`（A24） |

**边界回归（AGENTS.md 要求「带状态/外部耦合逻辑需专门边界测试」）：**

- 目录名含空格 / 中文 / 大小写混合时的排序与命中
- `skills/` 存在但为**文件**而非目录（应走回落，不崩溃）
- 极深目录树（> 20 层）不导致栈溢出或超时（BFS + `MAX_VISITED_DIRS` 兜底）
- `visitedTruncated` 置位路径可达
- `subPath` 指向不存在的目录 → 仍抛 `SKILL_PATH_NOT_FOUND`（回归既有单测）
- `skipped.reason` 全部为可识别错误码（保证 i18n 可翻译）——断言 reason 前缀 ∈ `ErrorCodes`
- **批量路径的 `subPaths` 与 `installAll` 组合**：`subPaths: []`（空数组）→ 按 `installAll` 语义处理，**不得**当成「零候选批量」静默成功（B-3 新增边界）
- **`overwritten` 只包含本次真正被覆盖的目标**：`overwrite: true` 但目标不存在时不得出现在 `overwritten` 中（B-3/M-6）

---

## 10. 相关文件

**主进程：**
- `electron/skills/skillGithubInstall.ts` — 核心改动（发现、降级、元数据、契约）
- `electron/skills/skillGithubInstall.test.ts` — 既有断言改 `.dirs` + 新增 fixture
- `electron/skills/skillParser.ts` — 补齐错误码（§5.9）
- `electron/skills/skillInstall.ts` — 同名冲突改用 `SKILL_NAME_CONFLICT`
- `electron/skills/skillManager.ts` — `probeFromUrl` / `installFromUrl` 透传新契约
- `electron/appIpc.ts` — `skill:probe-github-url` 返回类型；`skill:install-from-url` 入参新增 `subPaths` 与返回类型
- **`electron/preload.ts`** — 两个通道的类型同步（**v1.0 遗漏**）

**共享：**
- **`src/shared/api.ts`** — 两个 `window.api` 方法的内联类型（**v1.0 遗漏**）
- `src/shared/domainTypes.ts` — 提升 `GithubSkillCandidate` / `SkippedCandidate` / `GithubInstallResult` 等为共享类型
- `src/shared/errorCodes.ts` — 新增 `SKILL_NO_INSTALLABLE_CANDIDATE`
- `src/shared/recommendedSkills.ts` — 不改；本需求落地后，新增推荐位**不再需要人工确认 `subPath`**（可只给根地址）

**渲染进程：**
- `src/renderer/components/Config/SkillsTab.tsx` — 安装入口改单次批量调用；候选状态、相对路径、跳过/覆盖提示、覆盖重装、截断提示、候选与 URL 绑定
- **`src/renderer/utils/planGithubInstall.ts`（新增）** — 「勾选状态 → 安装请求」的纯函数（使 A18/A21/A24 可单测）
- **`src/renderer/utils/planGithubInstall.test.ts`（新增）** — 上述纯函数单测（jsdom 项目，见 §9）
- `src/renderer/utils/formatUserFacingError.ts` — 只读依赖（§5.9 的映射机制），不改
- `src/renderer/i18n/resources/{zh-CN,en-US}/errors.json` — 错误码文案
- `src/renderer/i18n/resources/{zh-CN,en-US}/config.json` — `skills.*` 文案
- `src/renderer/i18n/types.ts` — 由 `npm run i18n:generate-types` 生成

---

## 11. 决策记录（Q1–Q12）

**本表为单一编号权威（Q1–Q12），§0.1 与本表一致（M-1 修正）。Q1–Q12 已全部闭环：Q1/Q2 于 v1.3、Q9–Q11 于 v1.2、Q12 于 v1.4 定稿，其余自 v1.0 起有效。**

| # | 问题 | 建议 | 状态 / 说明 |
|---|------|------|-------------|
| Q1 | `MAX_DISCOVERY_DEPTH` 取值 | **3 层** | **已定（2026-09-12）**。自搜索根起算 3 层，覆盖已知最深形态（`plugins/<plugin>/skills/<name>/`，见 §4 实测）；4 层以上要求用户粘贴深层目录地址。取舍：该值决定「覆盖度 vs 候选噪音」，3 层为当前生态实测最大深度 |
| Q2 | 容器优先是否**严格不回落** | **是（严格不回落）** | **已定（2026-09-12）**。本需求最关键的取舍：严格模式才能消除缺陷 B（排除 `anthropics/skills` 的 `template/` 骨架）；宽松模式（容器内外都收）会让该仓库重新出现 20 个候选。代价：容器外的 Skill（`.claude/skills/*`、`plugins/<p>/skills/*`）不可从根地址自动发现，出口是粘贴深层目录 URL（§5.2 ④、§5.4 R3） |
| Q3 | 是否忽略所有点目录 | **是** | 代价是 `MiniMax-AI/skills` 的 `.claude/skills/pr-review` 不可自动发现（可粘贴深地址安装）。若需覆盖，可改为「除 `.claude`/`.codex` 外忽略」，但会引入客户端副本重复候选 |
| Q4 | `MAX_CANDIDATES` / `MAX_VISITED_DIRS` 取值 | **100 / 2000** | 现有生态最大候选量 22，余量充足；截断提示形态见 §5.11 |
| Q5 | 是否采用「命中即剪枝」 | **是** | 避免把 Skill 内部 `assets/` / `examples/` 里的示例 `SKILL.md` 当成独立候选（§5.4 R2） |
| Q6 | 是否在 Phase 1 一并修正缺陷 A | **是** | 修正成本极小（数行）。M-4 已收敛论断：当前无活跃消费方，但值语义错误，且会阻断未来更新检查（§5.8） |
| Q7 | 候选默认全选的范围 | **只默认全选 `status === 'ok'` 的候选** | `invalid` 不可勾选；`name-conflict` 默认不勾选（勾选即表示要覆盖）。容器优先后候选量收敛至 1–22（§5.5、§5.11） |
| Q8 | 是否改动 URL 解析与选择性解压行为 | **不改** | `parseGithubSkillUrl` 语义与 `buildGithubArchiveExtractMembers` 行为保持不变，降低改动面（§7） |
| Q9 | **（B-1）候选校验失败的降级边界** | **方案 A：`invalid` 候选保留在探测结果中并展示原因** | **已定（2026-09-12）**。理由：本需求的主旨是消除「静默」（缺陷 B 即静默装错），若在此处隐藏非法候选，等于制造「静默少装」，与主旨冲突；极端情形（如 22 个候选里 21 个非法）下隐藏会让用户完全无法察觉仓库有问题。代价仅为 UI 增加一个置灰状态与原因文案，可折叠呈现（§5.6、§5.11） |
| Q10 | **（B-1）同名冲突的降级方式** | **方案 A：默认不勾 + 一键全选覆盖，不做逐个选择** | **已定（2026-09-12）**。理由：两种主流意图（「只装新的」/「全部换成仓库版」）由勾选状态即可表达；逐个选择只为「本次只更新其中若干个」服务，而当前无版本比对能力，该场景难以成立，却要把 `overwrite` 从 `boolean` 升格为名单，连带 IPC 契约、回滚与测试成本上一档。配套两个边角：零选择提示、N > 1 覆盖二次确认（§5.7、§5.11）。**v1.4 补充（B-3）：`overwrite` 保持「本次调用级布尔」，批量链路上的取值规则为「所选候选中存在 `name-conflict` 者 ⇒ `true`」，覆盖对象由安装侧现算并经 `overwritten` 回执，因此仍无需名单** |
| Q11 | **（B-2）探测是否接收 `userDataPath` 以预判同名** | **方案 A：接收** | **已定（2026-09-12）**。理由一：不接收则**勾选与结果不一致**——用户勾了 22 个只装 19 个，无法理解；接收后冲突项默认不勾，「勾了 = 明确要覆盖」。理由二：省一次往返——否则覆盖需走「安装 → 提示同名 → 覆盖重装」，整仓（各仓库 4–12 MB）要再下载解压一遍。实现上由 `skillManager` 从 `ctx` 注入，**不改变对外 IPC 签名**；后续若为探测加缓存（S-1），需在安装/删除技能时使缓存失效 |
| Q12 | **（B-3）UI 主流程的安装入口用哪种形态** | **方案乙：IPC 支持 `subPaths: string[]` 批量，UI 主流程单次调用** | **已定（2026-09-12）**。理由一：§5.6/§5.7 的逐候选降级只有在批量路径上才有落点——UI 若维持逐候选 `subPath` 调用，恰好落进「显式单目标整体抛错」的例外分支，`skipped` 永不生效（A18 不可达成）。理由二：逐候选循环 = N 次仓库下载 + 解压（14 个候选 ≈ 14 次），本需求把候选量从 1–2 放大到 14–22 后不可接受，批量可一次性消除与 S-1 协同。理由三：保留 `subPath` 精确安装路径，推荐位行为与 A19 回归项不受影响，改动面收敛为「新增入参 + 其贯通」。**方案甲被否决**（保留逐候选循环 + 仅补 UI 契约）：它仍需改 UI 的 fail-fast 与零勾选兜底，却无法消除 N 次下载，且 `skipped` 语义继续只活在 `installAll` 路径上。配套契约：零勾选拦截、勾选同名 ⇒ 本次 `overwrite: true`、候选与 URL 绑定（§5.7、§5.11） |

---

## 12. 评审意见处理对照

| 评审项 | 级别 | 处理 | 落点 |
|--------|------|------|------|
| B-1 候选校验失败策略缺失 | 阻断 | 已闭环：新增逐候选降级策略与同名冲突降级策略；补验收 A15–A19、fixture 3 组；同时修正 v1.0 §3 的错误论述 | §2.3、§5.6、§5.7、§8、§9 |
| B-2 截断标志与接口契约缺失 | 阻断 | 已闭环：定义 `DiscoveryResult`；截断判定改为「发现第 N+1 个」；补 `preload.ts` / `api.ts`（并追加 `appIpc.ts` / `domainTypes.ts`）；A12 重写 | §5.3、§5.5、§5.10、§8 A12、§10 |
| B-3 降级/覆盖语义只覆盖 `installAll` 批量路径，UI 主流程（逐候选循环）契约脱节 | 阻断（v1.3 评审） | 已闭环：核实并写明 UI 逐候选循环 + fail-fast + 不传 `overwrite` + 零勾选兜底整仓的现状事实；`skill:install-from-url` 新增批量入参 `subPaths`（单次下载解压 + 批量降级 + `overwritten` 回执）；UI 改单次批量调用并补齐零勾选拦截、勾选同名 ⇒ `overwrite`、候选与 URL 绑定三条契约；A18/A21 按 UI 链路重写，新增 A23/A24、批量 fixture 3 组与纯函数 `planGithubInstall` 单测 | §0、§1.1、§3、§5.6、§5.7、§5.10、§5.11、§5.12、§6、§7、§8、§9、§11 Q12 |
| M-1 决策编号错位 | 必须 | 已修正：§0.1 与 §11 统一为同一套 Q1–Q12，§11 为唯一权威 | §0.1、§11 |
| M-2 容器内 BFS 跑两遍 | 必须 | 已修正：明确「④ 的返回值即最终结果，⑤ 不得重跑」+ ⑤ 加 `exclude`；新增 A20 与 spy 断言 | §5.2、§5.3、§8 A20、§9 |
| M-3 错误文案与 i18n 分工 | 必须 | 已修正：核实并写明 `formatUserFacingError` 的映射机制、`{{code}}` 插值用法、`\|` 分隔符陷阱；文案改为按实际路径生成；补错误码总账 | §5.9 |
| M-4 缺陷 A 论断夸大 | 必须 | 已修正：核实唯一消费方是 `SkillsTab.tsx:424` 的外链，明确「当前无活跃消费方」，改写论断并显式声明不声称既有功能失败 | §5.8 |
| M-5 §5.6 的 `status === 'ok'` 措辞在逐候选路径下有歧义 | 必须（v1.3 评审） | 已修正：明确「安装侧独立完成定位与校验，`status` 为安装时现算；探测的 `status`/`reason` 仅用于 UI 展示与勾选控制，不作为安装请求入参」 | §5.6 |
| M-6 探测预判同名与安装时刻存在 TOCTOU 窗口 | 必须（v1.3 评审） | 已修正：明确探测状态仅为 UI 提示、安装以现算为准；并新增 `overwritten` 回执，使「顺带覆盖」可回溯可见 | §5.6、§5.7、§5.10 |
| M-7 A12「经 IPC 到达 UI」缺少可执行判定步骤 | 必须（v1.3 评审） | 已修正：拆为 A12a（单测：截断判定）与 A12b（单测断言 `appIpc` 透传 + 手工验收 UI 提示） | §8 A12a/A12b |
| S-1 探测→安装重复下载 | 建议 | 已纳入 Phase 2 第 3 项 | §5.12 |
| S-2 容器名大小写 | 建议 | 已以 R4 明确取舍 | §5.4 R4 |
| S-3 BFS 队列 `shift()` 为 O(n) | 建议 | 已在伪代码中改为游标 | §5.3 |
| S-4 补充 fixture | 建议 | 已补 `all-invalid`、`uppercase-skillmd`，并扩为 3 组 B-1 fixture | §9 |

---

*本文档为需求细化草案，评审通过后再拆解为技术设计与实施计划。与 [skills-requirement.md](./skills-requirement.md)、[skill-management-ui-requirement.md](./skill-management-ui-requirement.md)、[skill-install-size-limit-and-cloud-install-requirement.md](./skill-install-size-limit-and-cloud-install-requirement.md) 冲突时，以评审通过后的新版本为准。*
