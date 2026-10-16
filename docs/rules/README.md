# docs/rules 目录：读哪一篇

> **本文件是"元方法的目录"** —— 列出本层有哪些元方法，并按任务指向应读的那一篇；**只做索引与导向，不承载任何规则**。规则在各篇正文；依据、口径与维护信息在各篇的 `-sources.md`。
> **三层**：`docs/rules/` = **元方法**（某类具有通用性的问题怎么做）｜[`document-writing-guide.md`](document-writing-guide.md) = **元方法的元方法**（这类方法本身怎么写）｜本文件 = **元方法的目录**。
> **用法**：找到你的任务 → 读对应那篇（整篇加载）。`-sources.md` 只在审计或修订规则时读。

| 你的任务 | 读这篇（定位与涵盖内容） | 何时再读它的 `-sources.md` |
|---|---|---|
| 写 / 改指南或长期规范文档（含新增专题指南） | [`document-writing-guide.md`](document-writing-guide.md)：**元指南**——归属判据、动作导向写法、一条规则只在一处定义、加载层次与路由、迁移与修订记录 | 修订判据、追溯判据来源 |
| 整理 / 搬迁 / 归档 `docs/` 文档 | [`docs-guide.md`](docs-guide.md)：主题结构、归属判定 A/B/C/D、`history.md` 规范、模板集、执行流程、质量门禁、反模式清单 | —（该篇自带质量门禁与模板集） |
| 写需求 / 需求基线 | [`requirement-writing-guide.md`](requirement-writing-guide.md)：**人机协同**、价值先行、交互取值引用、范围与开放决策、验收与指标口径 | 追溯需求侧判据的评审来源 |
| 设计交互行为（确认、打断、默认值、设置开关）；做界面改动 | [`interaction-design-guide.md`](interaction-design-guide.md)：行为层判据 I1–I7 + **核心工具 `$impeccable` 的两个检查点** | 追溯交互判据来源；查看未覆盖主题待办 |
| 写技术方案（规格、验收、迁移、回滚） | [`technical-plan-writing-guide.md`](technical-plan-writing-guide.md)：读者分层（**人只审决策，机器审规格**）、写作流程与门禁、人类决策层规则 R1–R6、规格层要求 | 追溯方案侧判据与试点记录 |
| 写执行计划（任务拆解、顺序与依赖、进度标记） | [`execution-plan-writing-guide.md`](execution-plan-writing-guide.md)：单向真源、任务粒度、顺序与依赖（含门禁可执行性）、任务登记与完成判据、状态标记规范 | 追溯计划侧判据与"实际执行观察"的来源 |

**加载层次**（定义见元指南 §4.1）：入口层 = `AGENTS.md` 的一行指引 + **本文件（元方法目录）**；任务层 = 上表选中的那一篇（整篇加载）；场景层 = 篇内路由句标出的可选小节；证据层 = 各 `-sources.md`（按需）。

**不在本表的内容**：组件 / 图标 / 样式约定 → `AGENTS.md`「UI 规范」；文档库的目录结构、归档与 `history.md` 规范 → `docs-guide.md`；`docs/rules/` 的文件清单与用途分类 → `docs-guide` §9.1；**`docs/rules/archive/`**（已归档件，不作为正式指南，仅供追溯，不参与路由）。

**已落地（2026-10-16）**：技术方案指南按 v2 拆分为"技术方案 / 执行计划"两篇并列（上表两行）；两篇之间**互不路由**，依据分别落在各自的 `-sources.md`。
