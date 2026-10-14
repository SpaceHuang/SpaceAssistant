# desktop-ui —— 桌面交互与工作区

> 定位：聊天界面与渲染性能、composer、上下文占用、多会话、文件面板/查看器、工作目录、设置与托盘。
> 主要代码域：`src/renderer/components/`、`src/renderer/services/`、`src/renderer/store/`、`electron/workDir*.ts`、`electron/sessionDirectoryGrants.ts`
> 核对基线：`main` `17236274`（2026-10-14）

## 现状与设计文档（留主题目录）

| 文档 | 类型 | 说明 |
| --- | --- | --- |
| [multi-workdir-technical-design.md](./multi-workdir-technical-design.md) | 技术设计（v1.0） | 多工作目录 |
| [explicit-output-directory-candidate-technical-design.md](./explicit-output-directory-candidate-technical-design.md) | 候选技术设计 | 显式产出目录（现行「工作产物管理」口径） |
| [chat-vision-image-context-design.md](./chat-vision-image-context-design.md) | 设计（v1.2） | 聊天视觉上下文（图片附件 → 多模态 API） |
| [chat-vision-history-full-hydrate-design.md](./chat-vision-history-full-hydrate-design.md) | 设计（v1.0） | 视觉历史全量回填 |

## 在途（in-flight）

**（本次核验后为空）** —— 全部移入 `../archive/desktop-ui/`（共 21 件）。

> **2026-10-14 两轮核验更正（原判 C 有误）**：
> `chat-markdown-math-delimiter-misfire-diagnosis-and-improvement-plan.md`（`src/shared/markdownMathNormalize.ts`）、`scheduled-task-workdir-model-development-plan.md`（`automation-write-deny` 策略 + butler `modelOverride`/`workDirProfileId`）、`streaming-ui-performance-analysis.md`（2026-05-24 `feat: …流式 UI 性能优化…`）。

## 归档（20 件）

见 [`../archive/desktop-ui/`](../archive/desktop-ui/)：

| 组 | 说明 |
| --- | --- |
| 聊天列表渲染性能 | `chat-message-list-renderer-performance-audit.md`、`chat-message-list-renderer-performance-optimization-design.md`（v1.6，第一/二批已落地）、`chat-message-list-batch1/2-remeasure-gate.md` 与 `-results.json`（复测门禁与结果） |
| 流式与取消 | `chat-message-list-streaming-jitter-fix-plan.md`（J-01~J-04 已实施）、`chat-abort-latency-verification-and-fix-plan.md` |
| composer | `composer-model-thinking-entry-development-plan.md`、`composer-model-thinking-entry-acceptance-evidence.md`、`composer-plus-menu-development-plan.md` |
| 卡顿与多会话 | `会话新建删除卡顿诊断与修改计划.md`、`渲染进程卡顿优化方案.md`（v3.25）、`multi-session-parallel-execution.md`（阶段 1–3 已落地） |
| 上下文占用 | `context-usage-accuracy-issues.md`、`context-usage-realtime-improvement-design.md` |
| 队列任务栏 | `2026-09-30-queued-task-bar-implementation-plan.md` |
| 已废弃 | `plan_mode_optimization_design.md`（D：头部与结尾状态自相矛盾，按代码判定为废弃，见 `remove-plan-mode-requirement.md`） |

## 相关需求口径

见 [`../../requirement/desktop-ui/`](../../requirement/desktop-ui/)（35 件归档 + 2 件在途）。

## 取证命令

```text
git log --date=short --format='%ad %h %s' -- src/renderer/components src/renderer/services src/renderer/store
git log --date=short --format='%ad %h %s' --grep='perf' -30
```
