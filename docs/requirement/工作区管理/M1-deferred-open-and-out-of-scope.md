# M1 后置能力、待决议题与明确不做

> **状态**：产品讨论定稿（非 M1 交付范围）  
> **M1 必做范围**：[v1-workspace-management-requirement.md](./v1-workspace-management-requirement.md) §1.1（R1–R7）  
> **说明**：本文档保留「M1 不做但已讨论过」的内容，避免合并 PRD 时丢失。

---

## 1. 三类边界

| 类型 | 含义 | 本文档章节 |
|------|------|------------|
| **M1 必做** | R1–R7，随 V1 一次发布 | → V1 主 PRD |
| **后置（Post-M1）** | 已拍板方向，下一版或独立排期 | §2 |
| **待决（Open）** | 讨论过但未闭合，不阻塞 M1 | §3 |
| **明确不做** | 产品拒绝，非「以后再做」 | §4 |
| **独立项目** | 另开 PRD，不与 M1 捆绑 | §5 |

---

## 2. 后置能力（Post-M1）

以下 **不影响 M1 开工**；实现时以独立版本/议题跟踪。

| ID | 议题 | 产品方向（摘要） | 备注 |
|----|------|------------------|------|
| D1 | **升格迁移向导** | 用户主动把某**子文件夹**升格为新 Profile：新建 Profile → 文件系统迁移 → 旧方向留壳或 README 指向；**会话/记忆不自动跟随**（仍绑原 `workDirProfileId`） | 与 P1「默认不自动升格」配套；M1 仅支持手动新建 Profile + 手动拷文件 |
| D2 | **搜索 / 会话列表展示常用子路径** | 在会话列表或搜索结果显示 focus 或最近使用的项目子路径，便于找回上下文 | 非 M1；focus 本身为 M1 |
| D3 | **用户自定义布局模板** | `{workDir}/.spaceassistant/templates/` 或应用内导入；T10 首期 **仅内置** | 见 T10 / P11 |
| D4 | **自动整理散落文件** | Agent 或向导辅助：把 workDir 根下散落文件建议迁入某项目 bucket | M1 以 **F6 Hook + F5 项目归因** 为主；D4 后置 |
| D5 | **设置页「在总仓下新建方向」便捷项** | O1 总仓不落库；后置可在设置提供「在 `{上次向导总仓}` 下新建」（需另存用户偏好或最近父路径） | 与 O1 配套 |
| D6 | **模板物理名向导内预览可改** | 创建 Profile/项目时预览 `layout.json` 物理名并单项编辑后再落盘 | M1 可简化为仅 i18n 默认名；「可改」为体验增强 |
| D7 | **方向级 shared / scratch 目录扩展** | 部分讨论稿含 `共享/`、`临时/` 等于方向模板根；M1 以各方向内置模板为准，是否全部方向统一后置对齐 | 以 M1 内置模板验收为准 |
| D8 | **SPACEASSISTANT.md 目录约定自动生成** | 模板应用时写入 Agent 可读的目录约定段落 | M1 可选；未写入 R1–R6 硬必做 |

---

## 3. 待决议题（Open，不阻塞 M1）

AI 成长定名后仍 **未单独闭合** 的产品题（讨论中有方案，未写入 R1–R6）：

| ID | 议题 | 选项 / 说明 |
|----|------|-------------|
| U1 | **跨区 / 复盘会话入口** | **U1** 左侧「复盘」入口；**U2** 自然语言触发（倾向）；**U3** 新建会话时选「本工作台 / 跨工作台」 |
| U2 | **是否必须切 AI 成长 Profile 才做跨区写** | PRD §8.2 已默认：创作区拒绝跨 Profile 写，仅 G5 提示 |
| U3 | **`sessionKind: insight` 等会话类型** | 普通会话 + Profile=AI成长 是否足够 — **未决** |
| U4 | **聚合读 API 工具名与 schema** | PRD §8.3 暂定 `query_workspace_digest`；细节进技术设计 |
| U5 | **聚合读索引策略** | PRD 默认 mtime 扫描 |
| U6 | **focus 工具** | PRD 默认提供 `set_session_focus`；IPC 进技术设计 |
| U7 | **当前项目条** | PRD §6.5 已定：Select 下拉 + 清除；无效 focus 文案；无新建项目 |

---

## 4. 明确不做（非后置）

| ID | 结论 |
|----|------|
| X1 | **项目实体**（DB 层 Project 表）；项目 = 文件夹 + 会话 focus |
| X2 | **子文件夹自动升格为 Profile** |
| X3 | **文件树默认只显示 focus 子树**（M1 为 **整树** + 可选 focus 高亮） |
| X4 | **文件树节点「设为当前项目」** |
| X5 | **当前项目条上的「新建项目」** |
| X6 | **跨方向借用项目模板** |
| X7 | **M1 安装向导 / 老用户专用 layout 升级 Banner**（O7：早期无老用户升级分支） |
| X8 | **向导内 Git init** |
| X9 | **AI 成长 Profile 删除** |
| X10 | **扩大 `read_file` 沙箱实现跨 Profile 全文读取**（用聚合读 API 代替） |

---

## 5. 独立项目（非工作区 M1 后置）

| 项目 | 文档 | 与 M1 关系 |
|------|------|------------|
| Git 版本管理 | [v6-git-local-version-control-requirement.md](./v6-git-local-version-control-requirement.md) 起 | **分开发布**，不捆绑 M1 |
| 升格后会话迁移策略 | 若未来做 D1，可能另议 | 当前：会话不随文件夹迁移 |

---

## 6. 升格（D1 前置说明，M1 仅规则不设向导）

M1 已定的**规则**（实施时文案/帮助体现即可）：

1. 事情默认 = workDir 下**子文件夹**，不新建 Profile。  
2. 用户认为某事足够大 → **主动**新建 Profile + 将子目录**文件级**迁到新 path。  
3. **历史会话**仍关联原 Profile；升格后新 Profile 为新会话上下文。  
4. 产品 **不提供** M1 一键升格；D1 后置做向导时可辅助拷贝与 checklist。

---

## 7. 文档维护说明

- 原 `docs/analysis/workdir-management-product-plan.md`（v1.13）、`workdir-layout-templates-product-plan.md`（v1.11）在合并 PRD 时 **正文被替换为索引 stub**，未进 git 历史。  
- **M1 必做细节**：见 [v1-workspace-management-m1-detail.md](./v1-workspace-management-m1-detail.md)（从原 V2–V5 PRD 恢复）。  
- **讨论归档摘要**：见 [workdir-management-product-plan.md](../../analysis/workdir-management-product-plan.md)。
